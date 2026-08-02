#!/usr/bin/env bash
# Test harness for harness-lib.sh, its neighbour in this directory — the assertion vocabulary
# every other *.test.sh here is built on.
#
# The subject is a library of assertions, which cannot be tested the way a gate is: a failing
# assertion calls `bad`, and `bad` reds the case that is running. A harness therefore cannot
# watch its own assertion fail. So each case writes a throwaway CONSUMER script under
# TMP_ROOT — a miniature harness that sources the lib by absolute path — runs it, and asserts
# on the consumer's exit code and output. It is the same move run-script-tests.test.sh makes
# with throwaway harnesses, one level down.
#
# Consumers are named consumer-*.sh, never *.test.sh: run-script-tests.sh discovers by that
# suffix, and a generated file carrying it would be a harness nobody wrote.
#
# ANTI-CIRCULARITY, the rule this file lives by: every assertion about a consumer's EXIT CODE
# is a raw `[ "$rc" = n ] || bad …`, never `expect_rc`. A widened assertion in the lib is
# caught by "the consumer that must exit 1 exits 0"; routing that check through expect_rc
# would let a neutered expect_rc blind the very case meant to catch it. Assertions about a
# consumer's *output* do go through the lib's own expect_stdout/expect_stderr — a widened one
# of those blinds the message check, but never the raw exit check that kills the mutant.
#
# Usage: bash .claude/scripts/harness-lib.test.sh   (or `pnpm test:scripts`)
# Exit:  0 every case PASS, 1 at least one FAIL, 2 the harness itself broke.
set -uo pipefail

SCRIPTS=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd) || exit 2
LIB="$SCRIPTS/harness-lib.sh"

# shellcheck source=./harness-lib.sh
. "$LIB"

harness_init_tmp

CONSUMER=""

# --- fixtures -------------------------------------------------------------------------------

# consumer <name>   (body on stdin) -> writes $TMP_ROOT/consumer-<name>.sh, sets CONSUMER.
# The preamble sources the lib by interpolated absolute path; the body arrives verbatim from a
# quoted heredoc, so it reads exactly as a real harness would write it — starting with its own
# `harness_init_tmp`, which the consumers that must run *without* a temp tree simply omit.
consumer() { # consumer <name>
  CONSUMER="$TMP_ROOT/consumer-$1.sh"
  {
    printf '#!/usr/bin/env bash\n'
    printf 'set -uo pipefail\n'
    printf '. "%s"\n' "$LIB"
    cat
  } >"$CONSUMER"
}

run_consumer() {
  capture bash "$CONSUMER"
}

# expect_consumer_caught <assertion> — the verdict every violated-assertion case ends on: the
# consumer failed with the convention's exit 1, printed PASS for the satisfied case and FAIL
# for the violated one, and `bad` explained itself on stderr. The exit check is raw, per the
# anti-circularity rule in the header.
expect_consumer_caught() { # expect_consumer_caught <assertion>
  [ "$rc" = "1" ] || bad "consumer exit: expected 1, got $rc"
  expect_stdout "PASS good-$1"
  expect_stdout "FAIL bad-$1"
  expect_stderr "  ! "
}

# ==========================================================================================
# 1. the library parses
# ==========================================================================================
begin "harness-lib.sh parses under every bash on the box"
expect_parses "$LIB"
end

# ==========================================================================================
# 2. sourced, never executed
# ==========================================================================================
# The guard worktree-lib.sh set the pattern for. Running a library is a mistake that would
# otherwise be silent: the counters would initialise, no case would run, and the shell would
# exit 0 having done nothing.
begin "running harness-lib.sh instead of sourcing it exits 2 and says so"
capture bash "$LIB"
[ "$rc" = "2" ] || bad "exit code: expected 2, got $rc"
expect_stderr "harness-lib.sh is a sourced library, not an executable script"
expect_not_stdout "passed"
end

# ==========================================================================================
# 3. every assertion bites — one satisfied case and one violated case per function
# ==========================================================================================
# These eight cases are the mutation controls made permanent: replace any of the eight bodies
# with `:` and its consumer stops failing, so the raw exit check below goes red by name.

begin "expect_rc catches a wrong exit code"
must consumer expect_rc <<'BODY'
harness_init_tmp
begin "good-expect_rc"
capture bash -c 'exit 3'
expect_rc 3 "$rc"
end
begin "bad-expect_rc"
capture true
expect_rc 3 "$rc"
end
finish
BODY
run_consumer
expect_consumer_caught expect_rc
expect_stderr "exit code: expected 3, got 0"
end

begin "expect_out catches a missing substring"
must consumer expect_out <<'BODY'
harness_init_tmp
begin "good-expect_out"
capture bash -c 'printf "on stderr\n" >&2'
expect_out "on stderr"
end
begin "bad-expect_out"
capture bash -c 'printf "on stderr\n" >&2'
expect_out "never printed"
end
finish
BODY
run_consumer
expect_consumer_caught expect_out
expect_stderr "output missing 'never printed'"
end

