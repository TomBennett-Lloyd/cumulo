#!/usr/bin/env bash
#
# SessionStart hook: make a freshly created worktree usable before the first tool
# call, by installing node_modules when the worktree has a lockfile but no deps.
#
# This is a FOURTH layer alongside the three documented in .githooks/pre-commit
# (edit-time ESLint, staged-content pre-commit, CI). It is deliberately not one
# of them: those three are checks — they judge content and can reject it. This
# one judges nothing and rejects nothing. It is environment preparation, and it
# runs at session start precisely so the real checks have something to run with:
# post-edit-check.sh silently no-ops without node_modules, and .githooks/pre-commit
# hard-fails on it. Every worktree installs its own deps — never symlink or share
# node_modules with the main checkout, or `@cumulo/*` workspace imports resolve
# into the wrong tree.
#
# Non-blocking by contract: always exits 0. A failed install is reported as text
# for the session to act on, never as a refusal to start.
#
# The tree to prepare comes from the event's `cwd` — where the session actually
# is — and never from $CLAUDE_PROJECT_DIR (#74), which is pinned to the directory
# Claude Code was started in. Reading the pinned value inverted this hook's whole
# purpose: a session opened in a fresh worktree would find node_modules present
# in the MAIN checkout, conclude there was nothing to do, and leave the worktree
# it was supposed to prepare without deps.
#
# .claude/settings.json does still use $CLAUDE_PROJECT_DIR, correctly, to locate
# this script FILE — which tree is judged and which copy of the script judges it
# are different questions. See post-edit-check.sh's header for the consequence of
# the second one: the copy that runs is the main checkout's, so a hook edited on
# a branch takes effect on merge and only for sessions started after it.
#
set -u
export PATH="/opt/homebrew/bin:$PATH"

lib="$(dirname -- "${BASH_SOURCE[0]}")/hook-context.sh"
# shellcheck source=./hook-context.sh
if ! . "$lib"; then
  echo "ensure-deps: could not load $lib — deps were not checked for this session." >&2
  exit 0
fi

# Preflight, on the same terms as post-edit-check's but settled the other way. The
# report is not optional — without the interpreter this hook stops preparing every
# worktree it is handed, silently, and a session then fails its first real check for
# a reason that has nothing to do with the code. The EXIT STATUS is where the two
# hooks part: 0, always, because this hook never blocks a session (see the header's
# non-blocking contract). Loud and harmless, not loud and refusing.
hook_require_tools ensure-deps "$HOOK_NODE_CMD" git pnpm || exit 0

# $PWD is the fallback, not a second opinion: Claude Code runs hooks in the
# session's working directory, so it is the same answer by another route when the
# event carries no `cwd` (a hand-run of this script, say).
#
# That fallback is exactly why the read is split into two steps here. An unreadable
# event leaves `cwd` empty, and empty falls through to $PWD — a plausible-looking
# answer that this hook would then act on, having read nothing. So the interpreter's
# failure is caught on its own and reported before the fallback can paper over it.
event=$(read_hook_event) || {
  echo "ensure-deps: could not read the hook event (stdin was unreadable) — deps were not checked for this session." >&2
  exit 0
}
cwd=$(hook_event_field "$event" cwd) || {
  echo "ensure-deps: could not read the hook event ($HOOK_NODE_CMD failed) — deps were not checked for this session." >&2
  exit 0
}
root=$(repo_root_for "${cwd:-$PWD}") || exit 0
[ -f "$root/pnpm-lock.yaml" ] || exit 0
[ -d "$root/node_modules" ] && exit 0

if out=$(cd "$root" && pnpm install --frozen-lockfile 2>&1); then
  echo "ensure-deps: node_modules was missing in $root — ran pnpm install --frozen-lockfile, deps are ready."
else
  {
    echo "ensure-deps: node_modules is missing in $root and pnpm install --frozen-lockfile failed — checks that need deps will not run until this is fixed:"
    echo "$out"
  } >&2
fi
exit 0
