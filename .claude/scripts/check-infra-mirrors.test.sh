#!/usr/bin/env bash
# Test harness for check-infra-mirrors.sh, its neighbour in this directory.
#
# No test framework, no network, no pnpm, no terraform: the assertion vocabulary
# is harness-lib.sh next door, sourced below and shared with every sibling
# harness. Every fixture is a throwaway tree under the temp tree
# `harness_init_tmp` makes and a trap deletes on exit, laid out at the exact
# repo-relative paths the gate's MIRRORS list names — which is what lets the
# shipped records be exercised against doctored values without ever putting a
# drifted value in this repo.
#
# The red cases below ARE the point of the gate, committed rather than run once
# by hand (testing.md rule 4): every relation the record grammar can express has
# at least one case that goes red, in the direction that relation exists to
# forbid. A gate whose failure path nobody exercises is indistinguishable from a
# gate that cannot fail, and this one's whole job is to fail on an edit that is
# trivially easy to make.
#
# Since #133 there are five relations rather than one, so the fixture builds
# every file the eight shipped records name — and three of its files carry a
# shape the reader has to survive rather than parse: the API stage's
# `dynamic "route_settings" { content { … } }` sibling holding a DIFFERENT
# throttle, the `<<-EOT` description above `variables.tf`'s validation block,
# and the queue's `redrive_policy = jsonencode({ … })`. Delete any of the three
# and the corresponding case still passes while proving much less.
#
# One case deliberately runs the gate with NO argument, against the real repo:
# every other case pins REPO_ROOT to a fixture, so without it the shipped
# default path — and the shipped MIRRORS records' own paths — could be broken
# and the suite would still be green (testing.md rule 7).
#
# DEPENDENCY: the cases that need a fixture variant differing in one line edit it
# with `perl` rather than writing the whole file out again. It buys a diff a
# reader can see at a glance — "this fixture is the good one, minus its top-level
# timeout". The idiom started here and is now the ratified family convention,
# stated in harness-lib.sh's header along with the fixture_has/fixture_lacks
# assertion every such edit is followed by, because `perl -pi` reports success for
# a substitution that matched nothing. `perl` is on macOS and on GitHub's ubuntu
# runner images, so leaning on it does not narrow where the suite runs.
#
# Usage: bash .claude/scripts/check-infra-mirrors.test.sh   (or `pnpm test:scripts`)
# Exit:  0 every case PASS, 1 at least one FAIL, 2 the harness itself broke.
set -uo pipefail

SCRIPTS=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd) || exit 2
CHECK="$SCRIPTS/check-infra-mirrors.sh"

# shellcheck source=./harness-lib.sh
. "$SCRIPTS/harness-lib.sh"
harness_init_tmp

# --- fixtures ----------------------------------------------------------------------------

# The paths the shipped MIRRORS records point at. Restated here rather than
# parsed out of the gate: a fixture generated from the same records it is meant
# to test would follow a typo in those records into agreement with them.
TF_REL=infra/ingestion/lambda.tf
TS_REL=apps/ingestion/src/cycle-budget.ts

# The other seven records' files. Every case below drives its own assertions
# through one pair and leaves the rest at agreeing values, because the gate
# refuses to reach a verdict at all while any declared pair is unreadable — so a
# fixture missing one would send every case down the BLOCKED path and prove
# nothing about the case it was written for. They are written by the same
# builder rather than once at setup, since each fixture is a fresh tree.
API_TF_REL=infra/api/lambda.tf
API_TS_REL=apps/api/src/request-budget.ts
GATEWAY_REL=infra/api/gateway.tf
WEB_TS_REL=apps/web/src/data/http-fleet-data-source.ts
TABLES_REL=infra/storage/tables.tf
TTL_TS_REL=packages/storage/src/ttl.ts
VARIABLES_REL=infra/storage/variables.tf
TABLE_NAME_TS_REL=packages/storage/src/table-name.ts
QUEUE_REL=infra/ingestion/transport.tf
FORECAST_REL=infra/forecast/lambda.tf

