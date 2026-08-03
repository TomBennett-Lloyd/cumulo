#!/usr/bin/env bash
# PostToolUse hook: immediate ESLint feedback on any edited TypeScript file,
# so implementing agents self-correct instead of leaving issues for review.
#
# The tree the check runs in is derived from the EDITED FILE, never from
# $CLAUDE_PROJECT_DIR (#74). That variable is pinned to the directory Claude Code
# was started in, so every edit inside `.claude/worktrees/<task>/` used to be
# linted from the MAIN checkout: its node_modules, its eslint config, its cwd.
# Three consequences, all bad. The verdict is wrong in both directions whenever
# the branch touches lint config or plugins. `pnpm exec` writes into the main
# checkout's node_modules, which the worktree rules declare read-only for task
# work. And the agent doing the editing has no way to see either happening.
#
# $CLAUDE_PROJECT_DIR is still the right answer to a different question, and
# .claude/settings.json still uses it — to locate the script FILE. Which copy of
# this script runs and which tree it judges are separate decisions, and the first
# one has a consequence worth knowing: a worktree session's project dir is the
# main checkout, so it is the MAIN checkout's settings.json and the MAIN
# checkout's copy of this file that execute. A hook edited on a branch never runs
# for that branch's own sessions — it takes effect on merge, and only for
# sessions started afterwards. That is the mechanism by which #74 survived as
# long as it did, and it is why the harness invokes these scripts directly
# instead of trusting a session to exercise them.
set -u
export PATH="/opt/homebrew/bin:$PATH"

lib="$(dirname -- "${BASH_SOURCE[0]}")/hook-context.sh"
# shellcheck source=./hook-context.sh
if ! . "$lib"; then
  echo "post-edit-check: could not load $lib — edit-time ESLint did not run for this edit." >&2
  exit 1
fi

# Preflight, before anything is read or judged. All three tools are load-bearing —
# the interpreter reads the event, git names the owning tree, pnpm runs the lint —
# and missing any one of them does not weaken this check, it silently deletes it:
# every edit for the rest of the session comes back exit 0, which is the same two
# bytes of evidence a clean file produces. Exit 2 because this is a check and a
# check that cannot run must not be mistaken for one that passed
# (hook-context.sh's header: cannot judge, so be loud).
hook_require_tools post-edit-check "$HOOK_NODE_CMD" git pnpm || exit 2

# Read and parse in two steps, not one nested substitution: `$(hook_event_field
# "$(read_hook_event)" …)` reports only the OUTER command's status, so an
# interpreter that never ran was indistinguishable from an event with no file_path
# in it. Split, each step's failure is its own and gets its own report.
event=$(read_hook_event) || {
  echo "post-edit-check: could not read the hook event (stdin was unreadable) — edit-time lint did not run for this edit." >&2
  exit 2
}
file=$(hook_event_field "$event" tool_input.file_path) || {
  echo "post-edit-check: could not read the hook event ($HOOK_NODE_CMD failed) — edit-time lint did not run for this edit." >&2
  exit 2
}

case "$file" in
  *.ts | *.tsx | *.mts | *.cts) ;;
  *) exit 0 ;;
esac

[ -f "$file" ] || exit 0

# No working tree owns the file — a scratchpad edit outside the repo, say. The
# repo's eslint config is not the right judge of a file the repo does not
# contain, so there is nothing to run and nothing to report.
root=$(repo_root_for "$file") || exit 0

# Deps missing in the OWNING tree stays a silent no-op, as it always was: a
# freshly created worktree is briefly in exactly that state and ensure-deps.sh is
# the layer that fixes it. What changed is the fallback. It used to be "check
# against another tree's deps", which produced a verdict; it is now "no check",
# which produces none. A missing verdict is recoverable, a wrong one is not.
[ -d "$root/node_modules" ] || exit 0
cd "$root" || exit 0

if ! out=$(pnpm exec eslint --no-warn-ignored --max-warnings 0 "$file" 2>&1); then
  {
    echo "ESLint failed for $file — fix the root cause; suppression comments are themselves lint errors:"
    echo "$out"
  } >&2
  exit 2
fi
exit 0
