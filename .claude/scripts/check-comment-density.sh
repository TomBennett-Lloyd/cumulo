#!/usr/bin/env bash
#
# Comment-density ratchet (#553): a source file's ratio of comment lines to
# non-blank lines may fall, never rise.
#
# Scope: every non-test `.ts`/`.tsx` file under `apps/*/src` and `packages/*/src`.
# `.test.*` and `.spec.*` are excluded — docs/standards/testing.md rule 10 splits
# those lanes, and a test's prose is its own question. `.sh` is NOT scanned: those
# trees contain none, and the repository's shell lives under `.claude/scripts/`,
# which this gate's scope does not reach (#554).
#
# WHAT A COMMENT LINE IS, and it is a definition rather than a measurement. A
# non-blank line counts as a comment line when it lies inside a block comment, or
# when its first non-space characters are `//`, `/*`, `{/*` or `*`. A line that
# closes a comment and then carries code is a code line. Blank lines are in
# neither count. The classifier is line-anchored and string-unaware, so a line
# inside a multi-line template literal that begins with one of those tokens is
# counted as a comment; the proxy is applied identically to the baseline and to
# the working tree, so the comparison holds even where the absolute figure is off.
#
# BASELINE — `.claude/comment-density.baseline.tsv`, one `path<TAB>ratio` row per
# file, ratio in basis points (`6022` = 60.22%). Integer, so the comparison needs
# no float arithmetic, and fine-grained enough that one added comment line always
# moves the figure for any file this repository holds. A file with no row is
# admitted at or below the median of the baseline's own rows — the committed
# population, not the current scan, so a batch of new dense files cannot lift the
# bar it is judged against.
#
# `--ratchet` is what a trim batch commits. It runs the gate first and writes
# NOTHING if anything is red: a half-lowered baseline banked by a failing run is
# worse than no write at all. On a green run it lowers every row whose ratio fell,
# adds a row for each admitted new file, drops rows for files that no longer
# exist, and prints what moved. It never raises a row.
#
# Wired into the root `verify` composite (CLAUDE.md: gates join `verify`, never a
# hand-picked subset) and into `.claude/scripts/verify-tier.sh`'s source-prose
# tier, which is the tier a comment-only change set lands on and therefore the one
# where this gate is the only thing that can observe the change.
#
# No dependencies: bash (3.2, which macOS ships as /bin/bash), find and awk, with
# no gawk extensions.
#
# Usage: bash .claude/scripts/check-comment-density.sh [--ratchet] [REPO_ROOT]
#        (or `pnpm check:comment-density`)
#        REPO_ROOT defaults to the repo root above this script; the argument
#        exists so the test harness can point the gate at throwaway fixtures.
# Exit:  0 every file at or below its row, 1 at least one above it, 2 the
#        invocation or the baseline's own state was wrong.
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd) || exit 2

BASELINE_REL=".claude/comment-density.baseline.tsv"
SOURCE_PARENTS=(apps packages)
SOURCE_SUBDIR=src
MODULE_EXTENSIONS=(ts tsx)
PRUNED_DIRS=(node_modules dist coverage)
# Basis points: the ratio's unit everywhere in this gate and in the baseline.
SCALE=10000

ratchet=0
root_arg=""

while [ $# -gt 0 ]; do
  case "$1" in
    --ratchet)
      ratchet=1
      ;;
    -h | --help)
      cat <<'EOF'
Usage: bash .claude/scripts/check-comment-density.sh [--ratchet] [REPO_ROOT]

  REPO_ROOT   repository to scan (default: the repo root above this script)
  --ratchet   on a green run, rewrite the baseline downward (never upward)

Exit: 0 pass, 1 at least one file above its baseline row, 2 no verdict reached.
EOF
      exit 0
      ;;
    -*)
      printf 'check-comment-density: unknown option %s\n' "$1" >&2
      exit 2
      ;;
    *)
      if [ -n "$root_arg" ]; then
        printf 'check-comment-density: expected at most one directory, got a second: %s\n' "$1" >&2
        exit 2
      fi
      root_arg="$1"
      ;;
  esac
  shift
done

ROOT=${root_arg:-"$SCRIPT_DIR/../.."}
if [ ! -d "$ROOT" ]; then
  printf 'check-comment-density: not a directory: %s\n' "$ROOT" >&2
  exit 2