# fixture <name> <tf-timeout-seconds> <ts-literal> -> sets DIR to a fresh tree
# holding the files the gate reads. The Terraform files are written in
# `terraform fmt` layout, which is the layout CI enforces and the gate's reader
# assumes: two-space indentation per depth, a lone `}` at the depth it closes.
fixture() { # fixture <name> <tf-timeout> <ts-literal>
  DIR="$TMP_ROOT/$1"
  local rel
  for rel in "$TF_REL" "$TS_REL" "$API_TF_REL" "$API_TS_REL" "$GATEWAY_REL" "$WEB_TS_REL" \
    "$TABLES_REL" "$TTL_TS_REL" "$VARIABLES_REL" "$TABLE_NAME_TS_REL" "$QUEUE_REL" "$FORECAST_REL"; do
    must mkdir -p "$DIR/$(dirname "$rel")"
  done

  cat >"$DIR/$API_TF_REL" <<EOF
resource "aws_lambda_function" "api" {
  function_name = local.function_name

  timeout = 15

  memory_size = 256
}
EOF
  cat >"$DIR/$API_TS_REL" <<EOF
/** The function timeout in \`$API_TF_REL\`, mirrored. */
export const API_LAMBDA_TIMEOUT_MS = 15_000;
EOF

  # The sub-block case. `default_route_settings.throttling_rate_limit` is 10 and
  # the `dynamic "route_settings"` block beside it sets the SAME attribute name
  # to 2 — a reader that searched the block for a name instead of following the
  # declared path would find both, and a reader that took the last one would
  # compare the fan-out against a number that governs three write routes.
  cat >"$DIR/$GATEWAY_REL" <<'EOF'
resource "aws_apigatewayv2_stage" "default" {
  api_id = aws_apigatewayv2_api.api.id

  name        = "$default"
  auto_deploy = true

  default_route_settings {
    throttling_rate_limit  = 10
    throttling_burst_limit = 20
  }

  dynamic "route_settings" {
    for_each = local.write_route_keys

    content {
      route_key              = route_settings.value
      throttling_rate_limit  = 2
      throttling_burst_limit = 4
    }
  }

  depends_on = [aws_apigatewayv2_route.write]
}
EOF
  cat >"$DIR/$WEB_TS_REL" <<EOF
/** Held strictly under the stage throttle in \`$GATEWAY_REL\`. */
export const FLEET_FANOUT_LAUNCHES_PER_SECOND = 8;
EOF

  # Three tables carrying the same declared TTL attribute name, so the per-record
  # block scoping has something to be wrong about. `series` also carries an
  # `attribute_name` on a DIFFERENT path (inside a GSI's key_schema): a reader
  # that matched the attribute anywhere in the block would see it twice and go
  # non-verdict, which is why it is here rather than in a table no record names.
  cat >"$DIR/$TABLES_REL" <<'EOF'
resource "aws_dynamodb_table" "series" {
  name         = "cumulo-series-dev"
  billing_mode = "PROVISIONED"

  hash_key  = "siteId"
  range_key = "sk"

  attribute {
    name = "siteId"
    type = "S"
  }

  global_secondary_index {
    name = "by-site"

    key_schema {
      attribute_name = "siteId"
      key_type       = "HASH"
    }

    projection_type = "KEYS_ONLY"
  }

  ttl {
    attribute_name = "expiresAt"
    enabled        = true
  }

  point_in_time_recovery {
    enabled = false
  }
}

resource "aws_dynamodb_table" "weather" {
  name         = "cumulo-weather-dev"
  billing_mode = "PAY_PER_REQUEST"

  hash_key = "locationId"

  attribute {
    name = "locationId"
    type = "S"
  }

  ttl {
    attribute_name = "expiresAt"
    enabled        = true
  }
}

resource "aws_dynamodb_table" "abuse" {
  name         = "cumulo-abuse-dev"
  billing_mode = "PAY_PER_REQUEST"

  hash_key = "pk"

  ttl {
    attribute_name = "expiresAt"
    enabled        = true
  }
}
EOF
  cat >"$DIR/$TTL_TS_REL" <<EOF
/** The TTL attribute name every expiring item is written under; mirrored by
 *  the \`ttl\` blocks in \`$TABLES_REL\`. */
export const TTL_ATTRIBUTE_NAME = 'expiresAt';
EOF

  # The heredoc case. A `<<-EOT` description sits above the validation block,
  # and the reader has no heredoc tracking — what keeps its interior lines from
  # being read as blocks or attributes is that they are indented past the depth
  # the reader is acting at. A second variable with its own `validation`
  # `condition` is what makes "the environment one" a claim rather than a
  # coincidence.
  cat >"$DIR/$VARIABLES_REL" <<'EOF'
variable "aws_region" {
  description = "Region for this stack's tables and alarms."
  type        = string

  validation {
    condition     = can(regex("^[a-z]{2}(-[a-z]+)+-[0-9]$", var.aws_region))
    error_message = "aws_region must be an AWS region id, e.g. eu-west-1."
  }
}

variable "environment" {
  description = <<-EOT
    Environment suffix in every table name, mirrored by ENVIRONMENT_PATTERN in
    packages/storage/src/table-name.ts.

    This description is deliberately more than one line, and deliberately talks
    about a condition and about validation, because the reader below it has no
    heredoc tracking and this is where a naive one would go wrong.
  EOT
  type        = string
  default     = "dev"

  validation {
    condition     = can(regex("^[a-z0-9-]+$", var.environment))
    error_message = "environment must be lowercase alphanumerics and hyphens, e.g. dev."
  }
}
EOF
  cat >"$DIR/$TABLE_NAME_TS_REL" <<EOF
/** Mirrored by the \`environment\` validation in \`$VARIABLES_REL\`. */
export const ENVIRONMENT_PATTERN = /^[a-z0-9-]+\$/;
EOF

  # The expression-body case. `redrive_policy = jsonencode({` opens a brace on an
  # attribute line, and its `})` closes one: a reader that counted braces rather
  # than recognising line shapes would leave this block one level deep and never
  # find the visibility timeout at all.
  cat >"$DIR/$QUEUE_REL" <<'EOF'
resource "aws_sqs_queue" "weather_readings" {
  name = "cumulo-weather-readings-dev"

  receive_wait_time_seconds = 20

  visibility_timeout_seconds = 300

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.weather_readings_dlq.arn
    maxReceiveCount     = 5
  })
}

