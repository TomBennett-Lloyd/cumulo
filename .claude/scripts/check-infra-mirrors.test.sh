#!/usr/bin/env bash
# Test harness for check-infra-mirrors.sh, its neighbour in this directory.
#
# Self-contained on purpose (same shape as check-module-names.test.sh next door):
# no test framework, no network, no pnpm, no terraform. Every fixture is a
# throwaway tree under a single `mktemp -d` that a trap deletes on exit, laid out
# at the exact repo-relative paths the gate's MIRRORS list names — which is what
# lets the shipped record be exercised against doctored values without ever
# putting a drifted value in this repo.
#
# The two red cases below ARE the point of the gate, committed rather than run
# once by hand (testing.md rule 4): a Terraform-only change and a
# TypeScript-only change must each go red, in both directions of the number.
# A gate whose failure path nobody exercises is indistinguishable from a gate
# that cannot fail, and this one's whole job is to fail on an edit that is
# trivially easy to make.
#
# One case deliberately runs the gate with NO argument, against the real repo:
# every other case pins REPO_ROOT to a fixture, so without it the shipped
# default path — and the shipped MIRRORS record's own paths — could be broken
# and the suite would still be green (testing.md rule 7).
#
# Usage: bash .claude/scripts/check-infra-mirrors.test.sh   (or `pnpm test:scripts`)
# Exit:  0 every case PASS, 1 at least one FAIL, 2 the harness itself broke.
set -uo pipefail

SCRIPTS=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd) || exit 2
CHECK="$SCRIPTS/check-infra-mirrors.sh"

tmp_raw=$(mktemp -d) || exit 2
trap 'rm -rf "$tmp_raw"' EXIT INT TERM
TMP_ROOT=$(cd "$tmp_raw" && pwd -P) || exit 2

passed=0
failed=0
case_name=""
case_failed=0
case_ctx=""
out=""
rc=0

# The gate has to survive the oldest bash it can meet, and the interpreter is not
# a detail: under `set -u`, bash 3.2 (which macOS ships as /bin/bash) aborts where
# 4.4+ shrugs. This gate builds arrays and uses `[[ =~ ]]` with interpolated
# patterns, both of which differ across those versions, so the cases that exercise
# them run under every distinct bash on the box.
BASHES="bash"
if [ -x /bin/bash ] && [ "$(command -v bash)" != "/bin/bash" ]; then
  BASHES="$BASHES /bin/bash"
fi

# --- harness plumbing --------------------------------------------------------------------

must() {
  "$@" || {
    printf 'FATAL harness setup failed: %s\n' "$*" >&2
    exit 2
  }
}

begin() {
  case_name="$1"
  case_failed=0
  case_ctx=""
}

end() {
  if [ "$case_failed" = "0" ]; then
    printf 'PASS %s\n' "$case_name"
    passed=$((passed + 1))
  else
    printf 'FAIL %s\n' "$case_name"
    failed=$((failed + 1))
  fi
}

# case_ctx names the variant a failure came from, for cases that run the gate more than once.
bad() {
  printf '  ! %s%s\n' "$1" "${case_ctx:+ (under $case_ctx)}" >&2
  case_failed=1
}

expect_rc() { # expect_rc <expected> <actual>
  [ "$1" = "$2" ] || bad "exit code: expected $1, got $2"
}

expect_out() { # expect_out <substring>
  case "$out" in
    *"$1"*) ;;
    *) bad "output missing '$1'; got: $out" ;;
  esac
}

expect_not_out() { # expect_not_out <substring>
  case "$out" in
    *"$1"*) bad "output should not contain '$1'; got: $out" ;;
  esac
}

# --- fixtures ----------------------------------------------------------------------------

# The paths and names the shipped MIRRORS record points at. Restated here rather
# than parsed out of the gate: a fixture generated from the same record it is
# meant to test would follow a typo in that record into agreement with it.
TF_REL=infra/ingestion/lambda.tf
TS_REL=apps/ingestion/src/cycle-budget.ts

# fixture <name> <tf-timeout-seconds> <ts-literal> -> sets DIR to a fresh tree
# holding exactly the two files the gate reads. The Terraform file is written in
# `terraform fmt` layout, which is the layout CI enforces and the gate's reader
# assumes: two-space attributes, a lone `}` at column 0.
fixture() { # fixture <name> <tf-timeout> <ts-literal>
  DIR="$TMP_ROOT/$1"
  must mkdir -p "$DIR/$(dirname "$TF_REL")" "$DIR/$(dirname "$TS_REL")"
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

# `perl -pi` exits 0 whether or not it substituted anything, so every fixture
# edit below is followed by an assertion that it landed. A setup that silently
# no-opped would leave the case running against the unedited fixture and passing
# for the wrong reason — the harness's own version of the green-by-absence the
# gate refuses.
fixture_has() { # fixture_has <file> <fixed-string>
  grep -qF -- "$2" "$1" || {
    printf 'FATAL fixture edit did not land: %s is not in %s\n' "$2" "$1" >&2
    exit 2
  }
}

fixture_lacks() { # fixture_lacks <file> <fixed-string>
  if grep -qF -- "$2" "$1"; then
    printf 'FATAL fixture edit did not land: %s is still in %s\n' "$2" "$1" >&2
    exit 2
  fi
}

run_check_with() { # run_check_with <bash> <args...>
  local interpreter="$1"
  shift
  out=$("$interpreter" "$CHECK" "$@" 2>&1)
  rc=$?
}

run_check() { # run_check <args...>
  run_check_with bash "$@"
}

# ==========================================================================================
# 1. the gate parses
# ==========================================================================================
begin "check-infra-mirrors.sh parses (bash -n)"
for interpreter in $BASHES; do
  case_ctx="$interpreter"
  if ! syntax=$("$interpreter" -n "$CHECK" 2>&1); then
    bad "check-infra-mirrors.sh failed -n: $syntax"
  fi
done
case_ctx=""
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
# 3. a fixture whose two sides agree
# ==========================================================================================
begin "a tree whose constant matches the Terraform value passes"
fixture agree 300 300_000
run_check "$DIR"
expect_rc 0 "$rc"
expect_out "OK — 1 mirrored value(s) agree"
expect_out "aws_lambda_function.ingestion.timeout = 300"
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
expect_out "out of step with Terraform"
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
expect_out "OK"
end

# ==========================================================================================
# 9. the attribute is read from ITS resource, not the file
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
expect_not_out "900"
end

# ==========================================================================================
# 10. an attribute nested in a sub-block is not the resource's own
# ==========================================================================================
# The four-space case. `timeout` inside `environment { … }` belongs to that block;
# reading it as the function's would be a comparison against a value AWS never
# sees. Removing the resource's real timeout as well is what makes the failure
# unambiguous: the gate must say "no top-level timeout", not quietly use the
# nested one.
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
# 11. a Terraform value that stopped being a plain number
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
# 12. a constant that stopped being an exported integer literal
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
# 13. the resource itself is gone or renamed
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
# 14. either file missing at the declared path
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
# 15. a root that is not there at all
# ==========================================================================================
begin "a nonexistent root exits 2, not 1"
run_check "$TMP_ROOT/does-not-exist"
expect_rc 2 "$rc"
expect_out "not a directory"
end

# ==========================================================================================

printf '\n%d passed, %d failed\n' "$passed" "$failed"
[ "$failed" = "0" ] || exit 1
