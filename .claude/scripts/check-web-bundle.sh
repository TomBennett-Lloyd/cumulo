#!/usr/bin/env bash
# Bundle gate for apps/web: asserts the dist-level properties of the production
# build that no source-level test can see.
#
#   entry budget      dist/assets/index-*.js stays under ENTRY_BUDGET_BYTES
#   gallery contained no design-token gallery bytes reach dist/
#
# Both properties are about *build output*, and `pnpm verify` has never produced
# any (#142): the standing guards are source-text proxies
# (apps/web/src/dashboard/map-region-split-contract.test.ts,
# apps/web/src/preview/tokens-harness-contract.test.ts) that read import
# statements off disk. They catch the one regression that was likely — a static
# import re-fusing the lazy map chunk — and are blind to everything else: a new
# heavy dependency landing in the entry, a manualChunks change. This gate
# measures the artefact instead, so those cases fail on a number rather than on
# nobody noticing.
#
# What a green run does NOT say, so it is not read for more than it holds: the
# budget is a statement about dist/assets/index-*.js and only that file. Weight
# that lands beside it passes untouched — a second module script in index.html
# emits its own asset this glob never sees — and so does weight that never
# reaches dist/ at all, such as a CDN `<script>` tag in index.html. The rest of
# dist/ is read only by the containment scan, which looks for gallery markers,
# not for size.
#
# The advisory half of the split is deliberately NOT here. Vite's
# `build.chunkSizeWarningLimit` (apps/web/vite.config.ts) owns the lazy map
# chunk's threshold and prints its warning in the build log; this script carries
# no second limit constant and would only give that number a place to drift. What
# it does instead is print every dist/assets file by size on success, so the
# advisory surface is visible in the same log as the enforced one.
#
# The script never builds. Its only interface is a repo root, so whoever has a
# build — the CI `web-build` job today, `pnpm verify` once #111 decides the
# repo-wide "verify builds" question — can call it unchanged.
#
# No dependencies: bash (3.2, which macOS ships as /bin/bash), find-free, grep,
# wc and sort only.
#
# Usage: bash .claude/scripts/check-web-bundle.sh [--print-budget] [REPO_ROOT]
#        REPO_ROOT defaults to the repo root above this script; the argument
#        exists so the test harness can point the gate at throwaway fixtures.
#        --print-budget prints ENTRY_BUDGET_BYTES and exits 0, so the harness can
#        size its over/under fixtures without restating the constant.
# Exit:  0 every assertion holds, 1 an assertion failed, 2 no verdict reached
#        (missing or stale build, a vacuous marker, a bad invocation).
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd) || exit 2

# --- the budget ---------------------------------------------------------------------------
#
# Derivation, so it cannot rot: 300,320 bytes measured on 2026-08-01 on the #142
# branch off main @ 30a138a, via
#
#     pnpm --filter @cumulo/web build && wc -c < apps/web/dist/assets/index-*.js
#
# rounded up to give ~15% headroom (300,320 x 1.15 = 345,368 -> 350,000). The
# headroom is for honest movement — a dependency patch, a refactor shuffling
# chunk composition — not for growth.
#
# The reset rule: a PR that DELIBERATELY grows the entry re-measures with the
# command above, resets this constant to new-measured + ~15%, and rewrites this
# comment with its own derivation, in the same PR. An ACCIDENTAL breach is not a
# reason to raise the number — it means finding the dependency that crept into
# the entry chunk and deciding whether it belongs there.
#
# Single owner: this constant is the only enforced copy. .github/workflows/ci.yml
# invokes this script and never restates the number; architecture.md rule 8's
# mirror gate does not apply (there is no Terraform side), but its reasoning does
# — a second copy is a copy that drifts silently in the permissive direction.
ENTRY_BUDGET_BYTES=350000

# --- arguments ----------------------------------------------------------------------------

print_budget=0
root_arg=""

while [ $# -gt 0 ]; do
  case "$1" in
    --print-budget)
      print_budget=1
      ;;
    -*)
      printf 'check-web-bundle: unknown option %s\n' "$1" >&2
      exit 2
      ;;
    *)
      if [ -n "$root_arg" ]; then
        printf 'check-web-bundle: expected at most one REPO_ROOT, got a second: %s\n' "$1" >&2
        exit 2
      fi
      root_arg="$1"
      ;;
  esac
  shift
