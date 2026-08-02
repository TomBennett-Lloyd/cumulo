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
# WHICH STREAM is the second contract these hooks carry, and it is asserted here
# rather than merged away (#157): post-edit-check reports on stderr and exits 2,
# ensure-deps announces a successful install on stdout and a failed one on stderr.
# Merging both streams into one capture made "the report reached stderr" a claim no
# case could make — a hook whose report silently moved to stdout would vanish from
# the agent's view and every case here would have stayed green.
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
# That recipe works for PRE-FIX revisions only, and the reason is worth stating
# because the alternative looks like a broken harness rather than a broken recipe:
# a post-fix hook copied alone to /tmp has no sibling hook-context.sh, so it fails
# the `source` and exits 1 before reaching any logic. To bisect a post-fix
# revision, extract the hooks AND the library into one directory together and
# point both variables inside it.
#
# Self-contained on the same terms as the other harnesses here: no framework beyond
# the shared vocabulary in harness-lib.sh next door, no network, one `mktemp -d`
# that a trap removes, and every fixture is a throwaway git repo, so the harness can
# never touch the repository it ships in.
#
# Usage: bash .claude/scripts/hook-tree-resolution.test.sh   (or `pnpm test:scripts`)
# Exit:  0 every case PASS, 1 at least one FAIL, 2 the harness itself broke.
set -uo pipefail
export PATH="/opt/homebrew/bin:$PATH"

SCRIPTS=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd) || exit 2
HOOKS=$(cd "$SCRIPTS/../hooks" && pwd) || exit 2

# shellcheck source=./harness-lib.sh
. "$SCRIPTS/harness-lib.sh"

POST_EDIT_HOOK=${POST_EDIT_HOOK:-$HOOKS/post-edit-check.sh}
ENSURE_DEPS_HOOK=${ENSURE_DEPS_HOOK:-$HOOKS/ensure-deps.sh}

# Both hooks shell out to pnpm. A missing pnpm would turn every case green for the
# wrong reason (the hook would report a failed command instead of a wrong tree),
# so it is a no-verdict, not a pass — same stance as lint-shell.sh on shellcheck.
if ! command -v pnpm >/dev/null 2>&1; then
  echo "hook-tree-resolution.test.sh: pnpm is not installed — refusing to report a pass" >&2
  exit 2
fi

harness_init_tmp

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

