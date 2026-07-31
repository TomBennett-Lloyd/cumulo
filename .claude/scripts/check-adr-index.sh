#!/usr/bin/env bash
# ADR index consistency gate: docs/adr/README.md's "## Index" must agree with the
# NNNN-*.md files sitting next to it, in both directions.
#
#   file -> index   every docs/adr/NNNN-*.md (0000-template.md excepted) has an index row
#   index -> file   every index row links to a file that exists, under the row's own number
#   status          every such file carries a `Status:` line from the template's vocabulary
#   supersession    every `superseded by NNNN` — in a Status line or an index-row annotation
#                   — names an ADR file that actually exists
#
# Wired into the root `verify` composite (CLAUDE.md: gates join `verify`, never a
# hand-picked subset), so `pnpm verify`, the CI `checks` job and any human running
# the composite all enforce it. It lives in .claude/scripts/ alongside the repo's
# other shell gates and their harnesses.
#
# No dependencies: bash only, and bash 3.2 only (macOS ships 3.2 as /bin/bash, so
# no associative arrays here — seen-sets are space-delimited strings).
#
# Usage: bash .claude/scripts/check-adr-index.sh [ADR_DIR]   (or `pnpm check:adr-index`)
#        ADR_DIR defaults to docs/adr next to this script's repo root; the argument
#        exists so the test harness can point the gate at throwaway fixtures.
# Exit:  0 index and files agree, 1 they disagree, 2 the invocation itself was wrong.
set -uo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd) || exit 2
ADR_DIR=${1:-"$SCRIPT_DIR/../../docs/adr"}

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

# --- ADR-number and supersession helpers -------------------------------------------------

adr_number_exists() { # adr_number_exists <adr-dir> <NNNN>
  local dir="$1" number="$2" hit
  local hits=()
  shopt -s nullglob
  hits=("$dir/$number"-*.md)
  shopt -u nullglob
  # Same `${a[@]+…}` guard as the file sweep below: bash 3.2 under `set -u` aborts on an
  # empty array's `[@]`, and "no file for that number" is precisely the answer wanted here.
  for hit in ${hits[@]+"${hits[@]}"}; do
    # The template is a form, not a decision — nothing can be superseded by 0000.
    [ "${hit##*/}" = "$TEMPLATE" ] || return 0
  done
  return 1
}

# A supersession pointer is a promise that another decision exists; unchecked, the index can
# claim a decision was replaced by an ADR nobody ever wrote. Every `superseded by NNNN` in
# <text> is resolved against the directory, whether it came from a Status line or a row
# annotation — <what> names the source so the error points at the line to fix.
check_supersessions() { # check_supersessions <adr-dir> <text> <what>
  local dir="$1" text="$2" what="$3" number
  local sup_re='superseded by ([0-9][0-9][0-9][0-9])'
  while [[ $text =~ $sup_re ]]; do
    number=${BASH_REMATCH[1]}
    if ! adr_number_exists "$dir" "$number"; then
      fail "$what says 'superseded by $number', but no ADR $number exists in $dir"
    fi
    # The match is leftmost, so this literal removal always shortens the string.
    text=${text#*"superseded by $number"}
  done
}

# Prints the ADR's Status value, or nothing when the header carries no `Status:` line with a
# value. Only the header counts — everything above the first `## ` section — so prose in a
# Context section may use the word without becoming the ADR's status. Deliberately tolerant
# about the markup around the label (bullet, bold, both, neither) and strict about the value:
# the vocabulary is what the gate is for, not whether someone wrote `**Status:**`.
adr_status_value() { # adr_status_value <file>
  local line value
  local status_re='^[[:space:]]*([-*+][[:space:]]+)?\**Status:\**[[:space:]]*(.*)$'
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      '## '*) return 0 ;;
    esac
    if [[ $line =~ $status_re ]]; then
      value=${BASH_REMATCH[2]}
      printf '%s' "${value%"${value##*[![:space:]]}"}"
      return 0
    fi
  done <"$1"
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

# Markdown allows -, * or + as the bullet marker and permits leading indentation; a gate that
# recognised only a column-1 hyphen would read every other spelling as prose and skip it.
#
# The trailing group is the annotation: an optional ` — <text>` suffix (em dash, a space on
# each side, non-empty text), which is where a supersession is recorded — ADRs are immutable
# once merged, so `- [0002 — Storage split](0002-storage-split.md) — superseded by 0007` is
# the shape the policy needs from the index. Optional, structured and still anchored at `$`:
# a suffix that misses the ` — ` separator, or that trails an empty one, is a malformed row
# rather than free text the gate would have to wave through.
row_re='^[[:space:]]*[-*+][[:space:]]+\[([0-9][0-9][0-9][0-9])[^]]*\]\(([^)]+)\)([[:space:]]+—[[:space:]]+[^[:space:]].*)?[[:space:]]*$'

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
  # Bullets are index rows whatever their marker and however they are indented; anything else
  # in the section (blank lines, prose) is not. Strip the leading whitespace before asking,
  # because a `case` glob cannot express "optional indentation" without extglob.
  trimmed=${line#"${line%%[![:space:]]*}"}
  case "$trimmed" in
    [-*+]*) ;;
    *) continue ;;
  esac

  if [[ $line =~ $row_re ]]; then
    num=${BASH_REMATCH[1]}
    target=${BASH_REMATCH[2]}
    annotation=${BASH_REMATCH[3]}
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

  check_supersessions "$ADR_DIR" "$annotation" "the annotation on index row $num"
done <"$readme"

if [ "$saw_index_heading" = 0 ]; then
  fail "$readme has no '## Index' section for this gate to check"
elif [ "$rows" = 0 ]; then
  fail "the '## Index' section in $readme lists no ADRs"
fi

# --- file -> index, and each file's own Status ---------------------------------------------

shopt -s nullglob
adr_files=("$ADR_DIR"/[0-9][0-9][0-9][0-9]-*.md)
shopt -u nullglob

indexed=0
disk_numbers=" "
# `${a[@]+"${a[@]}"}` rather than `"${adr_files[@]}"`: under `set -u`, bash 3.2 treats an empty
# array's `[@]` as an unbound variable and aborts — which is exactly the no-ADR-files case the
# guard below exists to report, so the plain form would kill the check before it could speak.
for path in ${adr_files[@]+"${adr_files[@]}"}; do
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

  # The vocabulary is the template's, verbatim and lower-case (0000-template.md: "proposed |
  # accepted | superseded by NNNN"). An ADR whose status is a free-text variant is a decision
  # whose standing cannot be read mechanically, which is how a superseded ADR goes on being
  # cited as current.
  status=$(adr_status_value "$path")
  case "$status" in
    proposed | accepted) ;;
    'superseded by '[0-9][0-9][0-9][0-9])
      check_supersessions "$ADR_DIR" "$status" "the Status of $base"
      ;;
    '') fail "ADR file $base has no 'Status:' line with a value (expected '- **Status:** accepted')" ;;
    *) fail "ADR file $base has Status '$status'; expected proposed, accepted, or 'superseded by NNNN'" ;;
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

printf 'check-adr-index: OK — %d ADRs, index, statuses and supersessions all agree (%s)\n' \
  "$indexed" "$ADR_DIR"