done

if [ "$print_budget" = "1" ]; then
  printf '%s\n' "$ENTRY_BUDGET_BYTES"
  exit 0
fi

ROOT=${root_arg:-"$SCRIPT_DIR/../.."}

if [ ! -d "$ROOT" ]; then
  printf 'check-web-bundle: not a directory: %s\n' "$ROOT" >&2
  exit 2
fi
ROOT=$(cd "$ROOT" && pwd -P) || exit 2

WEB_DIR=apps/web
DIST_DIR="$ROOT/$WEB_DIR/dist"
ASSETS_DIR="$DIST_DIR/assets"
PREVIEW_SRC="$ROOT/$WEB_DIR/src/preview"
HARNESS_DOCUMENT="$ROOT/$WEB_DIR/tokens.html"

# The gallery markers, chosen by elimination in #149 and re-justified here
# because this gate is now their enforcer: `swatch-chip` is a class emitted only
# by src/preview/preview.css, and `Direction B` is palette prose that appears only
# in src/preview/TokensPreview.tsx. Rejected candidates: `TokensPreview` (a
# component name minification erases) and `Meridian` (survives in the shipped
# token comments regardless).
#
# One list, two uses: the census below proves each marker still exists in the
# gallery source, and the containment scan proves none of them reaches dist/. A
# marker added to the ban without the census would be a grep that can only ever
# pass. The census reads non-test source only — see its own comment for why.
MARKERS=('swatch-chip' 'Direction B')

no_build() {
  printf 'check-web-bundle: no build to check at %s/dist/assets — run "pnpm --filter @cumulo/web build" first\n' \
    "$WEB_DIR" >&2
  exit 2
}

# The vacuity exit: a marker that no longer appears in the gallery source makes
# the containment scan a grep for a string nothing emits, which passes forever
# while measuring nothing.
vacuous() { # vacuous <what moved>
  printf '\ncheck-web-bundle: %s\n' "$1" >&2
  printf '\nThe token gallery has moved or been renamed, so the containment scan below it\n' >&2
  printf 'would pass by matching nothing. Update the markers in this script deliberately\n' >&2
  printf '(MARKERS, and the derivation comment above it) — never delete the check.\n' >&2
  exit 2
}

file_bytes() { # file_bytes <path>
  wc -c <"$1" | tr -d '[:space:]'
}

# --- 1. there is a build at all -------------------------------------------------------------

[ -d "$ASSETS_DIR" ] || no_build

# --- 2. exactly one entry chunk -------------------------------------------------------------
#
# A local dist that was never cleaned accumulates one index-<hash>.js per build.
# Picking one arbitrarily would measure whichever hash sorts first, which is a
# verdict about a file nobody is shipping.

entries=()
for candidate in "$ASSETS_DIR"/index-*.js; do
  [ -f "$candidate" ] || continue
  entries+=("$candidate")
done