resource "aws_sqs_queue" "weather_readings_dlq" {
  name = "cumulo-weather-readings-dlq-dev"

  message_retention_seconds = 1209600
}
EOF
  cat >"$DIR/$FORECAST_REL" <<'EOF'
resource "aws_lambda_function" "forecast" {
  function_name = local.function_name

  timeout = 50

  memory_size = 256
}
EOF

  cat >"$DIR/$TF_REL" <<EOF
resource "aws_lambda_function" "ingestion" {
  function_name = local.function_name

  # A comment mentioning timeout, which is not an attribute.
  timeout = $2

  memory_size = 256

  environment {
    variables = {
      CUMULO_ENV = var.environment
    }
  }
}

resource "aws_cloudwatch_log_group" "ingestion" {
  name              = "/aws/lambda/\${local.function_name}"
  retention_in_days = 30
}
EOF
  cat >"$DIR/$TS_REL" <<EOF
/** The function timeout in \`$TF_REL\`, mirrored. */
export const INGESTION_LAMBDA_TIMEOUT_MS = $3;

export const SHUTDOWN_MARGIN_MS = 5_000;
EOF
}

run_script_with() { # run_script_with <bash> <script> <args...>
  local interpreter="$1" script="$2"
  shift 2
  capture "$interpreter" "$script" "$@"
}

run_check_with() { # run_check_with <bash> <args...>
  local interpreter="$1"
  shift
  run_script_with "$interpreter" "$CHECK" "$@"
}

run_check() { # run_check <args...>
  run_check_with bash "$@"
}

# gate_copy <basename> -> COPY, a copy of the shipped gate under the temp tree.
# The technique the record-grammar cases need: MIRRORS is baked into the script,
# so a malformed record can only be reached by doctoring a copy of the gate
# itself rather than a fixture tree.
gate_copy() { # gate_copy <basename>
  COPY="$TMP_ROOT/$1"
  must cp "$CHECK" "$COPY"
}

# ==========================================================================================
# 1. the gate parses
# ==========================================================================================
begin "check-infra-mirrors.sh parses (bash -n)"
expect_parses "$CHECK"
end

# ==========================================================================================
# 2. the real repo, via the shipped default path (no argument)
# ==========================================================================================
# The production configuration, and the only case that can catch a MIRRORS record
# pointing at a file that has moved, a resource that has been renamed, or a
# constant that is no longer exported — every case below supplies its own tree.
# It is also what `pnpm verify` actually runs.
begin "the repo's own declared mirrors agree, with no argument"
for interpreter in $BASHES; do
  case_ctx="$interpreter"
  run_check_with "$interpreter"
  expect_rc 0 "$rc"
  expect_out "check-infra-mirrors: OK"
  expect_not_out "unbound variable"
done
case_ctx=""
end

# ==========================================================================================
# 3. a fixture whose every declared relation holds
# ==========================================================================================
# Also the positive control for every emptiness assertion below: each relation's
# green line is asserted here by name, so a case that proves "the weather record
# went red and the series one did not" is standing on a run where all three ttl
# lines demonstrably appeared.
begin "a tree where every declared relation holds passes"
fixture agree 300 300_000
run_check "$DIR"
expect_rc 0 "$rc"
expect_out "check-infra-mirrors: OK — 8 declared mirror relation(s) hold"
expect_out "aws_lambda_function.ingestion.timeout = 300"
expect_out "aws_lambda_function.api.timeout = 15"
expect_out "aws_dynamodb_table.series.ttl.attribute_name"
expect_out "aws_dynamodb_table.weather.ttl.attribute_name"
expect_out "aws_dynamodb_table.abuse.ttl.attribute_name"
expect_out 'variable.environment validation.condition = /^[a-z0-9-]+$/'
expect_out "aws_sqs_queue.weather_readings.visibility_timeout_seconds = 300  >=  6 x"
expect_not_out "ERROR"
end

# ==========================================================================================
# 4. ACCEPTANCE (a): Terraform moved, TypeScript did not — downwards
# ==========================================================================================
# The failure #123 was filed for. Lowering the deployed timeout without moving the
# constant leaves the cycle deadline sized for a limit that no longer exists, which
# is the mid-loop kill #115 removed, reintroduced with nothing going red.
begin "a lowered Terraform timeout with an unchanged constant fails the gate"
fixture tf_lowered 120 300_000
run_check "$DIR"
expect_rc 1 "$rc"
expect_out "declared mirror relation(s) no longer hold"
expect_out "ERROR $TF_REL  aws_lambda_function.ingestion.timeout = 120"
expect_out "INGESTION_LAMBDA_TIMEOUT_MS = 300000, but 120 * 1000 = 120000"
end

