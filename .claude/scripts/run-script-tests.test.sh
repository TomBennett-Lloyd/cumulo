#!/usr/bin/env bash
# Test harness for run-script-tests.sh, its neighbour in this directory — the
# runner behind `pnpm test:scripts`.
#
# Self-contained on the same terms as check-module-names.test.sh next door: no
# framework, no network, no pnpm, one `mktemp -d` that a trap removes. Every
# case that actually *runs* the runner points it at a throwaway fixture
# directory holding throwaway harnesses, so this file can exercise the red paths
# (a harness that exits 1, a harness that exits 2) without a red harness ever
# existing in this repo.
#
# On self-reference: this file matches the runner's own `*.test.sh` discovery
# pattern and is run by it, unskipped — a skip list would be exactly the
# hand-enumeration the runner exists to delete. Recursion is avoided
# structurally, in three layers:
#   - every executing case targets a fixture directory, never the real one;
#   - the one case covering the shipped default target uses `--list`, which
#     discovers without executing;
#   - the runner refuses a target directory an enclosing invocation is already
#     running, and the case below proves it (with its own depth belt, so a
#     broken guard fails this suite instead of hanging it).
# The shipped default *execution* path is not simulated here because it is not
# simulable: it is what `pnpm test:scripts` runs inside `pnpm verify`, so it
# cannot be green by absence (testing.md rule 7).
#
# Usage: bash .claude/scripts/run-script-tests.test.sh   (or `pnpm test:scripts`)
# Exit:  0 every case PASS, 1 at least one FAIL, 2 the harness itself broke.
set -uo pipefail

SCRIPTS=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd) || exit 2

# The runner under test, overridable so the same cases can be pointed at a stand-in as a
# negative control (testing.md rule 4: a regression test is only worth its line count if it
# has been seen to fail on the pre-fix code). The pre-fix code here was a package.json
# `bash a.test.sh && bash b.test.sh && …` string, so the stand-in is a script of that shape:
#
#   SCRIPT_TEST_RUNNER=/tmp/and-chain.sh bash .claude/scripts/run-script-tests.test.sh
#
# Unset — how `pnpm test:scripts` runs it — is the shipped runner.
RUNNER=${SCRIPT_TEST_RUNNER:-$SCRIPTS/run-script-tests.sh}

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
DIR=""

# The runner has to survive the oldest bash it can meet: macOS ships bash 3.2 as
# /bin/bash, where an empty array expanded under `set -u` aborts outright while
# 4.4+ shrugs. The runner builds exactly that kind of array, so the cases that
# exercise it run under every distinct bash on the box.
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

# case_ctx names the variant a failure came from, for cases that run the runner more than once.
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
    *"$1"*) bad "output should not contain '$1'" ;;
  esac
}

# The ordering assertion is the whole point of case 4: `&&`-chaining could satisfy every
# other assertion about a failing harness, but never this one.
expect_order() { # expect_order <earlier substring> <later substring>
  expect_out "$1"
  expect_out "$2"
  local before=${out%%"$2"*}
  case "$before" in
    *"$1"*) ;;
    *) bad "expected '$1' to appear before '$2'" ;;
  esac
}

# --- fixtures ----------------------------------------------------------------------------

# fixture <name> -> sets DIR to a fresh empty directory under TMP_ROOT.
fixture() {
  DIR="$TMP_ROOT/$1"
  must rm -rf "$DIR"
  must mkdir -p "$DIR"
}

# harness <path> <exit code> -> a throwaway harness that announces itself and exits as told.
# The announcement is what makes execution (and its ordering) observable in the runner's
# streamed output.
harness() {
  local name
  name=$(basename "$1")
  mkdir -p "$(dirname "$1")" || return 1
  cat >"$1" <<EOF
#!/usr/bin/env bash
printf '%s\n' "ran $name"
exit $2
EOF
}

run_runner_with() { # run_runner_with <bash> <args...>
  local interpreter="$1"
  shift
  out=$("$interpreter" "$RUNNER" "$@" 2>&1)
  rc=$?
}

run_runner() { # run_runner <args...>
  run_runner_with bash "$@"
}

# ==========================================================================================
# 1. the runner parses
# ==========================================================================================
begin "run-script-tests.sh parses (bash -n)"
for interpreter in $BASHES; do
  case_ctx="$interpreter"
  if ! syntax=$("$interpreter" -n "$RUNNER" 2>&1); then
    bad "run-script-tests.sh failed -n: $syntax"
  fi
done
case_ctx=""
end