[ ${#entries[@]} -ne 0 ] || no_build

if [ ${#entries[@]} -gt 1 ]; then
  printf '\ncheck-web-bundle: %d index-*.js files in %s/dist/assets — stale artefacts\n' \
    "${#entries[@]}" "$WEB_DIR" >&2
  for stale in "${entries[@]}"; do
    printf '  %s\n' "${stale#"$ROOT/"}" >&2
  done
  printf '\nOnly one of these is the current entry chunk and this gate cannot tell which.\n' >&2
  printf 'Run "rm -rf apps/web/dist" and rebuild.\n' >&2
  exit 2
fi

entry=${entries[0]}

# --- 3. the marker census (vacuity guard) ---------------------------------------------------
#
# Test files are excluded, and that exclusion is the whole check: src/preview/
# holds tokens-harness-contract.test.ts, whose header quotes both markers as
# prose because it documents this gate. A census that read it would stay
# satisfied after the real emitters had been renamed — green while the
# containment scan below had rotted into a grep for strings nothing emits, which
# is the one failure this section exists to prevent (found in review of #142).
# Only source that can actually put a marker into dist/ may vouch for it.
#
# `--exclude` is a GNU/BSD grep extension rather than POSIX — the one place this
# script reaches past a plain grep. Both greps it can meet carry it: BSD grep
# 2.6.0 (macOS, checked directly) and GNU grep (the CI runner). If a third ever
# appears, enumerate the emitter files instead of widening this flag.

[ -d "$PREVIEW_SRC" ] || vacuous "no $WEB_DIR/src/preview directory under $ROOT"

for marker in "${MARKERS[@]}"; do
  if ! grep -rqF --exclude='*.test.*' -- "$marker" "$PREVIEW_SRC"; then
    vacuous "the marker '$marker' no longer appears in non-test source under $WEB_DIR/src/preview"
  fi
done

[ -e "$HARNESS_DOCUMENT" ] || vacuous "no $WEB_DIR/tokens.html — the gallery's own document is gone"

# --- 4. the entry budget (hard) -------------------------------------------------------------

entry_bytes=$(file_bytes "$entry") || exit 2

if [ "$entry_bytes" -gt "$ENTRY_BUDGET_BYTES" ]; then
  printf '\ncheck-web-bundle: entry chunk over budget\n' >&2
  printf '  file    %s\n' "${entry#"$ROOT/"}" >&2
  printf '  actual  %s bytes\n' "$entry_bytes" >&2
  printf '  budget  %s bytes\n' "$ENTRY_BUDGET_BYTES" >&2
  printf '  over by %s bytes\n' "$((entry_bytes - ENTRY_BUDGET_BYTES))" >&2
  printf '\nIf this growth is deliberate, re-measure and reset ENTRY_BUDGET_BYTES to\n' >&2
  printf 'new-measured + ~15%% in this same PR, with the new derivation in its comment.\n' >&2
  printf 'If it is not, find the dependency that crept into the entry chunk — the map is\n' >&2
  printf 'lazy for this reason, and a static import re-fuses it.\n' >&2
  exit 1
fi

# --- 5. gallery containment (hard) ----------------------------------------------------------

offenders=()

if [ -e "$DIST_DIR/tokens.html" ]; then
  offenders+=("$WEB_DIR/dist/tokens.html — the gallery's document was emitted into the build")
fi

for marker in "${MARKERS[@]}"; do
  hits=$(grep -rlF -- "$marker" "$DIST_DIR") && grep_rc=0 || grep_rc=$?
  if [ "$grep_rc" -gt 1 ]; then
    printf 'check-web-bundle: grep failed while scanning %s/dist for %s\n' "$WEB_DIR" "$marker" >&2
    exit 2
  fi
  [ "$grep_rc" -eq 0 ] || continue
  while IFS= read -r hit; do
    [ -n "$hit" ] || continue
    offenders+=("${hit#"$ROOT/"} — contains the gallery marker '$marker'")
  done <<EOF
$hits
EOF
done

if [ ${#offenders[@]} -ne 0 ]; then
  printf '\ncheck-web-bundle: the token gallery reached the production build\n' >&2
  for offender in "${offenders[@]}"; do
    printf '  ERROR %s\n' "$offender" >&2
  done
  printf '\nThe gallery is dev-server-only: tokens.html is not a build input, and nothing\n' >&2
  printf 'the shipped entry reaches may import from src/preview/. Find the import (a\n' >&2
  printf 'stylesheet side-effect import is the easiest one to add by accident).\n' >&2
  exit 1
fi

# --- 6. the verdict, plus the advisory listing ----------------------------------------------

printf 'check-web-bundle: OK — entry %s bytes of %s budget (%s%% headroom): %s\n' \
  "$entry_bytes" "$ENTRY_BUDGET_BYTES" \
  "$(((ENTRY_BUDGET_BYTES - entry_bytes) * 100 / ENTRY_BUDGET_BYTES))" \
  "${entry#"$ROOT/"}"
printf '\n%s/dist/assets by size (advisory — the lazy chunk threshold is\n' "$WEB_DIR"
printf 'build.chunkSizeWarningLimit in %s/vite.config.ts, which warns in the build log):\n' "$WEB_DIR"

for asset in "$ASSETS_DIR"/*; do
  [ -f "$asset" ] || continue
  printf '%12s  %s\n' "$(file_bytes "$asset")" "${asset#"$ROOT/"}"
done | sort -rn
