#!/usr/bin/env bash
# Test harness for incident-watch.sh, its neighbour in this directory, and for
# the policy it runs under (infra/bootstrap/observer.tf, #604).
#
# `aws` is a stub on PATH that answers from per-case fixture files and logs
# every call, so no case reaches AWS and every case can assert what the script
# asked for: only the five read calls, always as the observer's profile.
#
# Usage: bash .claude/scripts/incident-watch.test.sh  (or `pnpm test:scripts`)
# Exit:  0 every case PASS, 1 at least one FAIL, 2 the harness itself broke.
set -uo pipefail

SCRIPTS=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd) || exit 2
REPO=$(cd "$SCRIPTS/../.." && pwd) || exit 2
WATCH="$SCRIPTS/incident-watch.sh"
POLICY="$REPO/infra/bootstrap/observer.tf"

# shellcheck source=./harness-lib.sh
. "$SCRIPTS/harness-lib.sh"
harness_init_tmp

READ_CALLS="sts get-caller-identity
cloudwatch describe-alarms
cloudwatch describe-alarm-history
cloudwatch get-metric-data
logs filter-log-events"

# --- the aws stub ----------------------------------------------------------------------------

must mkdir -p "$TMP_ROOT/bin"
cat >"$TMP_ROOT/bin/aws" <<'STUB'
#!/usr/bin/env bash
# Expects `aws --profile P --output json <service> <operation> [args]`, the one
# shape incident-watch.sh calls with; anything else is logged and refused.
if [ "${1-}" != "--profile" ] || [ "${3-}" != "--output" ]; then
  printf 'MALFORMED %s\n' "$*" >>"$STUB_LOG"
  exit 99
fi
printf 'CALL profile=%s key=%s %s %s\n' "$2" "${AWS_ACCESS_KEY_ID:-unset}" "$5" "$6" >>"$STUB_LOG"
shift 4
fixture=""
case "$1 $2" in
  "sts get-caller-identity") fixture=identity ;;
  "cloudwatch describe-alarms")
    case " $* " in
      *" --state-value ALARM "*) fixture=firing ;;
      *) fixture=api-alarm ;;
    esac
    ;;
  "cloudwatch describe-alarm-history") fixture=history ;;
  "cloudwatch get-metric-data") fixture=metric ;;
  "logs filter-log-events")
    while [ $# -gt 0 ]; do
      [ "$1" = "--log-group-name" ] && printf 'GROUP %s\n' "$2" >>"$STUB_LOG"
      shift
    done
    fixture=logs
    ;;
  *) exit 99 ;;
esac
if [ ! -f "$STUB_FIXTURES/$fixture.json" ]; then
  printf 'An error occurred (AccessDenied) when calling the stubbed operation\n' >&2
  exit 254
fi
cat "$STUB_FIXTURES/$fixture.json"
STUB
must chmod +x "$TMP_ROOT/bin/aws"

FIX=""
LOG=""

# new_case <name> — fresh fixture directory holding the quiet-day defaults.
new_case() {
  begin "$1"
  FIX="$TMP_ROOT/case-$((passed + failed))"
  LOG="$FIX/calls.log"
  must mkdir -p "$FIX"
  : >"$LOG"
  fixture identity '{"Arn": "arn:aws:iam::000000000000:user/cumulo-observer-dev"}'
  fixture firing '{"MetricAlarms": [], "CompositeAlarms": []}'
  fixture api-alarm '{"MetricAlarms": [{"AlarmName": "cumulo-api-dev-5xx", "Namespace": "AWS/ApiGateway", "MetricName": "5xx", "Dimensions": [{"Name": "ApiId", "Value": "abc123"}]}]}'
  fixture history '{"AlarmHistoryItems": [
    {"Timestamp": "2026-10-07T12:55:00Z", "AlarmName": "cumulo-api-dev-5xx", "HistorySummary": "Alarm updated from OK to ALARM"},
    {"Timestamp": "2026-10-07T12:50:00Z", "AlarmName": "someone-elses-alarm", "HistorySummary": "Alarm updated from OK to ALARM"},
    {"Timestamp": "2026-10-07T12:48:00Z", "AlarmName": "cumulo-api-dev-5xx", "HistorySummary": "Alarm updated from ALARM to OK"}]}'
  fixture metric '{"MetricDataResults": [{"Id": "fivexx", "Values": []}]}'
  fixture logs '{"events": []}'
}

fixture() { # fixture <name> <json>
  printf '%s\n' "$2" >"$FIX/$1.json" || exit 2
}

run_watch() {
  capture env PATH="$TMP_ROOT/bin:$PATH" STUB_LOG="$LOG" STUB_FIXTURES="$FIX" "$@" bash "$WATCH"
}

calls() { cat "$LOG"; }