# ==========================================================================================
# 5. Terraform moved upwards — the "safe direction" is still a failure
# ==========================================================================================
# Raising the timeout drifts in the direction that only wastes headroom, and it is
# reported just as loudly. A gate that tolerated the quiet direction would be
# teaching the reader that the two numbers are related rather than equal, and the
# next edit down would land against a constant nobody had been asked to move.
begin "a raised Terraform timeout with an unchanged constant also fails"
fixture tf_raised 900 300_000
run_check "$DIR"
expect_rc 1 "$rc"
expect_out "900 * 1000 = 900000"
end

# ==========================================================================================
# 6. ACCEPTANCE (b): TypeScript moved, Terraform did not
# ==========================================================================================
begin "a moved constant with an unchanged Terraform timeout fails the gate"
fixture ts_moved 300 120_000
run_check "$DIR"
expect_rc 1 "$rc"
expect_out "aws_lambda_function.ingestion.timeout = 300"
expect_out "INGESTION_LAMBDA_TIMEOUT_MS = 120000, but 300 * 1000 = 300000"
end

# ==========================================================================================
# 7. the unit scale is applied, not ignored
# ==========================================================================================
# A gate that compared the two literals directly would pass 300 against 300 and
# fail the real repo; one that ignored the scale entirely would pass anything.
# Both mistakes are caught by asserting the off-by-a-thousand pair is red.
begin "300 seconds against a constant of 300 is drift, not agreement"
fixture unscaled 300 300
run_check "$DIR"
expect_rc 1 "$rc"
expect_out "INGESTION_LAMBDA_TIMEOUT_MS = 300, but 300 * 1000 = 300000"
end

# ==========================================================================================
# 8. numeric separators are cosmetic
# ==========================================================================================
begin "300000 and 300_000 are the same constant"
fixture no_separator 300 300000
run_check "$DIR"
expect_rc 0 "$rc"
expect_out "check-infra-mirrors: OK"
end

# ==========================================================================================
# 9. a trailing line comment on the constant is not a change of shape
# ==========================================================================================
# The Terraform reader strips a trailing comment, so the TypeScript reader has to
# as well — asymmetry here would refuse the single most ordinary edit anybody
# makes next to a mirrored number, and refuse it with a message whose every
# clause ("exported, a plain integer, on one line") is already true of the line
# being rejected.
begin "a trailing // comment on the constant is accepted"
fixture ts_comment 300 300_000
must perl -pi -e 's{^export const INGESTION_LAMBDA_TIMEOUT_MS = 300_000;$}{export const INGESTION_LAMBDA_TIMEOUT_MS = 300_000; // five minutes}' "$DIR/$TS_REL"
fixture_has "$DIR/$TS_REL" '= 300_000; // five minutes'
run_check "$DIR"
expect_rc 0 "$rc"
expect_out "check-infra-mirrors: OK"
end

# ==========================================================================================
# 10. the empty-list guard is a branch, so it gets a case
# ==========================================================================================
# The gate's own protection against green-by-absence is the one branch no fixture
# can reach, because MIRRORS is baked into the shipped script. Reaching it means
# running a COPY of the shipped gate with every record line removed — which is
# also the only case here that proves the guard is wired to anything at all.
# Without it, replacing the condition with `false` leaves every other case green.
#
# The surgery is FIXED-STRING and one -e per mode tag, never one ERE alternation:
# the shimmed `grep` on this machine is ugrep, which under-matches alternations
# and would leave records in place while reporting success (#206).
begin "a gate with no records left exits 2 rather than reporting OK"
fixture empty_list 300 300_000
EMPTY_GATE="$TMP_ROOT/check-infra-mirrors-no-records.sh"
must grep -v -F -e '"eq|' -e '"ts-lt|' -e '"str-eq|' -e '"regex-eq|' -e '"tf-ge|' "$CHECK" >"$EMPTY_GATE"
fixture_has "$EMPTY_GATE" 'MIRRORS=('
fixture_lacks "$EMPTY_GATE" '"eq|'
fixture_lacks "$EMPTY_GATE" '"ts-lt|'
fixture_lacks "$EMPTY_GATE" '"str-eq|'
fixture_lacks "$EMPTY_GATE" '"regex-eq|'
fixture_lacks "$EMPTY_GATE" '"tf-ge|'
for interpreter in $BASHES; do
  case_ctx="$interpreter"
  run_script_with "$interpreter" "$EMPTY_GATE" "$DIR"
  expect_rc 2 "$rc"
  expect_out "the MIRRORS list is empty"
  expect_out "green by absence, not green"
  # The gate's full success prefix, not bare "OK" — a temp path echoed into either stream can
  # carry the substring in its random suffix (#219's flake, fixed here before it recurs).
  expect_not_out "check-infra-mirrors: OK"
  expect_not_out "unbound variable"
done
case_ctx=""
end

# ==========================================================================================
# 11. the attribute is read from ITS resource, not the file
# ==========================================================================================
# `retention_in_days` is not `timeout`, but a same-named attribute in a later
# resource is the realistic version of this: a reader scoped to the file rather
# than the block would compare the code against whichever one it met last. The
# fixture puts a second aws_lambda_function after the first with a different
# timeout, and the gate must still report the ingestion function's.
begin "a same-named attribute in a later resource is not read as this one"
fixture other_resource 300 300_000
cat >>"$DIR/$TF_REL" <<'EOF'

