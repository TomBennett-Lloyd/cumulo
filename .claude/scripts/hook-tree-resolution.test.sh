#!/usr/bin/env bash
#
# Test harness for the one question both hooks in .claude/hooks/ have to answer
# correctly: WHICH git working tree is this event about? (#74)
#
# The answer used to be $CLAUDE_PROJECT_DIR, which is pinned to the directory
# Claude Code was started in and does not follow the session into a worktree. So
# every case here is set up the way the bug actually presented: CLAUDE_PROJECT_DIR
# points at the main checkout while the work is happening in a linked worktree
# nested under it at .claude/worktrees/task — the real layout, and the one where a
# naive "walk up until you find a .git" would also give the wrong answer.
#
# The tell is arranged to be a positive assertion rather than an absence. Each
# fixture tree gets its own node_modules/.bin/eslint shim that prints its own cwd
# in brackets, so a case says "the check ran in [the worktree]" instead of "the
# check did not mention the main checkout" — which matters here because the main
# checkout's path is a PREFIX of the nested worktree's, and a substring assertion
# on the bare paths would be satisfied by the wrong tree.
#
# Negative control (testing.md rule 4 — a regression test earns its lines only
# once it has been seen to fail on the pre-fix code):
#
#   git show <pre-fix-rev>:.claude/hooks/post-edit-check.sh >/tmp/pre-post-edit.sh
#   git show <pre-fix-rev>:.claude/hooks/ensure-deps.sh     >/tmp/pre-ensure-deps.sh
#   POST_EDIT_HOOK=/tmp/pre-post-edit.sh ENSURE_DEPS_HOOK=/tmp/pre-ensure-deps.sh \
#     bash .claude/scripts/hook-tree-resolution.test.sh
#
# Unset — how `pnpm test:scripts` runs it — tests the shipped hooks.
#
# Self-contained on the same terms as the other harnesses here: no framework, no
# network, one `mktemp -d` that a trap removes, and every fixture is a throwaway
# git repo, so the harness can never touch the repository it ships in.
#
# Usage: bash .claude/scripts/hook-tree-resolution.test.sh   (or `pnpm test:scripts`)
# Exit:  0 every case PASS, 1 at least one FAIL, 2 the harness itself broke.
set -u
export PATH="/opt/homebrew/bin:$PATH"

SCRIPTS=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd) || exit 2
HOOKS=$(cd "$SCRIPTS/../hooks" && pwd) || exit 2

POST_EDIT_HOOK=${POST_EDIT_HOOK:-$HOOKS/post-edit-check.sh}
ENSURE_DEPS_HOOK=${ENSURE_DEPS_HOOK:-$HOOKS/ensure-deps.sh}

# Both hooks shell out to pnpm. A missing pnpm would turn every case green for the
# wrong reason (the hook would report a failed command instead of a wrong tree),
# so it is a no-verdict, not a pass — same stance as lint-shell.sh on shellcheck.
if ! command -v pnpm >/dev/null 2>&1; then
  echo "hook-tree-resolution.test.sh: pnpm is not installed — refusing to report a pass" >&2
  exit 2
fi

tmp_raw=$(mktemp -d) || exit 2
cleanup() { rm -rf "$tmp_raw"; }
trap cleanup EXIT INT TERM
# Canonical from the start: macOS hides temp dirs behind /var -> /private/var, and
# git reports a realpath'd toplevel, so a raw mktemp path never matches.
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

expect_silent() {
  [ -z "$out" ] || bad "expected no output; got: $out"
}

# --- fixtures ----------------------------------------------------------------------

must_write() { # must_write <path> <content>
  printf '%s\n' "$2" >"$1" || {
    printf 'FATAL harness setup failed: could not write %s\n' "$1" >&2
    exit 2
  }
}

# make_fixture <name> -> a repo at $TMP_ROOT/<name>/main with a linked worktree at
# $TMP_ROOT/<name>/main/.claude/worktrees/task. Nested on purpose: see the header.
make_fixture() {
  local base="$TMP_ROOT/$1"
  must mkdir -p "$base"
  must git init -q -b main "$base/main"
  must git -C "$base/main" config user.email "harness@example.invalid"
  must git -C "$base/main" config user.name "Harness"
  must git -C "$base/main" config commit.gpgsign false
  must touch "$base/main/seed.txt"
  must git -C "$base/main" add seed.txt
  must git -C "$base/main" commit -q -m seed
  must mkdir -p "$base/main/.claude/worktrees"
  must git -C "$base/main" worktree add -q -b task "$base/main/.claude/worktrees/task"
}

# add_deps <tree> -> a package.json plus a node_modules/.bin/eslint that reports the
# directory `pnpm exec` ran it from, and fails so post-edit-check surfaces the report.
# The package.json is what stops pnpm walking up out of the fixture looking for one.
add_deps() {
  must mkdir -p "$1/node_modules/.bin"
  cat >"$1/node_modules/.bin/eslint" <<'SHIM'
#!/usr/bin/env bash
printf 'eslint-shim cwd=[%s]\n' "$PWD"
exit 1
SHIM
  must chmod +x "$1/node_modules/.bin/eslint"
  must_write "$1/package.json" '{"name":"fixture","version":"0.0.0","private":true}'
}

