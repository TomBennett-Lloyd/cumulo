#!/usr/bin/env bash
#
# Shared helpers for the hook scripts in this directory. Sourced, never executed.
#
# Both helpers exist to answer one question correctly: WHICH TREE is this hook
# event about? The answer is never $CLAUDE_PROJECT_DIR. That variable names the
# directory Claude Code was started in and is fixed for the life of the session —
# it does not follow the session into `.claude/worktrees/<task>/`. A hook that
# reads it is therefore asking "where did this session begin", when what it needs
# is "which working tree owns the thing I was handed" (#74). The two differ for
# every worktree task, which is every task this repo runs.
#
set -u
export PATH="/opt/homebrew/bin:$PATH"

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  echo "hook-context.sh is a sourced library, not an executable script" >&2
  exit 2
fi

# read_hook_event -> the hook event JSON from stdin, or empty when there is none.
#
# The `-t 0` guard is not defensiveness about the real caller — Claude Code always
# delivers JSON on stdin — it is what keeps a hook runnable by hand. A bare `cat`
# in a script somebody runs from a terminal to see what it does blocks forever
# with no prompt, which reads as a hang in the hook rather than as a missing
# argument.
read_hook_event() {
  [ -t 0 ] && return 0
  cat
}

# hook_event_field <event-json> <dotted-key> -> the string at that key, or empty.
#
# Empty covers all three ways this can come back with nothing — absent field,
# non-string value, unparseable JSON — because all three mean the same thing to
# every caller here: this event does not tell us what we would have acted on, so
# there is nothing to do. That is an expected outcome returned as a value, not a
# swallowed error (error-handling.md rule 1); callers branch on it explicitly.
# Hooks are plumbing that runs on every tool call, and plumbing that hard-fails on
# a shape it did not expect blocks the edit it was only meant to comment on.
hook_event_field() {
  printf '%s' "$1" | python3 -c '
import json, sys

try:
    node = json.load(sys.stdin)
except Exception:
    sys.exit(0)
for key in sys.argv[1].split("."):
    if not isinstance(node, dict):
        sys.exit(0)
    node = node.get(key)
print(node if isinstance(node, str) else "")
' "$2"
}

# repo_root_for <path> -> the top level of the git working tree containing <path>.
# Returns 1, printing nothing, when <path> is not inside one.
#
# `rev-parse --show-toplevel` is the whole point: run from inside a linked
# worktree it prints THAT worktree, not the main checkout, which is exactly the
# distinction $CLAUDE_PROJECT_DIR cannot make. <path> may be a file or a
# directory; a file that does not exist yet still resolves through its parent.
repo_root_for() {
  local start="$1" dir
  [ -n "$start" ] || return 1
  if [ -d "$start" ]; then
    dir="$start"
  else
    dir=$(dirname -- "$start")
  fi
  [ -d "$dir" ] || return 1
  git -C "$dir" rev-parse --show-toplevel 2>/dev/null
}