resource "aws_lambda_function" "unrelated" {
  function_name = "something-else"
  timeout       = 900
}
EOF
run_check "$DIR"
expect_rc 0 "$rc"
expect_out "aws_lambda_function.ingestion.timeout = 300"
expect_not_out "timeout = 900"
end

# ==========================================================================================
# 12. an attribute nested in a sub-block is not the resource's own
# ==========================================================================================
# The deeper-indentation case. `timeout` inside `environment { variables = { … } }`
# belongs to that expression; reading it as the function's would be a comparison
# against a value AWS never sees. Removing the resource's real timeout as well is
# what makes the failure unambiguous: the gate must say "no top-level timeout",
# not quietly use the nested one.
begin "a nested attribute does not stand in for a missing top-level one"
fixture nested 300 300_000
must perl -0pi -e 's/^  timeout = 300\n\n//m' "$DIR/$TF_REL"
must perl -0pi -e 's/      CUMULO_ENV = var.environment\n/      CUMULO_ENV = var.environment\n      timeout    = 300\n/' "$DIR/$TF_REL"
fixture_lacks "$DIR/$TF_REL" '  timeout = 300'
fixture_has "$DIR/$TF_REL" '      timeout    = 300'
run_check "$DIR"
expect_rc 2 "$rc"
expect_out "declares no top-level 'timeout' attribute"
end

# ==========================================================================================
# 13. a Terraform value that stopped being a plain number
# ==========================================================================================
# `timeout = var.function_timeout` is a legitimate refactor and an illegitimate
# comparison: the gate has no variable resolution and must say so rather than
# compare against the text. Exit 2, not 1 — "I cannot tell" is not "they differ".
begin "a non-numeric Terraform value is a non-verdict, not a failure"
fixture expression 300 300_000
must perl -pi -e 's/^  timeout = 300$/  timeout = var.function_timeout/' "$DIR/$TF_REL"
fixture_has "$DIR/$TF_REL" '  timeout = var.function_timeout'
run_check "$DIR"
expect_rc 2 "$rc"
expect_out "is not a plain integer: var.function_timeout"
expect_out "BLOCKED"
end

# ==========================================================================================
# 14. a constant that stopped being an exported integer literal
# ==========================================================================================
begin "a derived or unexported constant is a non-verdict"
for variant in "const INGESTION_LAMBDA_TIMEOUT_MS = 300_000;" \
  "export const INGESTION_LAMBDA_TIMEOUT_MS = 300 * 1_000;"; do
  case_ctx="$variant"
  fixture ts_shape 300 300_000
  must perl -pi -e "s/^export const INGESTION_LAMBDA_TIMEOUT_MS = 300_000;\$/$variant/" "$DIR/$TS_REL"
  fixture_has "$DIR/$TS_REL" "$variant"
  run_check "$DIR"
  expect_rc 2 "$rc"
  expect_out "declares no 'export const INGESTION_LAMBDA_TIMEOUT_MS = <integer>;'"
done
case_ctx=""
end

# ==========================================================================================
# 15. the resource itself is gone or renamed
# ==========================================================================================
# The rename case: an `aws_lambda_function "ingest"` would leave the gate with
# nothing to read, and "nothing to read" must not resolve to "nothing wrong".
begin "a renamed resource exits 2, not 0"
fixture renamed 300 300_000
must perl -pi -e 's/"ingestion" \{$/"ingest" {/' "$DIR/$TF_REL"
fixture_has "$DIR/$TF_REL" 'resource "aws_lambda_function" "ingest" {'
run_check "$DIR"
expect_rc 2 "$rc"
expect_out 'declares no resource "aws_lambda_function" "ingestion"'
end

# ==========================================================================================
# 16. either file missing at the declared path
# ==========================================================================================
begin "a mirrored file that has moved exits 2, not 0"
for missing in "$TF_REL" "$TS_REL"; do
  case_ctx="missing $missing"
  fixture moved_file 300 300_000
  must rm "$DIR/$missing"
  for interpreter in $BASHES; do
    run_check_with "$interpreter" "$DIR"
    expect_rc 2 "$rc"
    expect_out "no such file: $missing"
    expect_not_out "unbound variable"
  done
done
case_ctx=""
end

# ==========================================================================================
# 17. a root that is not there at all
# ==========================================================================================
begin "a nonexistent root exits 2, not 1"
run_check "$TMP_ROOT/does-not-exist"
expect_rc 2 "$rc"
expect_out "not a directory"
end

# ==========================================================================================
# 18. sub-block addressing reads the declared path, not the same name elsewhere
# ==========================================================================================
# #133's addressing case, and the reason the record names a path rather than an
# attribute. The stage block declares `throttling_rate_limit` twice: 10 inside
# `default_route_settings`, and 2 inside `dynamic "route_settings" { content { … } }`
# — different depths, different paths, and a genuine difference in meaning (the
# second governs three write routes). Reporting 2 here would hold the fan-out
# against the wrong ceiling and pass, which is the quiet kind of wrong.
begin "the addressed sub-block's attribute is read, not the dynamic block's"
fixture sub_block 300 300_000
run_check "$DIR"
expect_rc 0 "$rc"
expect_out "default_route_settings.throttling_rate_limit = 10"
expect_not_out "throttling_rate_limit = 2"
end