# add_deps <tree> <eslint-exit-status> -> a package.json plus a node_modules/.bin/eslint
# that reports the directory `pnpm exec` ran it from and then returns the given verdict.
# The package.json is what stops pnpm walking up out of the fixture looking for one.
#
# The verdict is a parameter because BOTH values have to appear in the suite. A clean
# edit and a no-verdict edit are the same observable pair — exit 0, no output — so the
# cases asserting no-verdict cannot, on their own, tell that the hook still reports a
# clean file as clean: inverting `if ! out=$(pnpm exec eslint …)` in post-edit-check.sh
# would make every clean edit an exit-2 block, and every rc-0 case here would stay
# green. The passing case below is what closes that.
add_deps() {
  must mkdir -p "$1/node_modules/.bin"
  cat >"$1/node_modules/.bin/eslint" <<SHIM
#!/usr/bin/env bash
printf 'eslint-shim cwd=[%s]\n' "\$PWD"
exit $2
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

# add_installed_ok <tree> -> the other half of that pair: a manifest/lockfile combination
# `pnpm install --frozen-lockfile` ACCEPTS, which is the only way to reach ensure-deps'
# success branch at all.
#
# The lockfile text is derived, never guessed — it is pnpm's own output for exactly this
# manifest under the pinned pnpm (11.18.0, package.json's `packageManager`), and it is
# dep-free so the install needs nothing from the network: `rm -rf node_modules &&
# pnpm install --frozen-lockfile --offline` exits 0 on it, which is what keeps the
# harness's no-network promise honest. Regenerate BOTH halves together the day pnpm's
# lockfile format moves — a stale lockfile turns the success case red rather than quiet,
# because the hook would take the failure branch and stdout would carry nothing.
add_installed_ok() { # add_installed_ok <tree>
  must_write "$1/package.json" '{"name":"fixture","version":"0.0.0","private":true}'
  must cat >"$1/pnpm-lock.yaml" <<'LOCK'
lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

importers:

  .: {}
LOCK
}

# --- hook invocation ---------------------------------------------------------------

# Both hooks read their event from stdin, and stdin is the one thing `capture` inherits
# rather than owns. So the event JSON goes to a file and is REDIRECTED INTO the capture
# call; it is never piped into it. A pipe would run capture in a subshell, and its
# out/err/rc assignments would die with that subshell while the caller read the previous
# run's values — see harness-lib.sh's capture header.

run_post_edit() { # run_post_edit <edited-file> <claude-project-dir>
  must printf '{"tool_input":{"file_path":"%s"},"cwd":"%s"}' "$1" "$2" >"$TMP_ROOT/event.json"
  capture env CLAUDE_PROJECT_DIR="$2" bash "$POST_EDIT_HOOK" <"$TMP_ROOT/event.json"
}

run_ensure_deps() { # run_ensure_deps <event-cwd> <claude-project-dir>
  must printf '{"cwd":"%s"}' "$1" >"$TMP_ROOT/event.json"
  capture env CLAUDE_PROJECT_DIR="$2" bash "$ENSURE_DEPS_HOOK" <"$TMP_ROOT/event.json"
}

# The interpreter-swapping variants of the two runners above, for the tool-preflight
# cases at the bottom of this file. They exist ALONGSIDE their counterparts rather than
# replacing them, and that is testing.md rule 7 rather than an accident: HOOK_NODE_CMD is
# a knob, the preflight cases can only reach their target by turning it, and if every
# runner turned it the shipped default (`node`, set in hook-context.sh) would be the one
# configuration this suite never ran. So the ten cases above leave it unset — the two
# lines of near-duplication below are what buys that.

run_post_edit_as() { # run_post_edit_as <node-cmd> <edited-file> <claude-project-dir>
  must printf '{"tool_input":{"file_path":"%s"},"cwd":"%s"}' "$2" "$3" >"$TMP_ROOT/event.json"
  capture env CLAUDE_PROJECT_DIR="$3" HOOK_NODE_CMD="$1" bash "$POST_EDIT_HOOK" <"$TMP_ROOT/event.json"
}

run_ensure_deps_as() { # run_ensure_deps_as <node-cmd> <event-cwd> <claude-project-dir>
  must printf '{"cwd":"%s"}' "$2" >"$TMP_ROOT/event.json"
  capture env CLAUDE_PROJECT_DIR="$3" HOOK_NODE_CMD="$1" bash "$ENSURE_DEPS_HOOK" <"$TMP_ROOT/event.json"
}

# --- post-edit-check: which tree lints the edited file -------------------------------

make_fixture both
BOTH_MAIN="$TMP_ROOT/both/main"
BOTH_WT="$BOTH_MAIN/.claude/worktrees/task"
add_deps "$BOTH_MAIN" 1
add_deps "$BOTH_WT" 1
must mkdir -p "$BOTH_WT/pkg" "$BOTH_MAIN/pkg"
must touch "$BOTH_WT/pkg/mod.ts" "$BOTH_MAIN/pkg/mod.ts" "$BOTH_WT/notes.md"

# stderr, not "some stream": post-edit-check.sh wraps its whole report in `{ … } >&2`
# before exiting 2, and the eslint shim's cwd line is captured into that block, so it
# arrives on stderr too. A report that drifted onto stdout would still be output, and a
# merged capture would still be green — while the agent whose feedback loop this is
# would see nothing.
begin "post-edit-check lints a worktree file from that worktree, not from CLAUDE_PROJECT_DIR"
run_post_edit "$BOTH_WT/pkg/mod.ts" "$BOTH_MAIN"
expect_rc 2 "$rc"
expect_stderr "cwd=[$BOTH_WT]"
expect_not_stderr "cwd=[$BOTH_MAIN]"
expect_stderr "ESLint failed for $BOTH_WT/pkg/mod.ts"
end

begin "post-edit-check still lints a main-checkout file from the main checkout"
run_post_edit "$BOTH_MAIN/pkg/mod.ts" "$BOTH_MAIN"
expect_rc 2 "$rc"
expect_stderr "cwd=[$BOTH_MAIN]"
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
add_deps "$MAINONLY_MAIN" 1
must mkdir -p "$MAINONLY_WT/pkg"
must touch "$MAINONLY_WT/pkg/mod.ts"

begin "post-edit-check does not borrow the main checkout's node_modules for a worktree file"
run_post_edit "$MAINONLY_WT/pkg/mod.ts" "$MAINONLY_MAIN"
expect_rc 0 "$rc"
expect_silent
end

# The other verdict. Silence here and silence for the no-verdict cases above are the
# same two bytes of evidence, which is the point: this case is the only thing standing
# between a clean edit and an exit-2 block if the eslint branch is ever inverted.
make_fixture clean
CLEAN_MAIN="$TMP_ROOT/clean/main"
CLEAN_WT="$CLEAN_MAIN/.claude/worktrees/task"
add_deps "$CLEAN_WT" 0
must mkdir -p "$CLEAN_WT/pkg"
must touch "$CLEAN_WT/pkg/mod.ts"

begin "post-edit-check passes a clean worktree file through silently"
run_post_edit "$CLEAN_WT/pkg/mod.ts" "$CLEAN_MAIN"
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
expect_stderr "$SESSION_WT"
expect_stderr "node_modules"
expect_not_stdout "pnpm install --frozen-lockfile failed"
end

begin "ensure-deps falls back to its own working directory when the event carries no cwd"
must printf '{}' >"$TMP_ROOT/event.json"
capture -C "$SESSION_WT" env CLAUDE_PROJECT_DIR="$SESSION_MAIN" bash "$ENSURE_DEPS_HOOK" <"$TMP_ROOT/event.json"
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

# The success branch, which every case above leaves untested: a failed install and a
# successful one both end in text naming the tree, and the merged capture could not tell
# them apart. Separate streams are what make "installed cleanly" a distinct observation
# from "install failed" — and this is the only case that would notice the success line
# moving to stderr, where the session would never surface it.
make_fixture ready
READY_MAIN="$TMP_ROOT/ready/main"
READY_WT="$READY_MAIN/.claude/worktrees/task"
add_installed_ok "$READY_WT"

begin "ensure-deps reports a successful install on stdout, naming the tree it prepared"
run_ensure_deps "$READY_WT" "$READY_MAIN"
expect_rc 0 "$rc"
expect_stdout "deps are ready"
expect_stdout "$READY_WT"
expect_not_stderr "pnpm install --frozen-lockfile failed"
end

# --- the tool preflight: "cannot judge" is loud, and says which tool ------------------
#
# Every case above runs the real interpreter, and that is precisely why none of them can
# see any of this: a hook with a working node behaves identically whether its preflight is
# present, absent, or misspelled. Green with the tool installed is not evidence that the
# missing-tool path works — it is the same output either way. So these four take the tool
# away, which is the negative control #102 asks for by name.
#
# Two different failures, deliberately kept apart, because the fix has to distinguish them
# too: an interpreter that is NOT THERE (caught by the preflight, reported with the tool's
# name) and one that IS there but CANNOT RUN (passes `command -v`, fails at use, caught by
# the exit status of hook_event_field). Before #102 both ended the same way — empty output,
# exit 0 — which reads as "this event named nothing to act on" and is indistinguishable
# from a clean edit.
#
# The four cases are that pair CROSSED WITH BOTH HOOKS, and the grid is filled in on
# purpose rather than by symmetry-for-its-own-sake. The two hooks resolve a missing verdict
# oppositely — post-edit-check exits 2, ensure-deps exits 0 — so each guard is a separate
# piece of code with a separate exit status, and covering one proves nothing about the
# other. Review cycle 1 caught exactly that hole: with only three cases, deleting
# ensure-deps' rc-check on the field read left the suite fully green, so the loud/silent
# boundary was pinned for one caller and unpinned for the other — the precise asymmetry
# this issue exists to close.

ABSENT_NODE="$TMP_ROOT/absent/node"
if [ -e "$ABSENT_NODE" ]; then
  printf 'FATAL harness setup failed: %s was supposed to be absent\n' "$ABSENT_NODE" >&2
  exit 2
fi

# Present and executable, so it clears `command -v` and the preflight lets it through —
# then exits non-zero without reading a byte. This is the shape a shadowed, broken or
# wrong-architecture interpreter takes, and the preflight alone cannot catch it.
BAD_NODE="$TMP_ROOT/badnode"
must_write "$BAD_NODE" '#!/bin/sh
exit 3'
must chmod +x "$BAD_NODE"

# A .ts file in a worktree that HAS deps: an event that would have produced a real verdict,
# so "no eslint-shim in the output" is the positive tell that the hook stopped rather than
# proceeded to judge with a tool it could not read the event with.
begin "post-edit-check refuses loudly, naming the tool, when the event interpreter is missing"
run_post_edit_as "$ABSENT_NODE" "$BOTH_WT/pkg/mod.ts" "$BOTH_MAIN"
expect_rc 2 "$rc"
expect_stderr "required tool not found: $ABSENT_NODE"
expect_not_out "eslint-shim"
end

# The same missing tool, the other contract: ensure-deps must say so and must still not
# block the session. The fixture has a lockfile and no node_modules, so an ensure-deps that
# got past the preflight would attempt the install and name it in its report — which is
# what the absence assertion pins.
make_fixture preflight
PREFLIGHT_MAIN="$TMP_ROOT/preflight/main"
PREFLIGHT_WT="$PREFLIGHT_MAIN/.claude/worktrees/task"
add_installable "$PREFLIGHT_WT"

begin "ensure-deps reports a missing tool on stderr without blocking the session"
run_ensure_deps_as "$ABSENT_NODE" "$PREFLIGHT_WT" "$PREFLIGHT_MAIN"
expect_rc 0 "$rc"
expect_stderr "required tool not found"
expect_not_out "pnpm install --frozen-lockfile"
end

# expect_not_stderr on the preflight message is load-bearing, not tidiness: it is what says
# this case reached the SECOND guard. A stub that failed `command -v` would satisfy the rc
# and the "could not read" assertion by the preflight's route and leave the exit-status
# check on hook_event_field completely unexercised.
begin "post-edit-check refuses when the interpreter runs but cannot read the event"
run_post_edit_as "$BAD_NODE" "$BOTH_WT/pkg/mod.ts" "$BOTH_MAIN"
expect_rc 2 "$rc"
expect_stderr "could not read the hook event"
expect_not_stderr "required tool not found"
expect_not_out "eslint-shim"
end

# The twin of the case above, and the one with the nastier failure if it goes unwritten.
# post-edit-check reading an unreadable event just stops; ensure-deps reading one gets an
# empty `cwd`, and empty falls through to the $PWD fallback — so an unguarded field read does
# not merely fail to prepare the worktree, it goes and prepares WHATEVER DIRECTORY THE HOOK
# HAPPENS TO BE IN, having read nothing at all. A wrong tree confidently answered is the
# original #74 shape, arrived at from a new direction.
#
# expect_rc 0 is the contract, not a weaker assertion than the twin's exit 2: ensure-deps
# never blocks a session (see its header). Loud AND harmless is the whole target here — the
# stderr assertion and the rc assertion are each half of it, and neither alone is the point.
begin "ensure-deps reports an unreadable event without blocking, and prepares nothing"
run_ensure_deps_as "$BAD_NODE" "$PREFLIGHT_WT" "$PREFLIGHT_MAIN"
expect_rc 0 "$rc"
expect_stderr "could not read the hook event"
expect_not_stderr "required tool not found"
expect_not_out "deps are ready"
end

# --- summary -------------------------------------------------------------------------

finish
