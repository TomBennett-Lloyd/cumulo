#!/usr/bin/env bash
# The assertion vocabulary shared by the *.test.sh harnesses in this directory.
# Sourced, never executed.
#
# Twelve harnesses each carried a private copy of must/begin/end/bad/expect_* and of the
# `%d passed, %d failed` footer. Twelve copies kept in sync by hand is how a stream contract
# stops being assertable: every copy captured `out=$(… 2>&1)`, so "the report goes to stderr"
# was a claim no harness could make (#157). Only vocabulary with more than one consumer lives
# here; a helper with a single consumer stays in its own harness (docs/standards/structure.md
# rule 7).
#
# The shape a consuming harness takes:
#
#   SCRIPTS=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd) || exit 2
#   # shellcheck source=./harness-lib.sh
#   . "$SCRIPTS/harness-lib.sh"
#   harness_init_tmp
#   …cases…
#   finish
#
# The `# shellcheck source=./harness-lib.sh` directive is not optional decoration: lint-shell.sh
# runs shellcheck with --external-sources --source-path=SCRIPTDIR, and the directive is what
# makes the relative path resolve from the script's own directory rather than the repo root.
#
# Exit convention, which run-script-tests.sh aggregates on: 0 every case PASS, 1 at least one
# FAIL, 2 the harness itself broke. `finish` is what states it.
#
# Its own harness is harness-lib.test.sh next door: consumers generated under a temp tree,
# run, and asserted on — including a deliberately violated case per assertion, so a widened
# assertion is a red case rather than a quieter suite.
set -u
export PATH="/opt/homebrew/bin:$PATH"

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  echo "harness-lib.sh is a sourced library, not an executable script" >&2
  exit 2
fi

# Counters and the last-capture slots, initialised at source time: under `set -u` a harness
# whose first assertion runs before its first `capture` must read an empty slot, not abort.
passed=0
failed=0
case_name=""
case_failed=0
case_ctx=""
out=""
err=""
rc=0

# A gate has to survive the oldest bash it can meet, and the interpreter is not a detail:
# under `set -u`, bash 3.2 (which macOS ships as /bin/bash) aborts on an empty array's `[@]`
# where 4.4+ shrugs. So cases that turn on that difference run under every distinct bash on
# the box, not just whichever one happens to be first on PATH. `expect_parses` is the lib's
# own consumer of this list.
BASHES="bash"
if [ -x /bin/bash ] && [ "$(command -v bash)" != "/bin/bash" ]; then
  BASHES="$BASHES /bin/bash"
fi

# --- temp tree ----------------------------------------------------------------------------

# harness_extra_cleanup — the override point for a harness with more to tear down than its
# temp tree (worktree-lifecycle.test.sh redefines it to kill the background pids it spawns).
# Redefine it after sourcing this file; harness_init_tmp's trap calls whatever definition is
# current when the trap fires, so the ordering of the redefinition and the trap does not
# matter, only that the redefinition has happened before the harness exits.
harness_extra_cleanup() { :; }

# harness_init_tmp -> TMP_ROOT, a fresh temp tree that a trap removes on exit.
#
# TMP_ROOT is the canonical path (`cd && pwd -P`), never mktemp's raw answer: macOS hands out
# /var/folders/… which is really /private/var/folders/…, so a fixture path compared as a
# string against a path the script under test resolved would never match. The trap removes
# the raw path — the same directory under its other name.
harness_init_tmp() {
  tmp_raw=$(mktemp -d) || exit 2
  TMP_ROOT=$(cd "$tmp_raw" && pwd -P) || exit 2
  trap 'harness_extra_cleanup; rm -rf "$tmp_raw"' EXIT INT TERM
}

# --- plumbing -----------------------------------------------------------------------------

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

# case_ctx names the variant a failure came from, for cases that run the subject more than once.
bad() {
  printf '  ! %s%s\n' "$1" "${case_ctx:+ (under $case_ctx)}" >&2
  case_failed=1
}

# --- running the subject --------------------------------------------------------------------

# capture [-C <dir>] <cmd> [args...] -> sets rc, out, err from one run of <cmd>.
# The one primitive every harness's run wrappers are built on; -C runs the command in <dir>
# (in a subshell, so the harness's own working directory is untouched).
#
# Two rules the streams depend on:
#
#   - stdin is INHERITED. Feed a command its input by redirecting into the capture call
#     itself: `capture bash "$HOOK" <"$TMP_ROOT/event.json"`.
#   - NEVER pipe into capture. `printf … | capture bash "$HOOK"` runs capture in a subshell,
#     so rc/out/err are assigned in a process that exits immediately and the caller reads the
#     values from the previous run. Redirect from a file instead — that is what the first
#     rule is for.
capture() {
  local dir="" outf errf
  if [ "${1:-}" = "-C" ]; then
    dir="$2"
    shift 2
  fi
  if [ -z "${TMP_ROOT:-}" ]; then
    printf 'FATAL capture called before harness_init_tmp — there is no TMP_ROOT to spool the streams to\n' >&2
    exit 2
  fi
  outf="$TMP_ROOT/.capture.out"
  errf="$TMP_ROOT/.capture.err"
  if [ -n "$dir" ]; then
    (cd "$dir" && "$@") >"$outf" 2>"$errf"
  else
    "$@" >"$outf" 2>"$errf"
  fi
  rc=$?
  out=$(cat "$outf")
  err=$(cat "$errf")
}

