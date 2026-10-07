#!/usr/bin/env bash
#
# One read-only pass over Cumulo's CloudWatch state, as the observer identity
# of infra/bootstrap/observer.tf (#604). The procedure around it is
# .claude/skills/incident-watch/SKILL.md.
#
# It refuses to run as any identity but `user/cumulo-observer-<env>`, so a
# session holding broader credentials cannot reach AWS through it; that
# identity's policy is what makes "never writes to AWS" true, and
# incident-watch.test.sh asserts every call this script makes is a read.
#
# Usage: bash .claude/scripts/incident-watch.sh [--history N]
#   AWS_PROFILE   the observer's CLI profile (default cumulo-observer)
#   CUMULO_ENV    the environment watched (default dev)
# Exit:  0 nothing firing, 1 something to act on, 2 no verdict reached.
set -uo pipefail
export PATH="$PATH:/opt/homebrew/bin"

profile="${AWS_PROFILE:-cumulo-observer}"
env_name="${CUMULO_ENV:-dev}"
history_count=10

while [ $# -gt 0 ]; do
  case "$1" in
    --history)
      history_count="${2-}"
      shift
      ;;
    -h | --help)
      sed -n '2,15p' "$0"
      exit 0
      ;;
    *)
      printf 'incident-watch: unknown argument %s\n' "$1" >&2
      exit 2
      ;;
  esac
  shift
done

case "$history_count" in
  '' | *[!0-9]*)
    printf 'incident-watch: --history takes a whole number\n' >&2
    exit 2
    ;;
esac

for tool in aws jq; do
  command -v "$tool" >/dev/null 2>&1 || {
    printf 'incident-watch: %s is not on PATH\n' "$tool" >&2
    exit 2
  }
done

# Environment keys outrank AWS_PROFILE in the CLI's credential chain; dropping
# them, and naming the profile on every call, keeps the observer the only
# identity this script can present.
unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN AWS_PROFILE

# Prints the call's JSON, or reports the failure and exits 2. It runs inside
# $(...), so every caller ends `|| exit 2` to carry that exit out.
observe() {
  local result
  if ! result=$(aws --profile "$profile" --output json "$@" 2>&1); then
    printf 'incident-watch: aws %s %s failed — no verdict:\n%s\n' "$1" "$2" "$result" >&2
    exit 2
  fi
  printf '%s' "$result"
}

raw=$(observe sts get-caller-identity) || exit 2
caller=$(jq -r '.Arn // ""' <<<"$raw")
expected_user="user/cumulo-observer-${env_name}"
if [ "${caller#arn:aws:iam::*:}" != "$expected_user" ]; then
  printf 'incident-watch: profile %s is %s, not %s — refusing to run as anything but the observer\n' \
    "$profile" "${caller##*:}" "$expected_user" >&2
  exit 2
fi

now=$(date -u +%s)
hour_ago=$((now - 3600))
verdict=0

printf 'incident-watch %s — env %s, %s\n' \
  "$(date -u +%Y-%m-%dT%H:%MZ)" "$env_name" "$expected_user"

raw=$(observe cloudwatch describe-alarms --alarm-name-prefix cumulo- --state-value ALARM) || exit 2
firing=$(jq -r '(.MetricAlarms + .CompositeAlarms)[] | [.AlarmName, .StateUpdatedTimestamp, .StateReason] | @tsv' <<<"$raw")

printf '\nIN ALARM\n'
if [ -z "$firing" ]; then
  printf '  none\n'
else
  verdict=1
  while IFS=$'\t' read -r name since reason; do
    printf '  %s since %s\n    %s\n' "$name" "$since" "$reason"
  done <<<"$firing"
fi

printf '\nLAST %s TRANSITIONS\n' "$history_count"
raw=$(observe cloudwatch describe-alarm-history --history-item-type StateUpdate --max-records 100 --no-paginate) || exit 2
jq -r --argjson n "$history_count" \
    '[.AlarmHistoryItems[] | select(.AlarmName | startswith("cumulo-"))][:$n][]
     | "  \(.Timestamp)  \(.AlarmName)  \(.HistorySummary)"' <<<"$raw"

# The 5xx alarm's own metric and dimensions, so the count reads exactly what
# the alarm reads and needs no API Gateway permission to find the API id.
api_alarm="cumulo-api-${env_name}-5xx"
raw=$(observe cloudwatch describe-alarms --alarm-names "$api_alarm") || exit 2
metric=$(jq -c '.MetricAlarms[0] // empty | {Namespace, MetricName, Dimensions}' <<<"$raw")
if [ -z "$metric" ]; then
  printf '\nincident-watch: alarm %s does not exist — is the api stack applied in this region?\n' "$api_alarm" >&2
  exit 2
fi
queries=$(jq -c '[{Id: "fivexx", MetricStat: {Metric: ., Period: 300, Stat: "Sum"}}]' <<<"$metric")
raw=$(observe cloudwatch get-metric-data --start-time "$hour_ago" --end-time "$now" \
  --metric-data-queries "$queries") || exit 2
count=$(jq '[.MetricDataResults[].Values[]] | add // 0 | floor' <<<"$raw")
case "$count" in
  '' | *[!0-9]*)
    printf 'incident-watch: get-metric-data returned no readable 5xx count — no verdict\n' >&2
    exit 2
    ;;
esac

printf '\nAPI 5XX, LAST HOUR\n  %s\n' "$count"
[ "$count" -eq 0 ] || verdict=1

log_lines() { # log_lines <service> <filter pattern>
  local group="/aws/lambda/cumulo-$1-${env_name}" events lines
  events=$(observe logs filter-log-events --log-group-name "$group" \
    --start-time "$((hour_ago * 1000))" --filter-pattern "$2" --max-items 5) || exit 2
  lines=$(jq -r '.events[] | "  \(.timestamp / 1000 | floor | todate)  \(.message | gsub("\\s+"; " ") | .[:300])"' <<<"$events")
  printf '\nLOG %s, LAST HOUR, %s\n%s\n' "$group" "$2" "${lines:-  no matching lines}"
}

# apiServerErrorEvent and apiRequestFailedEvent in apps/api/src/main.ts name
# the API's lines; the other two are Lambda's own runtime error and timeout.
if [ "$count" -gt 0 ] || grep -q "^cumulo-api-${env_name}-" <<<"$firing"; then
  log_lines api '?api_response_server_error ?"api.request.failed"'
fi
if grep -q "^cumulo-ingestion-${env_name}-" <<<"$firing"; then
  log_lines ingestion '?ERROR ?"Task timed out"'
fi
if grep -q -e "^cumulo-forecast-${env_name}-" -e "^cumulo-weather-readings-dlq-${env_name}-" <<<"$firing"; then
  log_lines forecast '?ERROR ?"Task timed out"'
fi

printf '\nVERDICT %s\n' "$([ "$verdict" -eq 0 ] && echo quiet || echo act)"
exit "$verdict"
