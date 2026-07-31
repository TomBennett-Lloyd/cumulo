#!/usr/bin/env bash
# ADR index consistency gate: docs/adr/README.md's "## Index" must agree with the
# NNNN-*.md files sitting next to it, in both directions.
#
#   file -> index   every docs/adr/NNNN-*.md (0000-template.md excepted) has an index row
#   index -> file   every index row links to a file that exists, under the row's own number
#
# Wired into the root `verify` composite (CLAUDE.md: gates join `verify`, never a
# hand-picked subset), so `pnpm verify`, the CI `checks` job and any human running
# the composite all enforce it. Lives in scripts/ rather than .claude/scripts/
# because it is a repo gate every contributor runs, not agent lifecycle tooling.
#
# No dependencies: bash only, and bash 3.2 only (macOS ships 3.2 as /bin/bash, so
# no associative arrays here — seen-sets are space-delimited strings).
#
# Usage: bash scripts/check-adr-index.sh [ADR_DIR]   (or `pnpm check:adr-index`)
#        ADR_DIR defaults to docs/adr next to this script's repo root; the argument
#        exists so the test harness can point the gate at throwaway fixtures.
# Exit:  0 index and files agree, 1 they disagree, 2 the invocation itself was wrong.
set -uo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd) || exit 2
ADR_DIR=${1:-"$SCRIPT_DIR/../docs/adr"}

TEMPLATE=0000-template.md

if [ ! -d "$ADR_DIR" ]; then
  printf 'check-adr-index: not a directory: %s\n' "$ADR_DIR" >&2
  exit 2
fi
ADR_DIR=$(cd "$ADR_DIR" && pwd -P) || exit 2

errors=0
fail() {
  printf '  ERROR %s\n' "$1" >&2
  errors=$((errors + 1))
}

readme="$ADR_DIR/README.md"
if [ ! -f "$readme" ]; then
  fail "no index file at $readme"
  printf '\ncheck-adr-index: %d problem(s) in %s\n' "$errors" "$ADR_DIR" >&2
  exit 1
fi

# --- index -> file ------------------------------------------------------------------------
# Only the "## Index" section counts. The prose above it legitimately links the template and
# other docs, and a gate that treated every link in the file as an index row would both miss
# real drift and invent fake drift.

# Space-delimited seen-sets, always kept " a b c " shaped so a `*" $x "*` match is exact.
seen_targets=" "
seen_numbers=" "
rows=0
saw_index_heading=0
in_index=0

row_re='^-[[:space:]]+\[([0-9][0-9][0-9][0-9])[^]]*\]\(([^)]+)\)[[:space:]]*$'

while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in
    '## Index'*)
      saw_index_heading=1
      in_index=1
      continue
      ;;
    '#'*)
      in_index=0
      continue
      ;;
  esac
  [ "$in_index" = 1 ] || continue
  # Bullets are index rows; anything else in the section (blank lines, prose) is not.
  case "$line" in
    '-'*) ;;
    *) continue ;;
  esac

  if [[ $line =~ $row_re ]]; then
    num=${BASH_REMATCH[1]}
    target=${BASH_REMATCH[2]}
  else
    # Never skip an unrecognised bullet: a row this gate cannot read is a row it cannot
    # check, and silently ignoring it is how the index drifts while the gate stays green.
    fail "index row is not in the '- [NNNN — Title](NNNN-slug.md)' form: $line"
    continue
  fi

  rows=$((rows + 1))

  case "$seen_targets" in
    *" $target "*) fail "index lists $target more than once" ;;
    *) seen_targets="$seen_targets$target " ;;
  esac
  case "$seen_numbers" in
    *" $num "*) fail "index uses ADR number $num more than once" ;;
    *) seen_numbers="$seen_numbers$num " ;;
  esac

  if [ ! -f "$ADR_DIR/$target" ]; then
    fail "index row $num links to a file that does not exist: $target"
  fi
  case "$target" in
    "$num"-*) ;;
    *) fail "index row $num links to $target, which is not numbered $num" ;;
  esac
done <"$readme"

if [ "$saw_index_heading" = 0 ]; then
  fail "$readme has no '## Index' section for this gate to check"
elif [ "$rows" = 0 ]; then
  fail "the '## Index' section in $readme lists no ADRs"
fi

# --- file -> index ------------------------------------------------------------------------

shopt -s nullglob
adr_files=("$ADR_DIR"/[0-9][0-9][0-9][0-9]-*.md)
shopt -u nullglob

indexed=0
disk_numbers=" "
for path in "${adr_files[@]}"; do
  base=${path##*/}
  [ "$base" = "$TEMPLATE" ] && continue
  indexed=$((indexed + 1))

  number=${base%%-*}
  case "$disk_numbers" in
    *" $number "*) fail "two ADR files share number $number (one of them is $base)" ;;
    *) disk_numbers="$disk_numbers$number " ;;
  esac

  case "$seen_targets" in
    *" $base "*) ;;
    *) fail "ADR file $base is not listed in the index in $readme" ;;
  esac
done

# A check that passes because it found nothing to check is indistinguishable from a check
# that works — the wrong-directory case has to be loud.
if [ "$indexed" = 0 ]; then
  fail "no ADR files (NNNN-*.md, excluding $TEMPLATE) found in $ADR_DIR"
fi

if [ "$errors" != 0 ]; then
  printf '\ncheck-adr-index: %d problem(s) — %s and its ADR files disagree.\n' \
    "$errors" "$readme" >&2
  exit 1
fi

printf 'check-adr-index: OK — %d ADRs, index and files agree (%s)\n' "$indexed" "$ADR_DIR"