# --- assertions ------------------------------------------------------------------------------

expect_rc() { # expect_rc <expected> [actual]   (actual defaults to $rc, set by capture)
  # The optional second argument is not sugar: every contracted call form stays exactly as the
  # twelve harnesses write it (`expect_rc 1 "$rc"`), and reading $rc here is what makes the
  # global a read as well as a write inside the library. A strictly two-argument version leaves
  # capture's `rc=$?` write-only, which is SC2034 and reds lint:sh — and a disable directive to
  # quiet it is itself a lint error (CLAUDE.md).
  local actual="${2-$rc}"
  [ "$1" = "$actual" ] || bad "exit code: expected $1, got $actual"
}

expect_stdout() { # expect_stdout <substring>
  case "$out" in
    *"$1"*) ;;
    *) bad "stdout missing '$1'; got: $out" ;;
  esac
}

expect_not_stdout() { # expect_not_stdout <substring>
  case "$out" in
    *"$1"*) bad "stdout should not contain '$1'; got: $out" ;;
  esac
}

expect_stderr() { # expect_stderr <substring>
  case "$err" in
    *"$1"*) ;;
    *) bad "stderr missing '$1'; got: $err" ;;
  esac
}

expect_not_stderr() { # expect_not_stderr <substring>
  case "$err" in
    *"$1"*) bad "stderr should not contain '$1'; got: $err" ;;
  esac
}

# expect_out / expect_not_out assert over EITHER stream. Reach for expect_stdout/expect_stderr
# when the stream is part of the contract under test — these two are for the cases where the
# harness only cares that the subject said something.
expect_out() { # expect_out <substring>
  local both="$out"$'\n'"$err"
  case "$both" in
    *"$1"*) ;;
    *) bad "output missing '$1'; got: $both" ;;
  esac
}

expect_not_out() { # expect_not_out <substring>
  local both="$out"$'\n'"$err"
  case "$both" in
    *"$1"*) bad "output should not contain '$1'; got: $both" ;;
  esac
}

expect_silent() { # expect_silent — the subject wrote to neither stream
  [ -z "$out" ] || bad "expected no stdout; got: $out"
  [ -z "$err" ] || bad "expected no stderr; got: $err"
}

# expect_parses <script> — the script is syntactically valid under every bash on the box.
# Runs its own interpreter loop rather than going through capture: the point is the parse,
# and -n produces nothing on stdout worth spooling.
expect_parses() { # expect_parses <script>
  local interpreter syntax
  for interpreter in $BASHES; do
    case_ctx="$interpreter"
    if ! syntax=$("$interpreter" -n "$1" 2>&1); then
      bad "failed bash -n: $syntax"
    fi
  done
  case_ctx=""
}

# --- fixture edits ------------------------------------------------------------------------

# The ratified family idiom for a fixture that starts consistent and has exactly one thing
# broken in it: build it whole, then edit it in place with `must perl -pi -e … "$file"`.
#
# `perl -pi` exits 0 whether or not it substituted anything, so `must` cannot tell a landed
# edit from a silent no-op — a renamed fixture field or a retuned regex would leave the case
# running against the UNEDITED fixture and passing for the wrong reason, which is the
# harness's own version of the green-by-absence the gates refuse. Every such edit is
# therefore followed by fixture_has/fixture_lacks. Both are FATAL, not `bad`: a fixture that
# did not come out as described makes the case meaningless, not failed.
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

# --- verdict ---------------------------------------------------------------------------------

# finish — the footer every harness ends on, and the whole of the exit convention.
#
# The zero-case guard is the same principle lint-shell.sh and run-script-tests.sh apply to
# their own discovery: a harness that ran nothing is indistinguishable from a harness that
# passed, so it is refused outright rather than reported as green.
finish() {
  printf '\n%d passed, %d failed\n' "$passed" "$failed"
  if [ "$((passed + failed))" -eq 0 ]; then
    printf 'harness ran no cases — green by absence is not green\n' >&2
    exit 2
  fi
  [ "$failed" = "0" ] || exit 1
}
