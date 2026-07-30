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
set -u
export PATH="/opt/homebrew/bin:$PATH"

root="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null)}"
[ -n "$root" ] || exit 0
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
