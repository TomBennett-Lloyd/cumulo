#!/usr/bin/env bash
# An on-demand tidy of docs/tech-debt.md (#634): run it in a worktree right before acting on the
# file, and commit what it changed. It is not part of `pnpm verify` because it mutates the file.
#
# An entry retires only when its Source line cites nothing still open AND a closed issue quotes
# its heading. A Source line names the review that FOUND a finding, so "Source closed" alone
# would move live, uncaptured debt out of the buffer /triage reads (the divergence is recorded on
# #634's plan comment).
#
# Usage: bash .claude/scripts/tidy-tech-debt.sh [REPO_ROOT]
#        (or `pnpm tidy:tech-debt`)
# Exit:  0 nothing needs a human, 1 something does (changes may still have been written),
#        2 a blocker: `gh` unavailable or failing, or a ledger blocker. A blocker writes nothing.
#
# Runs under bash 3.2, which macOS ships as /bin/bash.
set -euo pipefail

usage() {
  printf 'Usage: bash .claude/scripts/tidy-tech-debt.sh [REPO_ROOT]\n'
  printf 'Re-runs the ledgers, retires closed rows and entries in docs/tech-debt.md, checks entry shape.\n'
  printf 'Exit: 0 nothing needs a human, 1 something does, 2 blocker.\n'
}

case "${1:-}" in
  -h | --help)
    usage
    exit 0
    ;;
esac

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ROOT=${1:-$(git rev-parse --show-toplevel)}
FILE="$ROOT/docs/tech-debt.md"

if [ ! -f "$FILE" ]; then
  printf 'tidy-tech-debt: no docs/tech-debt.md under %s\n' "$ROOT" >&2
  exit 2
fi
if ! command -v gh >/dev/null 2>&1; then
  printf 'tidy-tech-debt: gh is not on PATH\n' >&2
  exit 2
fi

SCRATCH=$(mktemp -d)
trap 'rm -rf "$SCRATCH"' EXIT INT TERM

human=()

# --- rule 1: ledgers -------------------------------------------------------------------------

printf '== Rule 1: ledgers ==\n'
ledger_rc=0
bash "$SCRIPT_DIR/check-ledgers.sh" "$ROOT" || ledger_rc=$?
if [ "$ledger_rc" -eq 2 ]; then
  printf 'tidy-tech-debt: ledger blocker, nothing was changed\n' >&2
  exit 2
fi
if [ "$ledger_rc" -ne 0 ]; then
  human+=("rule 1: ledger drift (see the report above)")
fi

# --- issue states ----------------------------------------------------------------------------

# is_closed <n> — 0 when issue-or-PR <n> is CLOSED or MERGED. One gh call per number per run.
is_closed() {
  local n="$1" cache="$SCRATCH/state.$1" state
  if [ ! -f "$cache" ]; then
    if ! state=$(cd "$ROOT" && gh issue view "$n" --json state --jq .state 2>"$SCRATCH/gh.err"); then
      printf 'tidy-tech-debt: gh could not read #%s: %s\n' "$n" "$(head -n1 "$SCRATCH/gh.err")" >&2
      exit 2
    fi
    printf '%s\n' "$state" >"$cache"
  fi
  case "$(cat "$cache")" in
    CLOSED | MERGED) return 0 ;;
    *) return 1 ;;
  esac
}

# all_closed <n>... — 0 when at least one number is given and every one is closed.
all_closed() {
  [ "$#" -gt 0 ] || return 1
  local n
  for n in "$@"; do
    is_closed "$n" || return 1
  done
}

# issue_text <state> — every title and body in that state, one stream, fetched at most once.
issue_text() {
  local state="$1" out="$SCRATCH/text.$1"
  if [ ! -f "$out" ]; then
    if ! (cd "$ROOT" && gh issue list --state "$state" --limit 1000 --json title,body \
      --jq '.[] | .title, .body') >"$out" 2>"$SCRATCH/gh.err"; then
      printf 'tidy-tech-debt: gh issue list --state %s failed: %s\n' "$state" "$(head -n1 "$SCRATCH/gh.err")" >&2
      exit 2
    fi
  fi
  printf '%s' "$out"
}

# --- parse the file --------------------------------------------------------------------------

FS=$'\037'

