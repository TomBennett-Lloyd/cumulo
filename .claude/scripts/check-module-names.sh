#!/usr/bin/env bash
# Module-naming gate: nothing under packages/ or apps/ may be named bare "utils".
#
#   file        utils.ts, utils.tsx, utils.mts, utils.cts, utils.js, utils.mjs
#   directory   any directory named exactly "utils"
#
# docs/standards/structure.md rule 6 and architecture.md rule 5: names carry
# context even when the folder already provides some, and a module with no domain
# name is a question about whether the code belongs here at all. That question is
# never asked once the dumping ground exists, which is why this is a gate and not
# a review convention — "utils" is only ever created in the moment nobody wants to
# think about naming, and review is downstream of that moment.
#
# Deliberately narrow: it bans the bare name, not the substring. "date-utils.ts"
# passes, because it says what it is; a gate that also rejected that would be
# reaching past the rule it enforces and would get itself suppressed.
#
# Wired into the root `verify` composite (CLAUDE.md: gates join `verify`, never a
# hand-picked subset), so `pnpm verify`, the CI `checks` job and any human running
# the composite all enforce it.
#
# No dependencies: bash (3.2, which macOS ships as /bin/bash) and find only.
#
# Usage: bash .claude/scripts/check-module-names.sh [REPO_ROOT]
#        (or `pnpm check:module-names`)
#        REPO_ROOT defaults to the repo root above this script; the argument
#        exists so the test harness can point the gate at throwaway fixtures.
# Exit:  0 no banned names, 1 at least one, 2 the invocation itself was wrong.
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd) || exit 2
ROOT=${1:-"$SCRIPT_DIR/../.."}

if [ ! -d "$ROOT" ]; then
  printf 'check-module-names: not a directory: %s\n' "$ROOT" >&2
  exit 2
fi
ROOT=$(cd "$ROOT" && pwd -P) || exit 2

# The source trees this standard governs. infra/ is Terraform and .claude/ is
# shell; neither has TypeScript modules to misname.
SOURCE_DIRS=(packages apps)

# Built artefacts and vendored code are somebody else's naming decisions, and a
# dist/ mirror of a source tree would double-report every real offender.
PRUNED_DIRS=(node_modules dist coverage)

BANNED_STEM=utils
MODULE_EXTENSIONS=(ts tsx mts cts js mjs)

# --- find expressions ---------------------------------------------------------------------
# Both -name lists are generated from the one extension list, so an extension added
# for the ban cannot be forgotten in the census that proves the ban looked at anything.

prune_clause=()
for dir in "${PRUNED_DIRS[@]}"; do
  [ ${#prune_clause[@]} -eq 0 ] || prune_clause+=(-o)
  prune_clause+=(-name "$dir")
done

banned_names=()
any_module_names=()
for ext in "${MODULE_EXTENSIONS[@]}"; do
  if [ ${#banned_names[@]} -gt 0 ]; then
    banned_names+=(-o)
    any_module_names+=(-o)
  fi
  banned_names+=(-name "$BANNED_STEM.$ext")
  any_module_names+=(-name "*.$ext")
done

# --- what to search -----------------------------------------------------------------------

search_dirs=()
for dir in "${SOURCE_DIRS[@]}"; do
  if [ -d "$ROOT/$dir" ]; then
    search_dirs+=("$ROOT/$dir")
  fi
done

# Green-by-absence is the failure mode a path-based gate dies of: point it at a
# moved or renamed tree and "nothing to check" must not read as "fine".
if [ ${#search_dirs[@]} -eq 0 ]; then
  printf 'check-module-names: none of these exist under %s: %s\n' \
    "$ROOT" "${SOURCE_DIRS[*]}" >&2
  exit 2
fi

tmp=$(mktemp) || exit 2
trap 'rm -f "$tmp"' EXIT INT TERM

# --- the census: did the search reach any modules at all? -----------------------------------

if ! find "${search_dirs[@]}" \
  '(' "${prune_clause[@]}" ')' -prune -o \
  -type f '(' "${any_module_names[@]}" ')' -print0 >"$tmp"; then
  printf 'check-module-names: find failed while scanning %s\n' "${search_dirs[*]}" >&2
  exit 2
fi

modules=0
while IFS= read -r -d '' _path; do
  modules=$((modules + 1))
done <"$tmp"

if [ "$modules" -eq 0 ]; then
  printf 'check-module-names: no modules (%s) found under %s — the filter is broken, not the repo\n' \
    "${MODULE_EXTENSIONS[*]}" "${search_dirs[*]}" >&2
  exit 2
fi

# --- the ban ------------------------------------------------------------------------------

if ! find "${search_dirs[@]}" \
  '(' "${prune_clause[@]}" ')' -prune -o \
  '(' -type d -name "$BANNED_STEM" -o -type f '(' "${banned_names[@]}" ')' ')' -print0 >"$tmp"; then
  printf 'check-module-names: find failed while scanning %s\n' "${search_dirs[*]}" >&2
  exit 2
fi

offenders=()
while IFS= read -r -d '' path; do
  offenders+=("${path#"$ROOT/"}")
done <"$tmp"

if [ ${#offenders[@]} -ne 0 ]; then
  printf '\ncheck-module-names: %d banned module name(s) — a module is never named bare "%s"\n' \
    "${#offenders[@]}" "$BANNED_STEM" >&2
  for offender in "${offenders[@]}"; do
    printf '  ERROR %s\n' "$offender" >&2
  done
  printf '\nName it for what it does (docs/standards/structure.md rule 6). If it does several\n' >&2
  printf 'unrelated things, that is the finding — split it, do not rename it.\n' >&2
  exit 1
fi

printf 'check-module-names: OK — no bare "%s" modules in %s (%d modules scanned)\n' \
  "$BANNED_STEM" "${SOURCE_DIRS[*]}" "$modules"
