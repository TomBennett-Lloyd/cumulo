#!/usr/bin/env bash
# Test harness for incident-watch.sh, its neighbour in this directory, and for
# the policy it runs under (infra/bootstrap/observer.tf, #604).
#
# `aws` is a stub on PATH that answers from per-case fixture files and logs
# every call, so no case reaches AWS and every case can assert what the script
# asked for: only the calls in READ_CALLS, always as the observer's profile.
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
printf 'ARGS %s\n' "$*" >>"$STUB_LOG"
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
      [ "$1" = "--filter-pattern" ] && printf 'PATTERN %s\n' "$2" >>"$STUB_LOG"
      shift
    done
    fixture=logs
    ;;
  *) exit 99 ;;
esac
if [ ! -f "$STUB_FIXTURES/$fixture.json" ]; then
  printf 'An error occurred (AccessDenied): User: arn:aws:iam::123456789012:user/cumulo-observer-dev is not authorized\n' >&2
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
    {"Timestamp": "2020-01-01T12:55:00Z", "AlarmName": "cumulo-api-dev-5xx", "HistorySummary": "Alarm updated from OK to ALARM"},
    {"Timestamp": "2020-01-01T12:50:00Z", "AlarmName": "someone-elses-alarm", "HistorySummary": "Alarm updated from OK to ALARM"},
    {"Timestamp": "2020-01-01T12:48:00Z", "AlarmName": "cumulo-api-dev-5xx", "HistorySummary": "Alarm updated from ALARM to OK"}]}'
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
      GROUP* | PATTERN* | ARGS*) ;;
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
expect_stdout "RAISED IN THE LAST HOUR
  none"
expect_stdout "API 5XX, LAST HOUR
  0"
expect_stdout "VERDICT quiet"
expect_not_stdout "LOG "
expect_only_read_calls
end

new_case "an api alarm and 5xx: names the alarm, since when, the reason, the count and the log lines"
fixture firing '{"MetricAlarms": [{"AlarmName": "cumulo-api-dev-5xx", "StateUpdatedTimestamp": "2020-01-01T12:55:00Z", "StateReason": "Threshold Crossed: 1 datapoint [2.0] was greater than the threshold (0.0)."}], "CompositeAlarms": []}'
fixture metric '{"MetricDataResults": [{"Id": "fivexx", "Values": [2.0, 1.0]}]}'
fixture logs '{"events": [{"timestamp": 1791377700000, "message": "{\"event\":\"api_response_server_error\",\n\"route\":\"/v1/fleet/forecast\"}"}]}'
run_watch
expect_rc 1
expect_stdout "cumulo-api-dev-5xx since 2020-01-01T12:55:00Z"
expect_stdout "Threshold Crossed: 1 datapoint"
expect_stdout "API 5XX, LAST HOUR
  3"
expect_stdout '{"event":"api_response_server_error", "route":"/v1/fleet/forecast"}'
expect_stdout "VERDICT act"
log_has "GROUP /aws/lambda/cumulo-api-dev"
log_has "--max-items 5"
expect_only_read_calls
end

new_case "5xx with nothing firing still acts and reads the api's log (the #586 shape)"
fixture metric '{"MetricDataResults": [{"Id": "fivexx", "Values": [1.0]}]}'
run_watch
expect_rc 1
log_has "GROUP /aws/lambda/cumulo-api-dev"
end

new_case "a firing api alarm with no 5xx reads the api's log"
fixture firing '{"MetricAlarms": [{"AlarmName": "cumulo-api-dev-server-error", "StateUpdatedTimestamp": "2020-01-01T12:55:00Z", "StateReason": "Threshold Crossed"}], "CompositeAlarms": []}'
run_watch
expect_rc 1
log_has "GROUP /aws/lambda/cumulo-api-dev"
end

new_case "a firing ingestion alarm reads the ingestion log group only"
fixture firing '{"MetricAlarms": [{"AlarmName": "cumulo-ingestion-dev-errors", "StateUpdatedTimestamp": "2020-01-01T09:00:00Z", "StateReason": "Threshold Crossed"}], "CompositeAlarms": []}'
run_watch
expect_rc 1
log_has "GROUP /aws/lambda/cumulo-ingestion-dev"
log_lacks "GROUP /aws/lambda/cumulo-api-dev"
log_lacks "GROUP /aws/lambda/cumulo-forecast-dev"
end

