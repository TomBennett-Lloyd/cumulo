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
#   --history N   transitions printed (default 10)
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
      sed -n '2,16p' "$0"
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

stderr_file=$(mktemp "${TMPDIR:-/tmp}/incident-watch.XXXXXX") || exit 2
trap 'rm -f "$stderr_file"' EXIT INT TERM

# The report is quoted into public issues, so account ids leave it as a shape
# (infra/README.md convention 7).
ACCOUNT_ID='(^|[^0-9])[0-9]{12}([^0-9]|$)'
JQ_DEFS='def redact: gsub("(?<![0-9])[0-9]{12}(?![0-9])"; "<account-id>");
  def epoch: sub("\\.[0-9]+"; "") | sub("\\+00:00$"; "Z") | fromdateiso8601;'

no_verdict() {
  printf 'incident-watch: %s — no verdict\n' "$1" |
    sed -E "s/$ACCOUNT_ID/\\1<account-id>\\2/g; s/$ACCOUNT_ID/\\1<account-id>\\2/g" >&2
  exit 2
}

# Prints the call's JSON, or reports the failure and exits 2. Callers run it
# inside $(...), so each ends `|| exit 2` to carry that exit out.
observe() {
  local result
  if ! result=$(aws --profile "$profile" --output json "$@" 2>"$stderr_file"); then
    no_verdict "aws $1 $2 failed: $(cat "$stderr_file")"
  fi
  printf '%s' "$result"
}

# A response jq cannot read is no verdict, never a quiet report.
parse() { # parse <what> <filter> [jq option…]  — JSON on stdin
  local what="$1" filter="$2"
  shift 2
  jq -r "$@" "$JQ_DEFS $filter" 2>/dev/null || no_verdict "unreadable $what response"
}

raw=$(observe sts get-caller-identity) || exit 2
caller=$(parse identity '.Arn' <<<"$raw") || exit 2
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

raw=$(observe cloudwatch describe-alarms --alarm-name-prefix cumulo- --state-value ALARM \
  --alarm-types MetricAlarm CompositeAlarm) || exit 2
firing=$(parse describe-alarms \
  '((.MetricAlarms // error("no MetricAlarms")) + (.CompositeAlarms // []))[] | [.AlarmName, .StateUpdatedTimestamp, (.StateReason | redact)] | @tsv' \
  <<<"$raw") || exit 2

printf '\nIN ALARM\n'
if [ -z "$firing" ]; then
  printf '  none\n'
else
  verdict=1
  while IFS=$'\t' read -r name since reason; do
    printf '  %s since %s\n    %s\n' "$name" "$since" "$reason"
  done <<<"$firing"
fi

raw=$(observe cloudwatch describe-alarm-history --history-item-type StateUpdate \
  --alarm-types MetricAlarm CompositeAlarm --max-records 100 --no-paginate) || exit 2
transitions=$(parse describe-alarm-history \
  '[.AlarmHistoryItems[] | select(.AlarmName | startswith("cumulo-"))]' -c <<<"$raw") || exit 2

printf '\nLAST %s TRANSITIONS\n' "$history_count"
HISTORY_COUNT="$history_count" parse describe-alarm-history \
  '.[:(env.HISTORY_COUNT | tonumber)][] | "  \(.Timestamp)  \(.AlarmName)  \(.HistorySummary | redact)"' \
  <<<"$transitions" || exit 2

# An alarm that went to ALARM and back inside the hour is not in IN ALARM, and
# is the flapping shape #604 was opened for.
raised=$(SINCE="$hour_ago" parse describe-alarm-history \
  '[.[] | select((.HistorySummary | endswith(" to ALARM")) and (.Timestamp | epoch) >= (env.SINCE | tonumber)) | .AlarmName] | unique[]' \
  <<<"$transitions") || exit 2
printf '\nRAISED IN THE LAST HOUR\n%s\n' "$(printf '%s' "${raised:-none}" | sed 's/^/  /')"
[ -z "$raised" ] || verdict=1

# The 5xx alarm's own metric and dimensions, so the count reads exactly what
# the alarm reads and needs no API Gateway permission to find the API id.
api_alarm="cumulo-api-${env_name}-5xx"
raw=$(observe cloudwatch describe-alarms --alarm-names "$api_alarm") || exit 2
metric=$(parse describe-alarms '.MetricAlarms[0] // empty | {Namespace, MetricName, Dimensions}' -c <<<"$raw") || exit 2
[ -n "$metric" ] || no_verdict "alarm $api_alarm does not exist — is the api stack applied in this region?"
queries=$(parse alarm '[{Id: "fivexx", MetricStat: {Metric: ., Period: 300, Stat: "Sum"}}]' -c <<<"$metric") || exit 2
raw=$(observe cloudwatch get-metric-data --start-time "$hour_ago" --end-time "$now" \
  --metric-data-queries "$queries") || exit 2
count=$(parse get-metric-data '[.MetricDataResults[].Values[]] | add // 0 | floor' <<<"$raw") || exit 2
case "$count" in
  '' | *[!0-9]*) no_verdict "get-metric-data returned no whole 5xx count" ;;
esac

printf '\nAPI 5XX, LAST HOUR\n  %s\n' "$count"
[ "$count" -eq 0 ] || verdict=1

log_lines() { # log_lines <service> <filter pattern>
  local group="/aws/lambda/cumulo-$1-${env_name}" events lines
  events=$(observe logs filter-log-events --log-group-name "$group" \
    --start-time "$((hour_ago * 1000))" --filter-pattern "$2" --max-items 5) || exit 2
  lines=$(parse filter-log-events \
    '.events[] | "  \(.timestamp / 1000 | floor | todate)  \(.message | gsub("\\s+"; " ") | redact | .[:300])"' \
    <<<"$events") || exit 2
  printf '\nLOG %s, LAST HOUR, %s\n%s\n' "$group" "$2" "${lines:-  no matching lines}"
}

# Event names are owned by apiServerErrorEvent and apiRequestFailedEvent in
# apps/api/src/main.ts and messageOutcomeEvent in apps/forecast/src/handler.ts,
# and the statuses that keep a record off the DLQ by failsTheRecord there;
# incident-watch.test.sh fails if they move without this file.
api_errors='?api_response_server_error ?"api.request.failed"'
lambda_errors='?ERROR ?"Task timed out"'
forecast_failures='{ ($.event = "forecast.message.outcome") && ($.status != "stored") && ($.status != "no-active-sites") }'

alarmed="$firing
$raised"
if [ "$count" -gt 0 ] || grep -q "^cumulo-api-${env_name}-" <<<"$alarmed"; then
  log_lines api "$api_errors"
fi
if grep -q "^cumulo-ingestion-${env_name}-" <<<"$alarmed"; then
  log_lines ingestion "$lambda_errors"
fi
# The DLQ name is infra/ingestion/alarms.tf's; its messages are records the
# forecast function reported failed.
if grep -q -e "^cumulo-forecast-${env_name}-" -e "^cumulo-weather-readings-dlq-${env_name}-" <<<"$alarmed"; then
  log_lines forecast "$lambda_errors"
  log_lines forecast "$forecast_failures"
fi

printf '\nVERDICT %s\n' "$([ "$verdict" -eq 0 ] && echo quiet || echo act)"
exit "$verdict"
