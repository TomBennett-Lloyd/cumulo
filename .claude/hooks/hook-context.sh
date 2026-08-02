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
# WHEN A HOOK RETURNS NO VERDICT, is that silence honest? The two ways to reach it
# must never look alike (#102):
#
#   SILENT BY DESIGN — there is nothing to judge. The edit is not TypeScript; the
#   file lives outside any working tree; the owning tree has no node_modules yet.
#   Each is a real and expected answer, and hooks run on every single tool call, so
#   a hook that narrated them would bury the session in noise. These stay quiet.
#
#   MUST BE LOUD — the hook cannot judge. A required tool is missing; the event is
#   unreadable at interpreter level; this library failed to load. Nothing was
#   examined and nothing is known — and the failure is total, not per-event: one
#   missing binary makes EVERY edit look linted and EVERY worktree look prepared
#   for the rest of the session. These report on stderr, naming what is missing.
#
# The rule those two draw between them, and the reason the seams below exist: a
# no-verdict of the second kind must never be observationally identical to a clean
# verdict. hook_require_tools and the exit status of hook_event_field are what buy
# that distinction; the callers spend it, each according to its own contract.
#
set -u
export PATH="/opt/homebrew/bin:$PATH"

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  echo "hook-context.sh is a sourced library, not an executable script" >&2
  exit 2
fi

# The interpreter that reads hook events. It is node because node is the runtime
# this repo actually declares (package.json `engines.node`); the interpreter that
# stood here before was an assumption nothing in the repo stated (#102).
#
# The indirection is a test seam, not configuration: the loud paths above cannot be
# tested any other way. A run with a working interpreter looks identical whether
# the preflight is present, absent, or misspelled, so the harness has to be able to
# point these hooks at a binary that is missing, and at one that crashes. Precedent:
# WORKTREE_GH_CMD in .claude/scripts/worktree-lib.sh.
: "${HOOK_NODE_CMD:=node}"

# hook_require_tools <hook-name> <tool>... -> 0 when every tool resolves, else 1.
#
# Reports EVERY missing tool rather than stopping at the first: a box missing two
# of them should learn both from one run instead of one restart at a time.
#
# What a miss COSTS is the caller's decision and differs by contract — post-edit-check
# exits 2 because it is a check and must not resemble a pass, ensure-deps exits 0
# because it never blocks a session. What is not the caller's to choose is whether
# the miss is mentioned at all: the report has already gone to stderr by the time
# this returns.
hook_require_tools() {
  local hook="$1" tool missing=0
  shift
  for tool; do
    if ! command -v "$tool" >/dev/null 2>&1; then
      echo "$hook: required tool not found: $tool — this hook cannot read or judge events until it is installed" >&2
      missing=1
    fi
  done
  [ "$missing" = "0" ]
}

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
#
# All three of those exit 0, deliberately and without exception — which is what
# leaves the exit status free to carry the one thing empty output cannot say. A
# NON-ZERO exit from this function now has exactly one meaning: the interpreter
# itself failed (absent, shadowed, or crashing), so NO event can be read, this
# event included. That is the "must be loud" case in the header, and callers check
# for it rather than reading the empty string as "nothing to act on" — the two were
# indistinguishable before, which is how a missing binary could silently switch
# edit-time lint off for a whole session and leave every edit looking clean (#102).
#
# Hence the JS below exits 0 on every shape it understands, however odd: a null or
# array or scalar encountered mid-path, a key that is not there, a value that is not
# a string. Only the interpreter failing to run the program at all gets to be loud.
hook_event_field() {
  printf '%s' "$1" | "$HOOK_NODE_CMD" -e 'let n;try{n=JSON.parse(require("fs").readFileSync(0,"utf8"))}catch(e){process.exit(0)};for(const k of process.argv[1].split(".")){if(n===null||typeof n!=="object"||Array.isArray(n))process.exit(0);n=n[k]}console.log(typeof n==="string"?n:"")' "$2"
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