begin "expect_not_out catches a substring that should be absent"
must consumer expect_not_out <<'BODY'
harness_init_tmp
begin "good-expect_not_out"
capture bash -c 'printf "on stderr\n" >&2'
expect_not_out "never printed"
end
begin "bad-expect_not_out"
capture bash -c 'printf "on stderr\n" >&2'
expect_not_out "on stderr"
end
finish
BODY
run_consumer
expect_consumer_caught expect_not_out
expect_stderr "output should not contain 'on stderr'"
end

begin "expect_stdout catches a missing substring"
must consumer expect_stdout <<'BODY'
harness_init_tmp
begin "good-expect_stdout"
capture bash -c 'printf "on stdout\n"'
expect_stdout "on stdout"
end
begin "bad-expect_stdout"
capture bash -c 'printf "on stdout\n"'
expect_stdout "never printed"
end
finish
BODY
run_consumer
expect_consumer_caught expect_stdout
expect_stderr "stdout missing 'never printed'"
end

begin "expect_not_stdout catches a substring that should be absent from stdout"
must consumer expect_not_stdout <<'BODY'
harness_init_tmp
begin "good-expect_not_stdout"
capture bash -c 'printf "on stdout\n"'
expect_not_stdout "never printed"
end
begin "bad-expect_not_stdout"
capture bash -c 'printf "on stdout\n"'
expect_not_stdout "on stdout"
end
finish
BODY
run_consumer
expect_consumer_caught expect_not_stdout
expect_stderr "stdout should not contain 'on stdout'"
end

begin "expect_stderr catches a missing substring"
must consumer expect_stderr <<'BODY'
harness_init_tmp
begin "good-expect_stderr"
capture bash -c 'printf "on stderr\n" >&2'
expect_stderr "on stderr"
end
begin "bad-expect_stderr"
capture bash -c 'printf "on stderr\n" >&2'
expect_stderr "never printed"
end
finish
BODY
run_consumer
expect_consumer_caught expect_stderr
expect_stderr "stderr missing 'never printed'"
end

begin "expect_not_stderr catches a substring that should be absent from stderr"
must consumer expect_not_stderr <<'BODY'
harness_init_tmp
begin "good-expect_not_stderr"
capture bash -c 'printf "on stderr\n" >&2'
expect_not_stderr "never printed"
end
begin "bad-expect_not_stderr"
capture bash -c 'printf "on stderr\n" >&2'
expect_not_stderr "on stderr"
end
finish
BODY
run_consumer
expect_consumer_caught expect_not_stderr
expect_stderr "stderr should not contain 'on stderr'"
end

begin "expect_silent catches output on either stream"
must consumer expect_silent <<'BODY'
harness_init_tmp
begin "good-expect_silent"
capture true
expect_silent
end
begin "bad-expect_silent"
capture bash -c 'printf "noise\n"; printf "more noise\n" >&2'
expect_silent
end
finish
BODY
run_consumer
expect_consumer_caught expect_silent
expect_stderr "expected no stdout; got: noise"
expect_stderr "expected no stderr; got: more noise"
end

# ==========================================================================================
# 4. ACCEPTANCE: the streams are separate, which is the whole point of the library
# ==========================================================================================
# The `out=$(… 2>&1)` the twelve harnesses shared could not tell these four cases apart: all
# four would have passed, and "the report goes to stderr" would have stayed unassertable.
begin "stdout and stderr are asserted separately, not as one merged stream"
must consumer streams <<'BODY'
harness_init_tmp
begin "good-stdout-has-A"
capture bash -c 'printf "A\n"; printf "B\n" >&2'
expect_stdout "A"
end
begin "good-stderr-has-B"
capture bash -c 'printf "A\n"; printf "B\n" >&2'
expect_stderr "B"
end
begin "bad-stdout-has-B"
capture bash -c 'printf "A\n"; printf "B\n" >&2'
expect_stdout "B"
end
begin "bad-stderr-has-A"
capture bash -c 'printf "A\n"; printf "B\n" >&2'
expect_stderr "A"
end
begin "good-either-stream-has-both"
capture bash -c 'printf "A\n"; printf "B\n" >&2'
expect_out "A"
expect_out "B"
end
finish
BODY
run_consumer
[ "$rc" = "1" ] || bad "consumer exit: expected 1, got $rc"
expect_stdout "PASS good-stdout-has-A"
expect_stdout "PASS good-stderr-has-B"
expect_stdout "FAIL bad-stdout-has-B"
expect_stdout "FAIL bad-stderr-has-A"
expect_stdout "PASS good-either-stream-has-both"
expect_stdout "3 passed, 2 failed"
end