# ==========================================================================================
# 19. the strict bound is strict, at exactly the edge
# ==========================================================================================
# The whole content of `ts-lt` as opposed to a `<=` relation, and the case that
# kills the mutant relaxing it: lowering the stage throttle to the fan-out's own
# value is the client provisioned to spend the entire bucket, which is the state
# the record exists to forbid. One below is fine; equal is not.
begin "a stage throttle lowered to the fan-out's own value fails the strict bound"
fixture ts_lt_edge 300 300_000
must perl -pi -e 's/^    throttling_rate_limit  = 10$/    throttling_rate_limit  = 8/' "$DIR/$GATEWAY_REL"
fixture_has "$DIR/$GATEWAY_REL" '    throttling_rate_limit  = 8'
fixture_lacks "$DIR/$GATEWAY_REL" '    throttling_rate_limit  = 10'
run_check "$DIR"
expect_rc 1 "$rc"
expect_out "FLEET_FANOUT_LAUNCHES_PER_SECOND = 8, which is not strictly under 8 * 1 = 8"
expect_not_out "check-infra-mirrors: OK"
end

# ==========================================================================================
# 20. one table's TTL attribute renamed — and only that table's record goes red
# ==========================================================================================
# Three records share one TypeScript constant, so "the gate went red" is not
# enough: it has to go red on the address that moved and stay silent about the
# two that did not. Case 3 is the positive control — all three green lines
# appear there — so an offender list naming `weather` and never naming `series`
# is per-record block scoping rather than a reader that stopped early.
begin "renaming one table's TTL attribute reds that table's record alone"
fixture ttl_drift 300 300_000
# `\K` rather than a capture group and a backreference: the perl program is
# embedded in a shell single-quoted string, where a `$` is exactly the
# ambiguity a reader (and shellcheck) cannot resolve by looking. Keeping the
# match's prefix with \K needs no `$` at all, so there is nothing to resolve.
must perl -0pi -e 's/resource "aws_dynamodb_table" "weather" \{.*?attribute_name = \K"expiresAt"/"expires"/s' "$DIR/$TABLES_REL"
fixture_has "$DIR/$TABLES_REL" 'attribute_name = "expires"'
run_check "$DIR"
expect_rc 1 "$rc"
expect_out 'ERROR '"$TABLES_REL"'  aws_dynamodb_table.weather.ttl.attribute_name = "expires"'
expect_out "TTL_ATTRIBUTE_NAME = 'expiresAt', which is a different name"
expect_not_out "aws_dynamodb_table.series"
expect_not_out "aws_dynamodb_table.abuse"
end

# ==========================================================================================
# 21. the two validation patterns are compared as text
# ==========================================================================================
# Widening the Terraform pattern to admit an underscore is exactly the edit that
# would let `terraform apply` accept an environment suffix the TypeScript guard
# then rejects — a table created under a name the code refuses to compute.
begin "a widened Terraform validation pattern fails against the constant"
fixture regex_drift 300 300_000
must perl -pi -e 's{\Q^[a-z0-9-]+\E}{^[a-z0-9_-]+}' "$DIR/$VARIABLES_REL"
fixture_has "$DIR/$VARIABLES_REL" 'can(regex("^[a-z0-9_-]+$", var.environment))'
fixture_lacks "$DIR/$VARIABLES_REL" 'can(regex("^[a-z0-9-]+$", var.environment))'
run_check "$DIR"
expect_rc 1 "$rc"
expect_out "which is a different pattern"
expect_not_out "check-infra-mirrors: OK"
end

# ==========================================================================================
# 22. a validation that stopped being a regex is a non-verdict
# ==========================================================================================
# `length(var.environment) > 0` is a legitimate validation and an illegitimate
# comparison: there is no pattern text in it to hold the constant equal to. Exit
# 2, not 1 — the two are not known to disagree, they are unreadable as a pair.
begin "a validation that is not can(regex(...)) is a non-verdict"
fixture regex_shape 300 300_000
must perl -pi -e 's{^    condition     = can\(regex\(.*var\.environment\)\)$}{    condition     = length(var.environment) > 0}' "$DIR/$VARIABLES_REL"
fixture_has "$DIR/$VARIABLES_REL" 'condition     = length(var.environment) > 0'
fixture_lacks "$DIR/$VARIABLES_REL" 'var.environment))'
run_check "$DIR"
expect_rc 2 "$rc"
expect_out "is not a can(regex(...)) validation"
expect_out "BLOCKED"
expect_not_out "check-infra-mirrors: OK"
end