new_case "a firing DLQ alarm reads the forecast group for errors and for failed outcomes"
fixture firing '{"MetricAlarms": [{"AlarmName": "cumulo-weather-readings-dlq-dev-not-empty", "StateUpdatedTimestamp": "2020-01-01T09:00:00Z", "StateReason": "Threshold Crossed"}], "CompositeAlarms": []}'
run_watch
expect_rc 1
log_has "GROUP /aws/lambda/cumulo-forecast-dev"
log_has 'PATTERN { ($.event = "forecast.message.outcome") && ($.status = "failed") }'
log_lacks "GROUP /aws/lambda/cumulo-api-dev"
expect_stdout "no matching lines"
end

new_case "composite alarms are requested, in the ALARM listing and the history"
fixture firing '{"MetricAlarms": [], "CompositeAlarms": [{"AlarmName": "cumulo-composite-dev", "StateUpdatedTimestamp": "2020-01-01T09:00:00Z", "StateReason": "child alarm"}]}'
run_watch
expect_rc 1
expect_stdout "cumulo-composite-dev since 2020-01-01T09:00:00Z"
[ "$(grep -c '^ARGS .*--alarm-types MetricAlarm CompositeAlarm' "$LOG")" = "2" ] ||
  bad "expected --alarm-types on both listings; log: $(calls)"
end

new_case "history keeps only cumulo- alarms"
run_watch
expect_rc 0
expect_stdout "LAST 10 TRANSITIONS
  2020-01-01T12:55:00Z  cumulo-api-dev-5xx  Alarm updated from OK to ALARM
  2020-01-01T12:48:00Z  cumulo-api-dev-5xx  Alarm updated from ALARM to OK"
expect_not_stdout "someone-elses-alarm"
end

new_case "--history caps the transitions printed"
capture env PATH="$TMP_ROOT/bin:$PATH" STUB_LOG="$LOG" STUB_FIXTURES="$FIX" bash "$WATCH" --history 1
expect_rc 0
expect_stdout "LAST 1 TRANSITIONS"
expect_not_stdout "ALARM to OK"
end

new_case "an alarm raised and cleared inside the hour acts and reads its log"
recent=$(jq -rn 'now - 600 | floor | todate | sub("Z$"; ".123000+00:00")')
fixture history "{\"AlarmHistoryItems\": [
  {\"Timestamp\": \"$recent\", \"AlarmName\": \"cumulo-forecast-dev-errors\", \"HistorySummary\": \"Alarm updated from ALARM to OK\"},
  {\"Timestamp\": \"$recent\", \"AlarmName\": \"cumulo-forecast-dev-errors\", \"HistorySummary\": \"Alarm updated from OK to ALARM\"}]}"
run_watch
expect_rc 1
expect_stdout "RAISED IN THE LAST HOUR
  cumulo-forecast-dev-errors"
expect_stdout "IN ALARM
  none"
log_has "GROUP /aws/lambda/cumulo-forecast-dev"
end

new_case "account ids are redacted from reasons and log lines; longer numbers are not"
fixture firing '{"MetricAlarms": [{"AlarmName": "cumulo-api-dev-5xx", "StateUpdatedTimestamp": "2020-01-01T12:55:00Z", "StateReason": "see arn:aws:sns:eu-west-1:123456789012:cumulo-alerts-dev"}], "CompositeAlarms": []}'
fixture logs '{"events": [{"timestamp": 1791377700000, "message": "{\"detail\":\"arn:aws:dynamodb:eu-west-1:123456789012:table/x\",\"at\":1791377700000}"}]}'
run_watch
expect_rc 1
expect_not_stdout "123456789012"
expect_stdout "arn:aws:sns:eu-west-1:<account-id>:cumulo-alerts-dev"
expect_stdout "arn:aws:dynamodb:eu-west-1:<account-id>:table/x"
expect_stdout '"at":1791377700000'
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

new_case "a failed read is no verdict, not a quiet report, and its error is redacted"
rm -f "$FIX/history.json"
run_watch
expect_rc 2
expect_stderr "aws cloudwatch describe-alarm-history failed"
expect_stderr "— no verdict"
expect_stderr "arn:aws:iam::<account-id>:user"
expect_not_stderr "123456789012"
expect_not_stdout "VERDICT"
end

new_case "a response jq cannot read is no verdict, not a quiet report"
fixture firing 'warning: something
{"MetricAlarms": [{"AlarmName": "cumulo-forecast-dev-errors"}]}'
run_watch
expect_rc 2
expect_stderr "unreadable describe-alarms response"
expect_not_stdout "VERDICT"
end

new_case "a listing without MetricAlarms is no verdict"
fixture firing '{"CompositeAlarms": []}'
run_watch
expect_rc 2
expect_stderr "unreadable describe-alarms response"
end

new_case "a missing 5xx alarm is no verdict"
fixture api-alarm '{"MetricAlarms": []}'
run_watch
expect_rc 2
expect_stderr "alarm cumulo-api-dev-5xx does not exist"
end

# --- strings the script shares with their owners -------------------------------------------

# owned_string <file> <sed -E capture of the value>
owned_string() { sed -nE "s/$2/\\1/p" "$1" | head -n 1; }

new_case "the log filters carry the event names their owners export"
for owned in \
  "$(owned_string "$REPO/apps/api/src/main.ts" "^export const apiServerErrorEvent = '([^']+)';")" \
  "$(owned_string "$REPO/apps/api/src/main.ts" "^export const apiRequestFailedEvent = '([^']+)';")" \
  "$(owned_string "$REPO/apps/forecast/src/handler.ts" "^export const messageOutcomeEvent = '([^']+)';")"; do
  [ -n "$owned" ] || bad "an owning constant was not found — has it moved?"
  grep -qF "$owned" "$WATCH" || bad "incident-watch.sh does not carry the event name '$owned'"