# ==========================================================================================
# 2. ACCEPTANCE (c): the shipped default target discovers the real harnesses
# ==========================================================================================
# No directory argument — the production configuration, and the only case that can catch a
# broken default path. `--list` rather than a run: discovery is what is under test here, and
# executing the real suite from inside a member of it is the recursion this file must not
# create. The expectation is COMPUTED (a glob of the directory), not a copied list, so
# adding a harness cannot make this case stale — which is the property the whole ticket is
# about. It is deliberately strict in one direction: harnesses live flat in this directory
# today, so a nested one would red this case and force a decision rather than drift.
begin "the shipped default target lists exactly this directory's *.test.sh files"
expected=$(
  for path in "$SCRIPTS"/*.test.sh; do
    [ -f "$path" ] && printf '%s\n' "$path"
  done | LC_ALL=C sort
)
for interpreter in $BASHES; do
  case_ctx="$interpreter"
  run_runner_with "$interpreter" --list
  expect_rc 0 "$rc"
  [ "$out" = "$expected" ] || bad "listing differs from the directory's own glob; got: $out"
  expect_not_out "unbound variable"
  # Named explicitly as well: the computed expectation above proves the runner agrees with a
  # glob, and these prove the glob is not empty of the harnesses `verify` is meant to run.
  for known in worktree-lifecycle check-adr-index lint-shell check-module-names run-script-tests; do
    expect_out "$SCRIPTS/$known.test.sh"
  done
done
case_ctx=""
end

# ==========================================================================================
# 3. an all-green fixture
# ==========================================================================================
begin "a directory of passing harnesses exits 0 and runs all of them"
fixture all_pass
must harness "$DIR/a.test.sh" 0
must harness "$DIR/b.test.sh" 0
run_runner "$DIR"
expect_rc 0 "$rc"
expect_out "ran a.test.sh"
expect_out "ran b.test.sh"
expect_out "PASS a.test.sh"
expect_out "PASS b.test.sh"
expect_out "2 harness(es), 0 failed"
expect_not_out "FAIL"
end

# ==========================================================================================
# 4. ACCEPTANCE (a): a failing harness fails the run, and later harnesses still run
# ==========================================================================================
# This is the case the pre-fix `bash a.test.sh && bash b.test.sh && …` chain cannot pass:
# under `&&`, `ran c` and `ran d` never appear at all. Both failure exit codes are present
# because the harnesses in this repo use two — 1 for "cases failed", 2 for "the harness
# itself broke" — and a summary that flattened them would lose the distinction.
begin "a failing harness fails the run without stopping the ones after it"
fixture mixed
must harness "$DIR/a.test.sh" 0
must harness "$DIR/b.test.sh" 1
must harness "$DIR/c.test.sh" 2
must harness "$DIR/d.test.sh" 0
run_runner "$DIR"
expect_rc 1 "$rc"
expect_order "ran b.test.sh" "ran c.test.sh"
expect_order "ran c.test.sh" "ran d.test.sh"
expect_out "PASS a.test.sh"
expect_out "FAIL b.test.sh (exit 1)"
expect_out "FAIL c.test.sh (exit 2)"
expect_out "PASS d.test.sh"
expect_out "4 harness(es), 2 failed"
end

# ==========================================================================================
# 5. ACCEPTANCE (b): an empty discovery set is a failure, not a pass
# ==========================================================================================
# The green-by-absence floor. A pointing error, a renamed directory or a filter that stopped
# matching all produce "no harnesses" — and "nothing ran" must never report as "all passed".
begin "a directory with no harnesses exits 2"
fixture empty_dir
for interpreter in $BASHES; do
  case_ctx="$interpreter"
  run_runner_with "$interpreter" "$DIR"
  expect_rc 2 "$rc"
  expect_out "found no *.test.sh under"
  expect_out "green by absence"
  # The empty-array expansion bash 3.2 aborts on lives on exactly this path.
  expect_not_out "unbound variable"
done
case_ctx=""
end

begin "a directory holding only non-harness files exits 2"
fixture no_harnesses
must harness "$DIR/helper.sh" 0
must harness "$DIR/notes.txt" 0
run_runner "$DIR"
expect_rc 2 "$rc"
expect_out "found no *.test.sh under"
end

# The nastier sibling of the empty set: a discovery that PARTLY worked. `find` that cannot
# descend into a subdirectory exits non-zero and still lists everything it reached, so a red
# harness behind an unreadable directory used to be reported as "1 harness(es), 0 failed" —
# a subset run, announced as the whole suite. `pipefail` never saw it, because the pipeline
# was inside a process substitution.
#
# There is no way to fake this: the condition IS a filesystem permission. Under a root uid,
# chmod 000 restricts nothing and the case cannot be created — so it fails loudly rather
# than passing on a path it never exercised (`lint-shell.sh` takes the same line about a
# missing shellcheck: a check that could not run must never read as a check that passed).
begin "a partial discovery (unreadable subdirectory) exits 2, not a subset reported as green"
fixture partial_discovery
must harness "$DIR/a.test.sh" 0
must mkdir -p "$DIR/locked"
must harness "$DIR/locked/red.test.sh" 1
must chmod 000 "$DIR/locked"
if find "$DIR" -type f -name '*.test.sh' >/dev/null 2>&1; then
  bad "could not make a directory unreadable (running as root?) — the partial-discovery path was NOT exercised"
else
  run_runner "$DIR"
  expect_rc 2 "$rc"
  expect_out "discovery failed"
  expect_not_out "0 failed"
  expect_not_out "PASS a.test.sh"
fi
# Restored unconditionally: the trap's `rm -rf` cannot remove a directory it cannot enter.
must chmod 755 "$DIR/locked"
end

# ==========================================================================================
# 6. discovery selects harnesses, and only harnesses
# ==========================================================================================
# The complement of case 5: a filter loose enough to run every *.sh would execute the
# library scripts sitting beside the harnesses in the real directory.
begin "neighbouring .sh files are discovered by nobody and run by nobody"
fixture only_tests
must harness "$DIR/a.test.sh" 0
cat >"$DIR/helper.sh" <<EOF
#!/usr/bin/env bash
printf '%s\n' "ran helper.sh" >"$DIR/sentinel"
EOF
run_runner "$DIR"
expect_rc 0 "$rc"
expect_out "1 harness(es), 0 failed"
expect_not_out "helper.sh"
[ -e "$DIR/sentinel" ] && bad "helper.sh was executed"
end

# ==========================================================================================
# 7. a harness added later is picked up with no edit anywhere
# ==========================================================================================
# The ticket in one case: under the enumerated `test:scripts` string, the second run below
# is identical to the first and the new red harness is invisible. Under discovery, adding
# the file is the whole of the wiring.
begin "a newly added harness joins the run without the runner being edited"
fixture late_addition
must harness "$DIR/a.test.sh" 0
run_runner "$DIR"
expect_rc 0 "$rc"
expect_out "1 harness(es), 0 failed"
must harness "$DIR/z.test.sh" 1
run_runner "$DIR"
expect_rc 1 "$rc"
expect_out "ran z.test.sh"
expect_out "FAIL z.test.sh (exit 1)"
expect_out "2 harness(es), 1 failed"
end

# ==========================================================================================
# 8. a harness in a subdirectory is discovered too
# ==========================================================================================
begin "harnesses in subdirectories are discovered"
fixture nested
must harness "$DIR/a.test.sh" 0
must harness "$DIR/sub/deep.test.sh" 1
run_runner "$DIR"
expect_rc 1 "$rc"
expect_out "ran deep.test.sh"
expect_out "2 harness(es), 1 failed"
end

# ==========================================================================================
# 9. the recursion guard
# ==========================================================================================
# The hazard this runner creates for itself: its own harness is discovered like any other,
# so a harness that invoked the runner against the directory it was launched from would fork
# forever. The guard refuses a target an enclosing invocation is already running.
#
# The fixture harness carries its own depth belt, writing and re-reading a counter file: if
# the guard is broken, this case fails on "GUARD BROKEN" within four levels instead of
# hanging the suite (and CI) indefinitely.
begin "a harness re-entering the runner on its own directory is refused, not looped"
fixture recursion
counter="$DIR/depth"
cat >"$DIR/a.test.sh" <<EOF
#!/usr/bin/env bash
depth=\$(cat "$counter" 2>/dev/null || printf '0')
depth=\$((depth + 1))
printf '%s\n' "\$depth" >"$counter"
if [ "\$depth" -gt 3 ]; then
  printf '%s\n' "GUARD BROKEN at depth \$depth"
  exit 9
fi
bash "$RUNNER" "$DIR"
EOF
run_runner "$DIR"
expect_rc 1 "$rc"
expect_out "refusing to recurse"
expect_out "FAIL a.test.sh (exit 2)"
expect_not_out "GUARD BROKEN"
end

# The guard must not fire on a *different* directory: nesting a runner over a fixture is how
# this very file works, and a guard that banned all nesting would ban this suite.
begin "a nested run against a different directory is allowed"
fixture outer
fixture inner
must harness "$TMP_ROOT/inner/x.test.sh" 0
cat >"$TMP_ROOT/outer/a.test.sh" <<EOF
#!/usr/bin/env bash
bash "$RUNNER" "$TMP_ROOT/inner"
EOF
run_runner "$TMP_ROOT/outer"
expect_rc 0 "$rc"
expect_out "ran x.test.sh"
expect_out "PASS a.test.sh"
end

# ==========================================================================================
# 10. argument errors reach a verdict of "no verdict"
# ==========================================================================================
begin "a nonexistent directory exits 2, not 0"
run_runner "$TMP_ROOT/does-not-exist"
expect_rc 2 "$rc"
expect_out "is not a directory"
end

begin "--help prints usage and runs nothing"
run_runner --help
expect_rc 0 "$rc"
expect_out "Usage: bash .claude/scripts/run-script-tests.sh"
expect_not_out "summary"
end

begin "an unknown option exits 2"
run_runner --nope
expect_rc 2 "$rc"
expect_out "unknown option"
end

begin "a second directory argument exits 2"
fixture two_args
must harness "$DIR/a.test.sh" 0
run_runner "$DIR" "$DIR"
expect_rc 2 "$rc"
expect_out "at most one directory"
end

# ==========================================================================================

printf '\n%d passed, %d failed\n' "$passed" "$failed"
[ "$failed" = "0" ] || exit 1