# ==========================================================================================
# 23. the Terraform-to-Terraform floor, breached from the right-hand side
# ==========================================================================================
# ADR 0004's rule, and the edit #12 was warned about in prose: raising the
# consumer's function timeout without raising the queue's visibility timeout
# lets SQS redeliver a message that is still being processed. 300 was six times
# 50; it is not six times 60. This is the case that kills the mutant dropping
# the factor — 300 >= 60 is true and means nothing.
begin "raising the consumer timeout under a fixed visibility timeout breaches the floor"
fixture floor_right 300 300_000
must perl -pi -e 's/^  timeout = 50$/  timeout = 60/' "$DIR/$FORECAST_REL"
fixture_has "$DIR/$FORECAST_REL" '  timeout = 60'
fixture_lacks "$DIR/$FORECAST_REL" '  timeout = 50'
run_check "$DIR"
expect_rc 1 "$rc"
expect_out "aws_sqs_queue.weather_readings.visibility_timeout_seconds = 300"
expect_out "6 x 60 = 360 is the floor this must not go under"
expect_not_out "check-infra-mirrors: OK"
end

# ==========================================================================================
# 24. the same floor, breached from the left-hand side
# ==========================================================================================
# The other direction of the same one-sided edit, and the reason the relation is
# declared rather than inferred: lowering the queue's own number is the easier
# mistake to make, because nothing about that line mentions the consumer.
begin "lowering the visibility timeout under a fixed consumer timeout breaches the floor"
fixture floor_left 300 300_000
must perl -pi -e 's/^  visibility_timeout_seconds = 300$/  visibility_timeout_seconds = 240/' "$DIR/$QUEUE_REL"
fixture_has "$DIR/$QUEUE_REL" '  visibility_timeout_seconds = 240'
fixture_lacks "$DIR/$QUEUE_REL" '  visibility_timeout_seconds = 300'
run_check "$DIR"
expect_rc 1 "$rc"
expect_out "aws_sqs_queue.weather_readings.visibility_timeout_seconds = 240"
expect_out "6 x 50 = 300 is the floor this must not go under"
expect_not_out "check-infra-mirrors: OK"
end

# ==========================================================================================
# 25. an unrecognised mode tag is refused, not ignored
# ==========================================================================================
# The property the record grammar was widened without losing (#133): the reader
# refuses a record it does not understand rather than skipping it, so a mode tag
# somebody invents — or mistypes — cannot become a pair silently unchecked.
# Reached the same way as case 10, by doctoring a copy of the gate.
begin "a record with an unknown mode tag exits 2 rather than skipping the record"
fixture unknown_mode 300 300_000
gate_copy check-infra-mirrors-unknown-mode.sh
must perl -pi -e 's/^  "tf-ge\|/  "weird|/' "$COPY"
fixture_has "$COPY" '  "weird|'
fixture_lacks "$COPY" '  "tf-ge|'
run_script_with bash "$COPY" "$DIR"
expect_rc 2 "$rc"
expect_out "unknown mode 'weird'"
expect_out "BLOCKED"
expect_not_out "check-infra-mirrors: OK"
end

# ==========================================================================================
# 26. a record with the wrong number of fields for its mode is refused
# ==========================================================================================
# The arity half of the same property, and the one the old six-field reader
# already had: a seventh field on an `eq` record is a record whose author meant
# something the reader does not implement, and answering it with a comparison
# over the first six would be inventing a verdict.
begin "an eq record with one field too many exits 2"
fixture wrong_arity 300 300_000
gate_copy check-infra-mirrors-wrong-arity.sh
must perl -pi -e 's/\|INGESTION_LAMBDA_TIMEOUT_MS\|1000"/|INGESTION_LAMBDA_TIMEOUT_MS|1000|9"/' "$COPY"
fixture_has "$COPY" 'INGESTION_LAMBDA_TIMEOUT_MS|1000|9"'
run_script_with bash "$COPY" "$DIR"
expect_rc 2 "$rc"
expect_out "mode 'eq' takes exactly 6 fields after the tag"
expect_out "BLOCKED"
expect_not_out "check-infra-mirrors: OK"
end

# ==========================================================================================
# 27. a wrong field count made of a TRAILING EMPTY field is refused too
# ==========================================================================================
# The hole the arity check had until the #133 review: `str-eq|…|VALUE|` has six
# fields where the mode takes five, but the sixth is empty — and an arity check
# that asked "is there anything beyond the last field?" read that empty string
# and answered no. A record whose author meant a sixth field is a record the
# reader does not implement, whether or not they got as far as typing the value,
# so the count is taken from the separators and this shape refuses like any
# other wrong count. Reached by doctoring a copy of the gate, as cases 10, 25
# and 26 are, because MIRRORS is baked into the script.
begin "a str-eq record with a trailing empty sixth field exits 2"
fixture trailing_field 300 300_000
gate_copy check-infra-mirrors-trailing-field.sh
# \K rather than a capture group, for the reason case 20 states. The `series`
# address is what keeps the edit on ONE of the three str-eq records, so the
# refusal below is about that record rather than about all of them.
must perl -pi -e 's/aws_dynamodb_table\.series\|.*TTL_ATTRIBUTE_NAME\K"/|"/' "$COPY"
fixture_has "$COPY" 'TTL_ATTRIBUTE_NAME|"'
run_script_with bash "$COPY" "$DIR"
expect_rc 2 "$rc"
expect_out "check-infra-mirrors: 1 declared mirror(s) could not be checked"
expect_out "BLOCKED MIRRORS[4]: mode 'str-eq' takes exactly 5 fields after the tag, not 6"
expect_not_out "check-infra-mirrors: OK"
end