done
end

new_case "the DLQ prefix matches the alarm infra/ingestion owns"
dlq=$(owned_string "$REPO/infra/ingestion/alarms.tf" '^ *alarm_name *= *"(cumulo-weather-readings-dlq-)\$\{var\.environment\}-not-empty"')
[ "$dlq" = "cumulo-weather-readings-dlq-" ] || bad "DLQ alarm name not found in infra/ingestion/alarms.tf"
grep -qF "\"^${dlq}\${env_name}-\"" "$WATCH" || bad "incident-watch.sh does not match the DLQ alarm prefix"
end

# --- the policy ----------------------------------------------------------------------------

ALLOWED="cloudwatch:DescribeAlarmHistory
cloudwatch:DescribeAlarms
cloudwatch:GetMetricData
logs:FilterLogEvents"

# The file with comment lines and trailing comments removed, so prose cannot
# satisfy or trip a check.
code_of() { sed -E 's/^[[:space:]]*#.*$//; s/[[:space:]]+#.*$//' "$1"; }

# The statement block holding `sid = "<sid>"`, one line per line of it.
statement_of() { # statement_of <file> <sid>
  code_of "$1" | awk -v sid="$2" '
    /statement[[:space:]]*\{/ { depth = 1; block = $0 "\n"; inside = 1; next }
    inside {
      block = block $0 "\n"
      depth += gsub(/\{/, "{"); depth -= gsub(/\}/, "}")
      if (depth == 0) { if (block ~ "sid[[:space:]]*=[[:space:]]*\"" sid "\"") printf "%s", block; inside = 0 }
    }'
}

# policy_violations <file> — one line per departure from the read-only policy.
policy_violations() {
  local code deny squeezed
  code=$(code_of "$1")
  printf '%s\n' "$code" | grep -oE '"[A-Za-z0-9-]+:[A-Za-z0-9*]+"' | tr -d '"' | sort -u | while IFS= read -r action; do
    printf '%s\n' "$ALLOWED" | grep -qxF "$action" || printf 'action outside the read-only list: %s\n' "$action"
  done
  printf '%s\n' "$code" | awk '
    /^[[:space:]]*actions[[:space:]]*=/ { collecting = 1; list = "" }
    collecting {
      list = list $0
      if ($0 ~ /\]/) { if (list ~ /"\*"/) print "wildcard action in an actions list"; collecting = 0 }
    }'
  local listed
  listed=$(printf '%s\n' "$code" | awk '/observer_actions[[:space:]]*=[[:space:]]*\[/,/\]/' | grep -oE '"[^"]+"' | tr -d '"' | sort)
  [ "$listed" = "$ALLOWED" ] || printf 'observer_actions is not exactly the read-only list: %s\n' "$listed"
  printf '%s\n' "$code" | grep -nE 'jsonencode|policy_arn|NotAction|"Action"' | sed 's/^/policy written outside the policy document: /'
  printf '%s\n' "$code" | grep -oE '^(resource|data) "aws_iam_[a-z_]+"' | sort | tr '\n' ' ' |
    grep -qxF 'data "aws_iam_policy_document" resource "aws_iam_user" resource "aws_iam_user_policy" ' ||
    printf 'IAM blocks are not exactly one policy document, one user and one inline policy\n'
  [ "$(printf '%s\n' "$code" | grep -c 'not_actions')" = "1" ] || printf 'not_actions appears outside the Deny\n'
  deny=$(statement_of "$1" DenyEverythingElse)
  squeezed=$(printf '%s' "$deny" | tr -s '[:space:]' ' ')
  for part in 'effect = "Deny"' 'not_actions = local.observer_actions' 'resources = ["*"]'; do
    case "$squeezed" in
      *"$part"*) ;;
      *) printf 'the Deny statement lacks %s\n' "$part" ;;
    esac
  done
  case "$squeezed" in
    *condition*) printf 'the Deny statement is conditional\n' ;;
  esac
}