# add_installable <tree> -> a lockfile/manifest pair that `pnpm install --frozen-lockfile`
# rejects immediately and offline (the manifest declares a dependency the lockfile does
# not carry). ensure-deps' branch is the same either way — what these cases assert is
# WHICH tree it names — so the fast, network-free failure is the one to provoke.
add_installable() {
  must_write "$1/package.json" \
    '{"name":"fixture","version":"0.0.0","private":true,"dependencies":{"cumulo-harness-absent":"1.0.0"}}'
  must_write "$1/pnpm-lock.yaml" "lockfileVersion: '9.0'"
}

# --- hook invocation ---------------------------------------------------------------

run_post_edit() { # run_post_edit <edited-file> <claude-project-dir>
  out=$(printf '{"tool_input":{"file_path":"%s"},"cwd":"%s"}' "$1" "$2" |
    CLAUDE_PROJECT_DIR="$2" bash "$POST_EDIT_HOOK" 2>&1)
  rc=$?
}

run_ensure_deps() { # run_ensure_deps <event-cwd> <claude-project-dir>
  out=$(printf '{"cwd":"%s"}' "$1" |
    CLAUDE_PROJECT_DIR="$2" bash "$ENSURE_DEPS_HOOK" 2>&1)
  rc=$?
}

# --- post-edit-check: which tree lints the edited file -------------------------------

make_fixture both
BOTH_MAIN="$TMP_ROOT/both/main"
BOTH_WT="$BOTH_MAIN/.claude/worktrees/task"
add_deps "$BOTH_MAIN"
add_deps "$BOTH_WT"
must mkdir -p "$BOTH_WT/pkg" "$BOTH_MAIN/pkg"
must touch "$BOTH_WT/pkg/mod.ts" "$BOTH_MAIN/pkg/mod.ts" "$BOTH_WT/notes.md"

begin "post-edit-check lints a worktree file from that worktree, not from CLAUDE_PROJECT_DIR"
run_post_edit "$BOTH_WT/pkg/mod.ts" "$BOTH_MAIN"
expect_rc 2 "$rc"
expect_out "cwd=[$BOTH_WT]"
expect_not_out "cwd=[$BOTH_MAIN]"
expect_out "ESLint failed for $BOTH_WT/pkg/mod.ts"
end

begin "post-edit-check still lints a main-checkout file from the main checkout"
run_post_edit "$BOTH_MAIN/pkg/mod.ts" "$BOTH_MAIN"
expect_rc 2 "$rc"
expect_out "cwd=[$BOTH_MAIN]"
end

begin "post-edit-check ignores a non-TypeScript edit"
run_post_edit "$BOTH_WT/notes.md" "$BOTH_MAIN"
expect_rc 0 "$rc"
expect_silent
end

begin "post-edit-check no-ops on a TypeScript file outside any working tree"
must mkdir -p "$TMP_ROOT/loose"
must touch "$TMP_ROOT/loose/mod.ts"
run_post_edit "$TMP_ROOT/loose/mod.ts" "$BOTH_MAIN"
expect_rc 0 "$rc"
expect_silent
end

# The bug's exact shape: deps in the main checkout only. The owning worktree has
# nothing to lint with, and "no verdict" is the honest answer — borrowing the other
# tree's node_modules is what produced a confident wrong one.
make_fixture mainonly
MAINONLY_MAIN="$TMP_ROOT/mainonly/main"
MAINONLY_WT="$MAINONLY_MAIN/.claude/worktrees/task"
add_deps "$MAINONLY_MAIN"
must mkdir -p "$MAINONLY_WT/pkg"
must touch "$MAINONLY_WT/pkg/mod.ts"

begin "post-edit-check does not borrow the main checkout's node_modules for a worktree file"
run_post_edit "$MAINONLY_WT/pkg/mod.ts" "$MAINONLY_MAIN"
expect_rc 0 "$rc"
expect_silent
end

# --- ensure-deps: which tree gets prepared -------------------------------------------

make_fixture session
SESSION_MAIN="$TMP_ROOT/session/main"
SESSION_WT="$SESSION_MAIN/.claude/worktrees/task"
add_installable "$SESSION_MAIN"
add_installable "$SESSION_WT"
# The main checkout is already installed — which is the whole trap: reading
# CLAUDE_PROJECT_DIR made the hook inspect this directory, find deps, and return
# happy while the worktree it was started in had none.
must mkdir -p "$SESSION_MAIN/node_modules"

begin "ensure-deps prepares the worktree the session is in, not the checkout it started from"
run_ensure_deps "$SESSION_WT" "$SESSION_MAIN"
expect_rc 0 "$rc"
expect_out "$SESSION_WT"
expect_out "node_modules"
end

begin "ensure-deps falls back to its own working directory when the event carries no cwd"
out=$(printf '{}' | (cd "$SESSION_WT" && CLAUDE_PROJECT_DIR="$SESSION_MAIN" bash "$ENSURE_DEPS_HOOK" 2>&1))
rc=$?
expect_rc 0 "$rc"
expect_out "$SESSION_WT"
end

make_fixture installed
INSTALLED_MAIN="$TMP_ROOT/installed/main"
INSTALLED_WT="$INSTALLED_MAIN/.claude/worktrees/task"
add_installable "$INSTALLED_WT"
must mkdir -p "$INSTALLED_WT/node_modules"

begin "ensure-deps leaves a worktree that already has node_modules alone"
run_ensure_deps "$INSTALLED_WT" "$INSTALLED_MAIN"
expect_rc 0 "$rc"
expect_silent
end

# --- summary -------------------------------------------------------------------------

printf '\n%d passed, %d failed\n' "$passed" "$failed"
[ "$failed" -eq 0 ] || exit 1
