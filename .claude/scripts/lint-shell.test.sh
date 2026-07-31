#!/usr/bin/env bash
# Test harness for the shell lint gate (.claude/scripts/lint-shell.sh).
#
# The gate's exit codes are a three-way contract, and the interesting failure is the
# middle one: 0 clean, 1 shellcheck found something, 2 the GATE ITSELF is broken and
# no verdict was reached. `rm foo.sh` without staging the deletion left a path in the
# index that is not in the working tree, and shellcheck exits 2 on a file it cannot
# open — so an ordinary uncommitted delete used to red `pnpm verify` with "the gate is
# broken", which is both wrong and unactionable. These cases pin the fix.
#
# Self-contained on the same terms as worktree-lifecycle.test.sh: no framework, no
# network, one `mktemp -d` that a trap removes, and every fixture is a throwaway git
# repo, so the harness can never lint or mutate the repository it ships in.
#
# Usage: bash .claude/scripts/lint-shell.test.sh   (or `pnpm test:scripts`)
# Exit:  0 every case PASS, 1 at least one FAIL, 2 the harness itself broke.
set -u
export PATH="/opt/homebrew/bin:$PATH"

SCRIPTS=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd) || exit 2

# The gate under test, overridable so the same cases can be run against an older
# revision of the gate as a negative control (testing.md rule 4: a regression test is
# only worth its line count if it has been seen to fail on the pre-fix code):
#
#   git show <rev>:.claude/scripts/lint-shell.sh >/tmp/pre.sh
#   LINT_SHELL_GATE=/tmp/pre.sh bash .claude/scripts/lint-shell.test.sh
#
# Unset — how `pnpm test:scripts` runs it — is the shipped gate.
GATE=${LINT_SHELL_GATE:-$SCRIPTS/lint-shell.sh}

tmp_raw=$(mktemp -d) || exit 2
cleanup() { rm -rf "$tmp_raw"; }
trap cleanup EXIT INT TERM
# Canonical from the start: macOS hides temp dirs behind /var -> /private/var, and the
# gate reports paths relative to a realpath'd toplevel.
TMP_ROOT=$(cd "$tmp_raw" && pwd -P) || exit 2

passed=0
failed=0
case_name=""
case_failed=0
out=""
rc=0

# --- harness plumbing --------------------------------------------------------------

must() {
  "$@" || {
    printf 'FATAL harness setup failed: %s\n' "$*" >&2
    exit 2
  }
}

begin() {
  case_name="$1"
  case_failed=0
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

bad() {
  printf '  ! %s\n' "$1" >&2
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

# --- fixtures ----------------------------------------------------------------------

# Identity is passed per-command: the harness must not depend on (or write) any git config.
gitc() {
  local dir="$1"
  shift
  git -C "$dir" -c user.email=test@test -c user.name=test -c commit.gpgsign=false "$@"
}

clean_script() { # clean_script <path> — a script shellcheck has nothing to say about
  cat >"$1" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'ok\n'
EOF
}

dirty_script() { # dirty_script <path> — one unquoted expansion, i.e. SC2086
  cat >"$1" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
target=$1
cat $target
EOF
}

# fixture <name> -> sets ROOT to a fresh single-commit repo under $TMP_ROOT holding the
# gate under test at its real path, plus keep.sh and doomed.sh. The gate is COPIED IN
# rather than run from outside: the gate resolves its own repo with `rev-parse
# --show-toplevel`, so a fixture that carries its own copy is both realistic and the
# thing that makes swapping in an older revision a one-line change.
fixture() {
  ROOT="$TMP_ROOT/$1"
  must mkdir -p "$ROOT/.claude/scripts"
  must git init --quiet -b main "$ROOT"
  must cp "$GATE" "$ROOT/.claude/scripts/lint-shell.sh"
  must clean_script "$ROOT/keep.sh"
  must clean_script "$ROOT/doomed.sh"
  must gitc "$ROOT" add -A
  must gitc "$ROOT" commit --quiet -m base
}

run_gate() {
  out=$(cd "$ROOT" && bash .claude/scripts/lint-shell.sh 2>&1)
  rc=$?
}

# ====================================================================================
# 1. an unstaged deletion is not a broken gate
# ====================================================================================
# rc is the whole assertion: 2 is what the pre-fix gate returned here, and it is the
# code reserved for "the gate could not run", so accepting anything non-zero would let
# the regression back in under a different name.
begin "gate exits 0 when a tracked .sh is deleted but the deletion is unstaged"
fixture unstaged_delete
must rm "$ROOT/doomed.sh"
run_gate
expect_rc 0 "$rc"
# Two files, not three: the gate copy and keep.sh were linted, doomed.sh was dropped.
# Without the count this case would also pass if the guard had grown into "skip
# everything", which is the failure mode a fix in this area is most likely to cause.
expect_out "over 2 file(s)"
expect_not_out "doomed.sh"
end

# ====================================================================================
# 2. positive control — the deletion path did not turn the gate off
# ====================================================================================
begin "gate still exits 1 for a real violation while an unstaged deletion is present"
fixture unstaged_delete_violation
must dirty_script "$ROOT/keep.sh"
must rm "$ROOT/doomed.sh"
run_gate
expect_rc 1 "$rc"
expect_out "SC2086"
expect_out "keep.sh"
end

# ====================================================================================

printf '\n%d passed, %d failed\n' "$passed" "$failed"
[ "$failed" = "0" ] || exit 1