log_has() { grep -qF -- "$1" "$LOG" || bad "the aws stub never saw '$1'; log: $(calls)"; }
log_lacks() { grep -qF -- "$1" "$LOG" && bad "the aws stub saw '$1'; log: $(calls)"; }

expect_only_read_calls() {
  local line call
  while IFS= read -r line; do
    case "$line" in
      "CALL "*)
        call=$(printf '%s' "$line" | awk '{print $4, $5}')
        printf '%s\n' "$READ_CALLS" | grep -qxF "$call" || bad "non-read call: $call"
        ;;
      GROUP*) ;;
      *) bad "stub saw: $line" ;;
    esac
  done <"$LOG"
}

# --- the report ------------------------------------------------------------------------------

new_case "quiet: nothing firing and no 5xx exits 0 and reads no logs"
run_watch
expect_rc 0
expect_stdout "IN ALARM
  none"
expect_stdout "API 5XX, LAST HOUR
  0"
expect_stdout "VERDICT quiet"
expect_not_stdout "LOG "
expect_only_read_calls
end

new_case "an api alarm and 5xx: names the alarm, since when, the reason, the count and the log lines"
fixture firing '{"MetricAlarms": [{"AlarmName": "cumulo-api-dev-5xx", "StateUpdatedTimestamp": "2026-10-07T12:55:00Z", "StateReason": "Threshold Crossed: 1 datapoint [2.0] was greater than the threshold (0.0)."}], "CompositeAlarms": []}'
fixture metric '{"MetricDataResults": [{"Id": "fivexx", "Values": [2.0, 1.0]}]}'
fixture logs '{"events": [{"timestamp": 1791377700000, "message": "{\"event\":\"api_response_server_error\",\n\"route\":\"/v1/fleet/forecast\"}"}]}'
run_watch
expect_rc 1
expect_stdout "cumulo-api-dev-5xx since 2026-10-07T12:55:00Z"
expect_stdout "Threshold Crossed: 1 datapoint"
expect_stdout "API 5XX, LAST HOUR
  3"
expect_stdout '{"event":"api_response_server_error", "route":"/v1/fleet/forecast"}'
expect_stdout "VERDICT act"
log_has "GROUP /aws/lambda/cumulo-api-dev"
expect_only_read_calls
end

new_case "history keeps only cumulo- alarms"
run_watch
expect_rc 0
expect_stdout "LAST 10 TRANSITIONS
  2026-10-07T12:55:00Z  cumulo-api-dev-5xx  Alarm updated from OK to ALARM
  2026-10-07T12:48:00Z  cumulo-api-dev-5xx  Alarm updated from ALARM to OK"
expect_not_stdout "someone-elses-alarm"
end

new_case "--history caps the transitions printed"
capture env PATH="$TMP_ROOT/bin:$PATH" STUB_LOG="$LOG" STUB_FIXTURES="$FIX" bash "$WATCH" --history 1
expect_rc 0
expect_stdout "LAST 1 TRANSITIONS"
expect_not_stdout "ALARM to OK"
end

new_case "a firing DLQ alarm reads the forecast log group, not the api's"
fixture firing '{"MetricAlarms": [{"AlarmName": "cumulo-weather-readings-dlq-dev-not-empty", "StateUpdatedTimestamp": "2026-10-07T09:00:00Z", "StateReason": "Threshold Crossed"}], "CompositeAlarms": []}'
run_watch
expect_rc 1
log_has "GROUP /aws/lambda/cumulo-forecast-dev"
log_lacks "GROUP /aws/lambda/cumulo-api-dev"
expect_stdout "no matching lines"
end

# --- the identity --------------------------------------------------------------------------

new_case "any identity but the observer is refused before a single CloudWatch read"
fixture identity '{"Arn": "arn:aws:iam::000000000000:user/tom-admin"}'
run_watch
expect_rc 2
expect_stderr "refusing to run as anything but the observer"
expect_not_stderr "000000000000"
[ "$(grep -c '^CALL' "$LOG")" = "1" ] || bad "expected only the identity call; log: $(calls)"
end

new_case "another environment's observer is refused too"
run_watch CUMULO_ENV=prod
expect_rc 2
expect_stderr "not user/cumulo-observer-prod"
end

new_case "every call names the observer profile, and environment keys never reach the CLI"
run_watch AWS_ACCESS_KEY_ID=from-the-environment
expect_rc 0
log_lacks "key=from-the-environment"
grep '^CALL' "$LOG" | grep -qv 'profile=cumulo-observer ' && bad "a call without the observer profile: $(calls)"
end

new_case "AWS_PROFILE names the profile when set"
run_watch AWS_PROFILE=observer-elsewhere
expect_rc 0
grep '^CALL' "$LOG" | grep -qv 'profile=observer-elsewhere ' && bad "a call ignored AWS_PROFILE: $(calls)"
end

# --- no verdict ----------------------------------------------------------------------------