# ==========================================================================================
# 28. a backslash in the Terraform string value is refused, not compared
# ==========================================================================================
# The reader does not interpret escape sequences, and HCL and TypeScript do not
# spell them alike — so `"expires\tAt"` is a text this gate cannot honestly say
# is equal or unequal to anything. Exit 2, not 1: without the guard the two
# texts would simply differ and the gate would report drift, which is a verdict
# it has not earned.
begin "a backslash in a Terraform string value is a non-verdict"
fixture tf_string_escape 300 300_000
must perl -0pi -e 's/resource "aws_dynamodb_table" "abuse" \{.*?attribute_name = \K"expiresAt"/"expires\\tAt"/s' "$DIR/$TABLES_REL"
fixture_has "$DIR/$TABLES_REL" 'attribute_name = "expires\tAt"'
run_check "$DIR"
expect_rc 2 "$rc"
expect_out "'aws_dynamodb_table.abuse'.ttl.attribute_name contains a backslash"
expect_out "BLOCKED"
expect_not_out "check-infra-mirrors: OK"
end

# ==========================================================================================
# 29. a backslash in the Terraform validation pattern is refused too
# ==========================================================================================
# The same refusal on the regex side, where it matters more: `[a-z0-9\-]` and
# `[a-z0-9-]` are the same pattern to a regex engine and different texts to a
# string comparison, so a reader that compared them would report drift between
# two validations that admit exactly the same environment names.
begin "a backslash in the Terraform validation pattern is a non-verdict"
fixture tf_regex_escape 300 300_000
must perl -pi -e 's{\Q[a-z0-9-]\E}{[a-z0-9\\-]}' "$DIR/$VARIABLES_REL"
fixture_has "$DIR/$VARIABLES_REL" 'can(regex("^[a-z0-9\-]+$", var.environment))'
fixture_lacks "$DIR/$VARIABLES_REL" 'can(regex("^[a-z0-9-]+$", var.environment))'
run_check "$DIR"
expect_rc 2 "$rc"
expect_out "'variable.environment'.validation.condition has a backslash in its pattern"
expect_out "BLOCKED"
expect_not_out "check-infra-mirrors: OK"
end

# ==========================================================================================
# 30. and a backslash on the TypeScript side of either pair
# ==========================================================================================
# Both TypeScript readers refuse it as well, and asymmetry here would be the
# worst of both: a name or a pattern the gate reads one way on one side and
# another way on the other is exactly the pair it must decline to approve.
begin "a backslash in the TypeScript constant is a non-verdict"
fixture ts_string_escape 300 300_000
must perl -pi -e "s{'expiresAt'}{'expires\\\\tAt'}" "$DIR/$TTL_TS_REL"
fixture_has "$DIR/$TTL_TS_REL" "TTL_ATTRIBUTE_NAME = 'expires\\tAt';"
run_check "$DIR"
expect_rc 2 "$rc"
expect_out "TTL_ATTRIBUTE_NAME contains a backslash"
expect_out "BLOCKED"
expect_not_out "check-infra-mirrors: OK"
end

begin "a backslash in the TypeScript pattern is a non-verdict"
fixture ts_regex_escape 300 300_000
must perl -pi -e 's{\Q[a-z0-9-]\E}{[a-z0-9\\-]}' "$DIR/$TABLE_NAME_TS_REL"
fixture_has "$DIR/$TABLE_NAME_TS_REL" 'ENVIRONMENT_PATTERN = /^[a-z0-9\-]+$/;'
run_check "$DIR"
expect_rc 2 "$rc"
expect_out "ENVIRONMENT_PATTERN has a backslash in its pattern"
expect_out "BLOCKED"
expect_not_out "check-infra-mirrors: OK"
end

# ==========================================================================================
# 31. a flagged regex literal is not the same claim as the HCL validation
# ==========================================================================================
# `/^[a-z0-9-]+$/i` has the same pattern TEXT as the Terraform condition and a
# different meaning: it admits `DEV`, which `terraform apply` would reject. A
# reader that compared the text alone would call that agreement, so the flagged
# literal is not read at all — the constant no longer has the one shape the
# record is about.
begin "a flagged TypeScript regex literal is a non-verdict"
fixture ts_regex_flag 300 300_000
must perl -pi -e 's{ENVIRONMENT_PATTERN = /\^\[a-z0-9-\]\+\$/;}{ENVIRONMENT_PATTERN = /^[a-z0-9-]+\$/i;}' "$DIR/$TABLE_NAME_TS_REL"
fixture_has "$DIR/$TABLE_NAME_TS_REL" 'ENVIRONMENT_PATTERN = /^[a-z0-9-]+$/i;'
run_check "$DIR"
expect_rc 2 "$rc"
expect_out "declares no 'export const ENVIRONMENT_PATTERN = /<pattern>/;'"
expect_out "BLOCKED"
expect_not_out "check-infra-mirrors: OK"
end

# ==========================================================================================

finish