# ==========================================================================================
# 5. capture -C
# ==========================================================================================
begin "capture -C runs the command in the given directory, and without it does not"
must consumer capture_dir <<'BODY'
harness_init_tmp
must mkdir -p "$TMP_ROOT/elsewhere"
begin "good-capture-C-cds"
capture -C "$TMP_ROOT/elsewhere" pwd
expect_rc 0 "$rc"
expect_stdout "$TMP_ROOT/elsewhere"
end
begin "good-capture-without-C-stays-put"
capture pwd
expect_not_stdout "$TMP_ROOT/elsewhere"
end
finish
BODY
run_consumer
[ "$rc" = "0" ] || bad "consumer exit: expected 0, got $rc"
expect_stdout "PASS good-capture-C-cds"
expect_stdout "PASS good-capture-without-C-stays-put"
expect_stdout "2 passed, 0 failed"
end

begin "capture before harness_init_tmp is FATAL, not a silent empty capture"
must consumer capture_no_tmp <<'BODY'
begin "no-temp-tree"
capture true
end
finish
BODY
run_consumer
[ "$rc" = "2" ] || bad "consumer exit: expected 2, got $rc"
expect_stderr "FATAL capture called before harness_init_tmp"
expect_not_stdout "passed"
end

# ==========================================================================================
# 6. finish — the exit convention run-script-tests.sh aggregates on
# ==========================================================================================
begin "a consumer whose cases all pass exits 0 and reports the count"
must consumer finish_green <<'BODY'
harness_init_tmp
begin "one"
capture true
expect_rc 0 "$rc"
end
begin "two"
capture true
expect_silent
end
finish
BODY
run_consumer
[ "$rc" = "0" ] || bad "consumer exit: expected 0, got $rc"
expect_stdout "2 passed, 0 failed"
expect_stdout "PASS one"
expect_stdout "PASS two"
end

begin "a consumer with a failed case exits 1 and reports the count"
must consumer finish_red <<'BODY'
harness_init_tmp
begin "one"
capture true
expect_rc 0 "$rc"
end
begin "two"
capture true
expect_stdout "never printed"
end
finish
BODY
run_consumer
[ "$rc" = "1" ] || bad "consumer exit: expected 1, got $rc"
expect_stdout "1 passed, 1 failed"
expect_stdout "FAIL two"
end

# A harness that ran nothing is indistinguishable from a harness that passed, so finish
# refuses it — the same reasoning lint-shell.sh and run-script-tests.sh apply to an empty
# discovery. Exit 2 (harness broke), not 0.
begin "a consumer that ran no cases exits 2 rather than reporting green"
must consumer finish_empty <<'BODY'
harness_init_tmp
finish
BODY
run_consumer
[ "$rc" = "2" ] || bad "consumer exit: expected 2, got $rc"
expect_stdout "0 passed, 0 failed"
expect_stderr "green by absence is not green"
end

# ==========================================================================================
# 7. fixture_has / fixture_lacks — FATAL, because a fixture that is not as described makes
#    the case meaningless rather than failed
# ==========================================================================================
begin "fixture_has is FATAL when the text the edit should have added is missing"
must consumer fixture_has <<'BODY'
harness_init_tmp
printf 'alpha\n' >"$TMP_ROOT/fixture.txt" || exit 2
begin "good-both-assertions-hold"
fixture_has "$TMP_ROOT/fixture.txt" "alpha"
fixture_lacks "$TMP_ROOT/fixture.txt" "omega"
end
begin "bad-fixture_has"
fixture_has "$TMP_ROOT/fixture.txt" "omega"
end
finish
BODY
run_consumer
[ "$rc" = "2" ] || bad "consumer exit: expected 2, got $rc"
expect_stdout "PASS good-both-assertions-hold"
expect_stderr "FATAL fixture edit did not land: omega is not in"
expect_not_stdout "passed,"
end

begin "fixture_lacks is FATAL when the text the edit should have removed is still there"
must consumer fixture_lacks <<'BODY'
harness_init_tmp
printf 'alpha\n' >"$TMP_ROOT/fixture.txt" || exit 2
begin "bad-fixture_lacks"
fixture_lacks "$TMP_ROOT/fixture.txt" "alpha"
end
finish
BODY
run_consumer
[ "$rc" = "2" ] || bad "consumer exit: expected 2, got $rc"
expect_stderr "FATAL fixture edit did not land: alpha is still in"
end

# ==========================================================================================
# 8. must — setup failure is not a case failure
# ==========================================================================================
begin "must on a failing command exits 2 with FATAL, without reporting a case"
must consumer must_fatal <<'BODY'
harness_init_tmp
begin "setup"
must false
end
finish
BODY
run_consumer
[ "$rc" = "2" ] || bad "consumer exit: expected 2, got $rc"
expect_stderr "FATAL harness setup failed: false"
expect_not_stdout "PASS setup"
expect_not_stdout "FAIL setup"
end

# ==========================================================================================

finish