new_case "the shipped policy allows exactly observer_actions and denies everything else"
violations=$(policy_violations "$POLICY")
[ -z "$violations" ] || bad "$violations"
end

# mutant <name> <sed expression> — a scratch copy of the policy with one edit.
mutant() {
  must cp "$POLICY" "$TMP_ROOT/$1.tf"
  must sed -i.bak -E "$2" "$TMP_ROOT/$1.tf"
  cmp -s "$POLICY" "$TMP_ROOT/$1.tf" && {
    printf 'FATAL mutant %s left the policy unchanged\n' "$1" >&2
    exit 2
  }
  printf '%s' "$TMP_ROOT/$1.tf"
}

expect_violation() { # expect_violation <mutant file> <substring>
  local found
  found=$(policy_violations "$1")
  case "$found" in
    *"$2"*) ;;
    *) bad "expected a violation containing '$2'; got: $found" ;;
  esac
}

new_case "negative control: a write action added to an Allow is caught"
expect_violation "$(mutant write 's/"cloudwatch:GetMetricData"\]/"cloudwatch:GetMetricData", "cloudwatch:PutMetricAlarm"]/')" "cloudwatch:PutMetricAlarm"
end

new_case "negative control: an iam action or a wildcard action is caught"
wide=$(mutant wide 's/"logs:FilterLogEvents"\]/"logs:FilterLogEvents", "iam:*", "*"]/')
expect_violation "$wide" "iam:*"
expect_violation "$wide" "wildcard action in an actions list"
end

new_case "negative control: an Allow by not_actions with the Deny narrowed is caught"
widened=$(mutant widened 's/^( *)actions( *)= \["logs:FilterLogEvents"\]/\1not_actions = ["logs:FilterLogEvents"]/; s|^( *)resources( *)= \["\*"\]$|\1resources = ["arn:aws:s3:::nothing"]|')
expect_violation "$widened" "not_actions appears outside the Deny"
expect_violation "$widened" 'the Deny statement lacks resources = ["*"]'
end

new_case "negative control: a jsonencode policy or a managed attachment is caught"
encoded=$(mutant encoded 's/^resource "aws_iam_user_policy" "observer" \{/resource "aws_iam_user_policy" "extra" { policy = jsonencode({ Statement = [{ Effect = "Allow", Action = "s3:*", Resource = "*" }] }) }\nresource "aws_iam_user_policy_attachment" "admin" { policy_arn = "arn:aws:iam::aws:policy\/AdministratorAccess" }\n&/')
expect_violation "$encoded" "policy written outside the policy document"
expect_violation "$encoded" "IAM blocks are not exactly"
end

new_case "negative control: a Deny that survives only in a comment is caught"
commented=$(mutant commented 's/^( *)effect( *)= "Deny"/\1# effect = "Deny"\n\1effect = "Allow"/')
expect_violation "$commented" 'the Deny statement lacks effect = "Deny"'
end

# The runbook's table of actions is the owner-facing copy of observer_actions.
BT='`'
readme_actions() { # readme_actions <readme>
  awk '/^## Runbook: the observer identity/,/^### Phase A/' "$1" |
    grep -oE "^\\| ${BT}[a-z]+:[A-Za-z]+${BT}" | tr -d "|$BT " | sort
}

new_case "infra/README.md's observer table lists exactly observer_actions"
[ "$(readme_actions "$REPO/infra/README.md")" = "$ALLOWED" ] ||
  bad "README table: $(readme_actions "$REPO/infra/README.md" | tr '\n' ' ')"
end

new_case "negative control: a row added to the README table is caught"
must sed -E "s/^\\| ${BT}logs:FilterLogEvents${BT} /| ${BT}logs:DeleteLogGroup${BT} | x | x |\\n&/" "$REPO/infra/README.md" >"$TMP_ROOT/README.md"
fixture_has "$TMP_ROOT/README.md" 'logs:DeleteLogGroup'
[ "$(readme_actions "$TMP_ROOT/README.md")" != "$ALLOWED" ] || bad "an extra README row went unnoticed"
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