fi
ROOT=$(cd "$ROOT" && pwd -P) || exit 2
BASELINE="$ROOT/$BASELINE_REL"

TMP=$(mktemp -d "${TMPDIR:-/tmp}/check-comment-density.XXXXXX") || exit 2
trap 'rm -rf "$TMP"' EXIT INT TERM

# --- what to scan -------------------------------------------------------------------------

search_dirs=()
for parent in "${SOURCE_PARENTS[@]}"; do
  [ -d "$ROOT/$parent" ] || continue
  for entry in "$ROOT/$parent"/*; do
    [ -d "$entry/$SOURCE_SUBDIR" ] && search_dirs+=("$entry/$SOURCE_SUBDIR")
  done
done

# Green-by-absence is what a path-based gate dies of: pointed at a moved or
# renamed tree, "nothing to check" must not read as "fine".
if [ ${#search_dirs[@]} -eq 0 ]; then
  printf 'check-comment-density: no %s/*/%s directory under %s\n' \
    "${SOURCE_PARENTS[0]}" "$SOURCE_SUBDIR" "$ROOT" >&2
  exit 2
fi

prune_clause=()
for dir in "${PRUNED_DIRS[@]}"; do
  [ ${#prune_clause[@]} -eq 0 ] || prune_clause+=(-o)
  prune_clause+=(-name "$dir")
done

# Both lists are generated from the one extension list, so an extension added to
# the scan cannot be forgotten in the exclusion that keeps tests out of it.
include_names=()
exclude_names=()
for ext in "${MODULE_EXTENSIONS[@]}"; do
  if [ ${#include_names[@]} -gt 0 ]; then
    include_names+=(-o)
    exclude_names+=(-o)
  fi
  include_names+=(-name "*.$ext")
  exclude_names+=(-name "*.test.$ext" -o -name "*.spec.$ext")
done

if ! find "${search_dirs[@]}" \
  '(' "${prune_clause[@]}" ')' -prune -o \
  -type f '(' "${include_names[@]}" ')' \
  ! '(' "${exclude_names[@]}" ')' -print >"$TMP/files"; then
  printf 'check-comment-density: find failed while scanning %s\n' "${search_dirs[*]}" >&2
  exit 2
fi

if ! LC_ALL=C sort -o "$TMP/files" "$TMP/files"; then
  printf 'check-comment-density: could not sort the discovered files\n' >&2
  exit 2
fi

files=()
while IFS= read -r path; do
  [ -n "$path" ] || continue
  files+=("$path")
done <"$TMP/files"

if [ ${#files[@]} -eq 0 ]; then
  printf 'check-comment-density: found no %s file under %s — the filter is broken, not the repo\n' \
    "${MODULE_EXTENSIONS[*]}" "${search_dirs[*]}" >&2
  exit 2
fi

# --- measure ------------------------------------------------------------------------------
# One awk pass over every file: `path<TAB>ratio<TAB>comment<TAB>non-blank`, paths
# relative to ROOT. Files are flushed on each FNR==1 and once more at END rather
# than with gawk's ENDFILE, which macOS awk does not have. A file with no
# non-blank line has no ratio to compare and is listed as unmeasurable rather than
# counted as zero.

if ! awk -v root="$ROOT/" -v scale="$SCALE" -v skipped="$TMP/unmeasurable" '
function tail_is_bare(rest) {
  sub(/^[ \t]*/, "", rest)
  sub(/^\}[ \t]*/, "", rest)
  sub(/[ \t]+$/, "", rest)
  if (rest == "") return 1
  return (substr(rest, 1, 2) == "//")
}
function flush() {
  if (name == "") return
  rel = substr(name, length(root) + 1)
  if (nonblank == 0) { print rel > skipped; return }
  printf "%s\t%d\t%d\t%d\n", rel, int(comment * scale / nonblank), comment, nonblank
}
FNR == 1 { flush(); name = FILENAME; in_block = 0; comment = 0; nonblank = 0 }
{
  t = $0
  sub(/^[ \t]+/, "", t)
  sub(/[ \t]+$/, "", t)
  if (t == "") next
  nonblank++
  if (in_block) {
    close_at = index(t, "*/")
    if (close_at == 0) { comment++; next }
    in_block = 0
    if (tail_is_bare(substr(t, close_at + 2))) comment++
    next
  }
  if (substr(t, 1, 2) == "//") { comment++; next }
  opener = (substr(t, 1, 2) == "/*") ? 1 : ((substr(t, 1, 3) == "{/*") ? 2 : 0)
  if (opener > 0) {
    body = substr(t, opener + 2)
    close_at = index(body, "*/")
    if (close_at == 0) { in_block = 1; comment++; next }
    if (tail_is_bare(substr(body, close_at + 2))) comment++
    next
  }
  if (substr(t, 1, 1) == "*") { comment++; next }
}
END { flush() }
' "${files[@]}" >"$TMP/current"; then
  printf 'check-comment-density: awk failed while measuring %d file(s)\n' "${#files[@]}" >&2
  exit 2
fi
: >>"$TMP/unmeasurable"

measured=$(grep -c '' <"$TMP/current" || true)
if [ "$measured" -eq 0 ]; then
  printf 'check-comment-density: measured none of the %d discovered file(s) — the classifier is broken\n' \
    "${#files[@]}" >&2
  exit 2
fi

# --- the baseline -------------------------------------------------------------------------

if [ ! -f "$BASELINE" ]; then
  if [ "$ratchet" = "0" ]; then
    printf 'check-comment-density: no baseline at %s\n' "$BASELINE_REL" >&2
    printf '  Create it with: bash .claude/scripts/check-comment-density.sh --ratchet\n' >&2
    exit 2
  fi
  : >"$TMP/base"
else
  # Comment and blank lines out; everything else must be exactly
  # `path<TAB>integer`, with no path twice. A baseline nobody can parse is a gate
  # with no opinion, so it is refused rather than partly believed.
  if ! awk -F'\t' -v scale="$SCALE" '
    /^#/ { next }
    /^[ \t]*$/ { next }
    NF != 2 {
      printf "  row %d has %d field(s), expected 2: %s\n", NR, NF, $0 > "/dev/stderr"
      bad = 1
      next
    }
    $2 !~ /^[0-9]+$/ || $2 + 0 > scale {
      printf "  row %d is not a ratio in 0-%d basis points: %s\n", NR, scale, $2 > "/dev/stderr"
      bad = 1
      next
    }
    $1 in seen {
      printf "  row %d repeats a path already in the baseline: %s\n", NR, $1 > "/dev/stderr"
      bad = 1
      next
    }
    { seen[$1] = 1; printf "%s\t%s\n", $1, $2 }
    END { exit bad ? 1 : 0 }
  ' "$BASELINE" >"$TMP/base"; then
    printf 'check-comment-density: %s is malformed (rows above)\n' "$BASELINE_REL" >&2
    exit 2
  fi
fi

baseline_rows=$(grep -c '' <"$TMP/base" || true)

# The median of the committed population. A missing baseline under --ratchet has
# none and admits every file at its current ratio — the bootstrap run, the only
# one that pins files with no bar to pin them against.
if [ "$baseline_rows" -gt 0 ]; then
  median=$(cut -f2 "$TMP/base" | LC_ALL=C sort -n |
    awk '{ a[NR] = $1 } END { print a[int((NR + 1) / 2)] }') || exit 2
  if [ -z "$median" ]; then
    printf 'check-comment-density: could not compute the median of %d baseline row(s)\n' \
      "$baseline_rows" >&2
    exit 2
  fi
else
  median=$SCALE
fi

# --- compare ------------------------------------------------------------------------------

# The baseline arm is selected by FILENAME, never by the `NR == FNR` idiom: that
# idiom reads "still on the first file", and with an EMPTY first file it is true
# for every record of the second one as well — the bootstrap run, whose baseline
# is empty by construction, would load the whole scan as its own baseline and
# compare nothing.
if ! awk -F'\t' \
  -v basefile="$TMP/base" -v median="$median" -v scale="$SCALE" \
  -v viol="$TMP/violations" -v lowered="$TMP/lowered" \
  -v added="$TMP/added" -v dropped="$TMP/dropped" -v newbase="$TMP/newbase" '
function pct(bp) { return sprintf("%.2f%% (%d)", bp / (scale / 100), bp) }
FILENAME == basefile { base[$1] = $2; unseen[$1] = 1; next }
{
  path = $1
  cur = $2
  if (path in base) {
    b = base[path]
    delete unseen[path]
    if (cur > b) {
      printf "  ERROR %s: %s > baseline %s — %d comment / %d non-blank line(s)\n",
        path, pct(cur), pct(b), $3, $4 > viol
      next
    }
    if (cur < b) printf "  %s: %s -> %s\n", path, pct(b), pct(cur) > lowered
    printf "%s\t%d\n", path, (cur < b ? cur : b) > newbase
    next
  }
  if (cur > median) {
    printf "  ERROR %s: %s > repo median %s — a file with no baseline row is admitted at or below the median\n",
      path, pct(cur), pct(median) > viol
    next
  }
  printf "  %s: %s (new row)\n", path, pct(cur) > added
  printf "%s\t%d\n", path, cur > newbase
}
END { for (p in unseen) printf "  %s\n", p > dropped }
' "$TMP/base" "$TMP/current"; then
  printf 'check-comment-density: comparison against %s failed\n' "$BASELINE_REL" >&2
  exit 2
fi
for section in violations lowered added dropped newbase; do : >>"$TMP/$section"; done

violation_count=$(grep -c '' <"$TMP/violations" || true)
unmeasurable_count=$(grep -c '' <"$TMP/unmeasurable" || true)

if [ "$violation_count" -gt 0 ]; then
  printf '\ncheck-comment-density: %d file(s) above the committed comment density\n' \
    "$violation_count" >&2
  LC_ALL=C sort "$TMP/violations" >&2
  printf '\nA prose finding is fixed by delete, cite or move-to-test, never by adding\n' >&2
  printf '(docs/standards/prose.md rule 6). When the ratio fell and the baseline is\n' >&2
  printf 'merely stale, lower it with:\n\n' >&2
  printf '    bash .claude/scripts/check-comment-density.sh --ratchet\n\n' >&2
  printf 'which lowers rows and never raises one — this gate cannot be satisfied by\n' >&2
  printf 'editing %s upward by hand. A RENAMED file arrives as a\n' "$BASELINE_REL" >&2
  printf 'new one and is judged against the median: carry its row across to the new\n' >&2
  printf 'path by hand, which leaves the ratio alone and is therefore not that edit.\n' >&2
  exit 1
fi

# --- the ratchet --------------------------------------------------------------------------

lowered_count=$(grep -c '' <"$TMP/lowered" || true)
added_count=$(grep -c '' <"$TMP/added" || true)
dropped_count=$(grep -c '' <"$TMP/dropped" || true)
drift=$((lowered_count + added_count + dropped_count))

if [ "$ratchet" = "1" ]; then
  if [ "$drift" -eq 0 ]; then
    printf 'check-comment-density: baseline already matches — nothing to ratchet\n'
  else
    if ! LC_ALL=C sort -o "$TMP/newbase" "$TMP/newbase"; then
      printf 'check-comment-density: could not sort the rewritten baseline\n' >&2
      exit 2
    fi
    {
      printf '# Comment-density baseline — generated, never hand-edited (#553).\n'
      printf '# One row per non-test source file: path<TAB>comment lines as basis\n'
      printf '# points of non-blank lines (6022 = 60.22%%). A ratio may fall, never\n'
      printf '# rise. Regenerate with:\n'
      printf '#     bash .claude/scripts/check-comment-density.sh --ratchet\n'
      cat "$TMP/newbase"
    } >"$TMP/baseline.new"
    if ! mkdir -p "$(dirname "$BASELINE")" || ! mv "$TMP/baseline.new" "$BASELINE"; then
      printf 'check-comment-density: could not write %s\n' "$BASELINE_REL" >&2
      exit 2
    fi
    printf 'check-comment-density: %s rewritten — %d lowered, %d added, %d dropped\n' \
      "$BASELINE_REL" "$lowered_count" "$added_count" "$dropped_count"
    for section in lowered added dropped; do
      [ -s "$TMP/$section" ] || continue
      printf '  --- %s ---\n' "$section"
      LC_ALL=C sort "$TMP/$section"
    done
  fi
fi

printf 'check-comment-density: OK — %d file(s) at or below baseline; median %d bp, %d baseline row(s)' \
  "$measured" "$median" "$baseline_rows"
if [ "$ratchet" = "0" ] && [ "$drift" -gt 0 ]; then
  printf '; baseline is stale (%d lower, %d unpinned, %d gone) — --ratchet banks it' \
    "$lowered_count" "$added_count" "$dropped_count"
fi
if [ "$unmeasurable_count" -gt 0 ]; then
  printf '; %d file(s) have no non-blank line' "$unmeasurable_count"
fi
printf '\n'