# rows.tsv:    line, issue numbers of one redirect-table row
# entries.tsv: first line, last line, heading, Source line, missing keys ("-" when none)
awk -v rows="$SCRATCH/rows.tsv" -v entries="$SCRATCH/entries.tsv" -v fs="$FS" '
  function nums_of(text, re,  out, m) {
    out = ""
    while (match(text, re)) {
      m = substr(text, RSTART, RLENGTH); gsub(/[^0-9]/, "", m)
      out = out (out == "" ? "" : " ") m
      text = substr(text, RSTART + RLENGTH)
    }
    return out
  }
  function flush(last,  missing) {
    if (!start) return
    missing = (has_where ? "" : "Where ") (has_what ? "" : "What ") (has_source ? "" : "Source ")
    printf "%d%s%d%s%s%s%s%s%s\n", start, fs, last, fs, heading, fs, source, fs, (missing == "" ? "-" : missing) >> entries
    start = 0
  }
  /^## / {
    flush(NR - 1)
    in_redirects = ($0 == "## Captured-entry redirects")
    if ($0 ~ /^## [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9] — /) {
      start = NR; heading = $0; source = ""; has_where = has_what = has_source = 0
    }
    next
  }
  in_redirects && /^\|/ && /issues\/[0-9]+\)/ {
    printf "%d%s%s\n", NR, fs, nums_of($0, "issues/[0-9]+\\)") >> rows
    next
  }
  start && /^- Where:/ { has_where = 1 }
  start && /^- What:/ { has_what = 1 }
  start && /^- Source:/ { has_source = 1; source = $0 }
  END { flush(NR) }
' "$FILE"
: >>"$SCRATCH/rows.tsv"
: >>"$SCRATCH/entries.tsv"

# --- rule 2: retire closed rows and entries --------------------------------------------------

printf '== Rule 2: retire what is closed ==\n'
: >"$SCRATCH/delete.txt"
: >"$SCRATCH/retired.txt"
deleted_rows=0
retired_entries=0
today=$(date +%F)

while IFS="$FS" read -r line nums; do
  # shellcheck disable=SC2086
  if all_closed $nums; then
    printf '%s %s\n' "$line" "$line" >>"$SCRATCH/delete.txt"
    deleted_rows=$((deleted_rows + 1))
    printf '  deleted redirect row (line %s): #%s closed\n' "$line" "${nums// /, #}"
  fi
done <"$SCRATCH/rows.tsv"

malformed=()
while IFS="$FS" read -r first last heading source missing; do
  title=${heading#*— }
  entry_date=${heading:3:10}
  if [ "$missing" != "-" ]; then
    malformed+=("line $first: \"$title\" lacks: ${missing% }")
    continue
  fi
  nums=$(printf '%s' "$source" | grep -oE '#[0-9]+' | tr -d '#' || true)
  # shellcheck disable=SC2086
  all_closed $nums || continue
  closed_text=$(issue_text closed)
  grep -qF -e "$title" "$closed_text" || continue
  open_text=$(issue_text open)
  if grep -qF -e "$title" "$open_text"; then
    continue
  fi
  printf '%s %s\n' "$first" "$last" >>"$SCRATCH/delete.txt"
  printf -- '- %s · %s — %s · #%s\n' "$today" "$entry_date" "$title" "${nums%%$'\n'*}" >>"$SCRATCH/retired.txt"
  retired_entries=$((retired_entries + 1))
  printf '  retired entry (line %s): "%s"\n' "$first" "$title"
done <"$SCRATCH/entries.tsv"

if [ "$deleted_rows" -eq 0 ] && [ "$retired_entries" -eq 0 ]; then
  printf '  nothing to retire\n'
fi

# --- rule 3: entry shape ---------------------------------------------------------------------

printf '== Rule 3: entry shape ==\n'
if [ "${#malformed[@]}" -eq 0 ]; then
  printf '  every entry carries Where, What and Source\n'
else
  for item in "${malformed[@]}"; do
    printf '  MALFORMED %s\n' "$item"
    human+=("rule 3: $item")
  done
fi

# --- write -----------------------------------------------------------------------------------

if [ "$deleted_rows" -gt 0 ] || [ "$retired_entries" -gt 0 ]; then
  awk -v del="$SCRATCH/delete.txt" '
    BEGIN { while ((getline l < del) > 0) { split(l, r, " "); for (i = r[1]; i <= r[2]; i++) gone[i] = 1 } }
    !(NR in gone) { print }
  ' "$FILE" >"$SCRATCH/out.md"
  if [ "$retired_entries" -gt 0 ]; then
    while [ -s "$SCRATCH/out.md" ] && [ -z "$(tail -n1 "$SCRATCH/out.md")" ]; do
      sed '$d' "$SCRATCH/out.md" >"$SCRATCH/trim.md"
      mv "$SCRATCH/trim.md" "$SCRATCH/out.md"
    done
    if ! grep -qx '## Retired' "$SCRATCH/out.md"; then
      printf '\n## Retired\n\n' >>"$SCRATCH/out.md"
    fi
    cat "$SCRATCH/retired.txt" >>"$SCRATCH/out.md"
  fi
  cat "$SCRATCH/out.md" >"$FILE"
fi

# --- rule 4: report --------------------------------------------------------------------------

printf '== Summary ==\n'
printf '  rule 2: %d redirect row(s) deleted, %d entry(ies) retired\n' "$deleted_rows" "$retired_entries"
if [ "${#human[@]}" -eq 0 ]; then
  printf '  nothing needs a human\n'
  exit 0
fi
printf '  needs a human:\n'
for item in "${human[@]}"; do
  printf '    %s\n' "$item"
done
exit 1