new_case "a failed read is no verdict, not a quiet report"
rm -f "$FIX/history.json"
run_watch
expect_rc 2
expect_stderr "aws cloudwatch describe-alarm-history failed — no verdict"
expect_not_stdout "VERDICT"
end

new_case "a missing 5xx alarm is no verdict"
fixture api-alarm '{"MetricAlarms": []}'
run_watch
expect_rc 2
expect_stderr "alarm cumulo-api-dev-5xx does not exist"
end

# --- the policy ----------------------------------------------------------------------------

ALLOWED="cloudwatch:DescribeAlarmHistory
cloudwatch:DescribeAlarms
cloudwatch:GetMetricData
logs:FilterLogEvents"

# policy_violations <file> — prints one line per departure from the read-only
# policy: an action-shaped string outside the four, a wildcard in an action list,
# an Allow list or the observer_actions local that is not exactly the four.
policy_violations() {
  grep -oE '"[A-Za-z0-9-]+:[A-Za-z0-9*]+"' "$1" | tr -d '"' | sort -u | while IFS= read -r action; do
    printf '%s\n' "$ALLOWED" | grep -qxF "$action" || printf 'action outside the read-only four: %s\n' "$action"
  done
  awk '
    /^[[:space:]]*(actions|observer_actions)[[:space:]]*=/ { collecting = 1; list = "" }
    collecting {
      line = $0
      while (match(line, /"[^"]*"/)) { list = list substr(line, RSTART + 1, RLENGTH - 2) "\n"; line = substr(line, RSTART + RLENGTH) }
      if ($0 ~ /\]/) { printf "%s", list; print "--"; collecting = 0 }
    }
  ' "$1" | {
    current=""
    while IFS= read -r item; do
      if [ "$item" = "--" ]; then
        case "$current" in
          *'*'*) printf 'wildcard action in a list: %s\n' "$current" ;;
        esac
        current=""
      else
        current="$current$item "
      fi
    done
  }
  local listed
  listed=$(awk '/observer_actions[[:space:]]*=[[:space:]]*\[/,/\]/' "$1" | grep -oE '"[^"]+"' | tr -d '"' | sort)
  [ "$listed" = "$ALLOWED" ] || printf 'observer_actions is not exactly the four reads: %s\n' "$listed"
}

new_case "the shipped policy allows exactly the four reads"
violations=$(policy_violations "$POLICY")
[ -z "$violations" ] || bad "$violations"
grep -qF 'effect      = "Deny"' "$POLICY" || bad "the explicit Deny statement is gone"
end

new_case "negative control: a write action added to the policy is caught"
must cp "$POLICY" "$TMP_ROOT/observer-write.tf"
must sed -i.bak 's/"cloudwatch:GetMetricData"\]/"cloudwatch:GetMetricData", "cloudwatch:PutMetricAlarm"]/' "$TMP_ROOT/observer-write.tf"
fixture_has "$TMP_ROOT/observer-write.tf" "PutMetricAlarm"
violations=$(policy_violations "$TMP_ROOT/observer-write.tf")
case "$violations" in
  *"cloudwatch:PutMetricAlarm"*) ;;
  *) bad "PutMetricAlarm not reported; got: $violations" ;;
esac
end

new_case "negative control: an iam action or a wildcard action is caught"
must cp "$POLICY" "$TMP_ROOT/observer-wide.tf"
must sed -i.bak 's/"logs:FilterLogEvents"\]/"logs:FilterLogEvents", "iam:*", "*"]/' "$TMP_ROOT/observer-wide.tf"
fixture_has "$TMP_ROOT/observer-wide.tf" '"iam:*"'
violations=$(policy_violations "$TMP_ROOT/observer-wide.tf")
case "$violations" in
  *"iam:*"*) ;;
  *) bad "iam:* not reported; got: $violations" ;;
esac
case "$violations" in
  *"wildcard action in a list"*) ;;
  *) bad "bare * action not reported; got: $violations" ;;
esac
end

# --- no key in the skill's files ------------------------------------------------------------

# Split so this file holds no access-key prefix of its own.
KEY_PREFIX="AK""IA"

key_hits() { grep -rn "$KEY_PREFIX" "$@"; }

new_case "the skill, its scripts and the observer policy hold no access-key id"
hits=$(key_hits "$REPO/.claude/skills/incident-watch" "$WATCH" "$SCRIPTS/incident-watch.test.sh" "$POLICY")
[ -z "$hits" ] || bad "access-key prefix found: $hits"
end

new_case "negative control: a planted key id is found"
must mkdir -p "$TMP_ROOT/skill"
printf 'aws_access_key_id = %sIOSFODNN7EXAMPLE\n' "$KEY_PREFIX" >"$TMP_ROOT/skill/SKILL.md"
[ -n "$(key_hits "$TMP_ROOT/skill")" ] || bad "planted key id not found"
end

finish
