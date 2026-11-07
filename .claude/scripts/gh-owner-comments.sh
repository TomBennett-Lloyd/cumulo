#!/usr/bin/env bash
#
# The mechanical filter for GitHub text the workflow reads (docs/standards/security.md rule 6;
# #720). The repo is public, so anyone can comment on an issue or open one: what a lane takes as
# an instruction, a decision or plan state (a PROCEED, a plan comment, an issue body) must be the
# owner's. This script is the read that does that; gh-owner-comments.mjs owns the predicate.
# The files that rely on it are listed in .claude/ledgers/owner-comment-filter.ledger.
#
# Usage:
#   bash .claude/scripts/gh-owner-comments.sh [--json] <issue|pr> <n>
#   bash .claude/scripts/gh-owner-comments.sh --untrusted <issue|pr> <n>
#
# Default: the owner-authored records only (the issue or PR body, its comments and, for `pr`,
# review comments and reviews), as text or --json. In text mode everyone else's are counted on stderr.
# --untrusted: the rest, as one JSON object marked `"untrusted": true`; who reads it is
# docs/standards/security.md rule 6.
#
# Exit:  0 ok; 2 gh failed, the owner login was unreadable, or bad usage (nothing is printed:
#        fail closed); 3 the issue or PR itself was not written by the owner, so it is no spec
#        to plan or dispatch from (the owner's own comments on it still print).
set -uo pipefail
export PATH="$PATH:/opt/homebrew/bin"

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd) || exit 2

forward=()
kind=""
number=""
for arg in "$@"; do
  case "$arg" in
    --json | --untrusted) forward+=("$arg") ;;
    -*)
      printf 'gh-owner-comments: unknown flag %s\n' "$arg" >&2
      exit 2
      ;;
    *)
      if [ -z "$kind" ]; then
        kind="$arg"
      elif [ -z "$number" ]; then
        number="$arg"
      else
        printf 'gh-owner-comments: unexpected extra argument %s\n' "$arg" >&2
        exit 2
      fi
      ;;
  esac
done
case "$kind" in issue | pr) ;; *)
  printf 'usage: gh-owner-comments.sh [--json|--untrusted] <issue|pr> <n>\n' >&2
  exit 2
  ;;
esac
case "$number" in '' | *[!0-9]*)
  printf 'gh-owner-comments: <n> must be a number, got "%s"\n' "$number" >&2
  exit 2
  ;;
esac

tmp=$(mktemp -d "${TMPDIR:-/tmp}/gh-owner-comments.XXXXXX") || exit 2
trap 'rm -rf "$tmp"' EXIT

fetch() { # fetch <out> <gh args…>
  local out="$1"
  shift
  if ! gh "$@" >"$out" 2>"$tmp/err"; then
    printf 'gh-owner-comments: gh %s failed: %s\n' "$*" "$(cat "$tmp/err")" >&2
    exit 2
  fi
}

fetch "$tmp/owner.json" repo view --json owner
fetch "$tmp/subject.json" api "repos/{owner}/{repo}/issues/$number"
fetch "$tmp/comments.json" api --paginate --slurp "repos/{owner}/{repo}/issues/$number/comments"
files=("$tmp/owner.json" "$tmp/subject.json" "$tmp/comments.json")
if [ "$kind" = pr ]; then
  fetch "$tmp/review-comments.json" api --paginate --slurp "repos/{owner}/{repo}/pulls/$number/comments"
  fetch "$tmp/reviews.json" api --paginate --slurp "repos/{owner}/{repo}/pulls/$number/reviews"
  files+=("$tmp/review-comments.json" "$tmp/reviews.json")
fi

node "$script_dir/gh-owner-comments.mjs" report "${files[@]}" ${forward[@]+"${forward[@]}"}
