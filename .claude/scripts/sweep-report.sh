#!/usr/bin/env bash
#
# sweep-report.sh — the reporting prose of a trim/sweep PR, COMPUTED from the
# claim ledger instead of typed from memory.
#
# Why this exists (#522). A trim batch's diff is verified by commands; its
# report is not. Across #497's two batches every rendering of the same ledger
# was retyped, and the retyping is where the defects were: two of PR #512's four
# cycle-1 findings were claims that batch had minted itself, PR #520's cycle-2
# findings were five for five in the reporting prose with none in the diff, and
# #520's title said "3 trued, 3 raised" where its body said five and five. That
# title is what became history: `merge-pr.sh` runs `gh pr merge <n> --squash`
# with no `--subject`, and this repository's `squash_merge_commit_title` is
# `COMMIT_OR_PR_TITLE` — so a branch of more than one commit (#512's six, #520's
# four) squashes under its PR title, and `6943ee6` carries #520's.
# `docs/standards/prose.md` rule 2 already applies the cure to figures —
# generate them, never type them — and this script is that rule pointed at the
# report itself.
#
# So: one ledger in, and every rendering out of ONE computation — the PR title
# fragment, the totals table, the five pre-check blocks of `prose.md` rule 3
# with the exact command above each output, and a `docs/tech-debt.md` entry
# skeleton per out-of-scope row with its quotes already resolved. The exit code
# is the point as much as the text: a failing check or an unresolved quote
# exits non-zero, so a lane cannot paste a passing report over a failing tree.
#
# Usage:
#   bash .claude/scripts/sweep-report.sh <ledger.tsv> <base-sha>
#
#     ledger.tsv   the claim ledger, format below
#     base-sha     the commit the batch branched from; the diff and the
#                  inbound-reference controls are read against it
#
# Exit:  0 every check passed
#        1 a check FAILED — an unresolved quote, a sweep whose positive control
#          did not come back, a spelled-out figure, a reflow hit
#        2 no verdict reached — bad arguments, an unreadable or malformed
#          ledger, an unknown base, or one of this script's OWN positive
#          controls failing, which means the check is broken rather than the
#          tree (docs/standards/evidence.md sanctioned form 5)
#
# ## Ledger format, fixed
#
# A TSV the lane maintains as it works. The header is validated verbatim:
#
#     path<TAB>line<TAB>claim<TAB>check<TAB>disposition[<TAB>key=value]...
#
# `disposition` is one of verified-true | trued | deleted | out-of-scope |
# restored, and anything else is rejected by name and ledger line number.
# `line` may be empty (a claim pinned to a section rather than a line); every
# other required field must be non-empty.
#
# The optional trailing fields are the pre-checks' INPUTS, one `key=value` per
# tab-separated field. They are fields rather than markers inside the prose
# columns for one reason: a TSV field cannot contain a tab, so a PCRE holding
# `]`, `|` or a quote needs no escaping and cannot be mis-parsed.
#
#   subject=<identifier>   required on `trued` and `deleted` rows — the trimmed
#                          subject whose inbound references pre-check (a) greps
#   sweep=<pcre>           a restatement ledger's sweep, run with `git grep -P`
#   control=<path>         required with `sweep=`, and only with it: the carrier
#                          the sweep MUST return (prose.md rule 3(b))
#   quote=<string>         required, repeatable, on `out-of-scope` rows — the
#                          strings the emitted tech-debt skeleton will cite.
#                          Resolved tree-wide, and the hit's file is what the
#                          skeleton cites: `prose.md` rule 3(d) is "greps to the
#                          file it NAMES", and the file a tech-debt entry names
#                          is the code that is wrong, which is rarely the file
#                          the ledger row's prose sat in.
#
# ## What is NOT here
#
# This is a lane TOOL, not a gate: it is deliberately absent from `pnpm verify`,
# because a gate needs an input that exists on every branch and a ledger does
# not. Its harness, sweep-report.test.sh next door, is what `verify` runs — and
# that harness is discovered by run-script-tests.sh, never enumerated.
#
set -uo pipefail
# Homebrew's prefix is not on a non-interactive shell's default PATH on this
# machine (same reason lint-shell.sh and run-script-tests.sh do it). Harmless on
# Linux, where the directory does not exist.
export PATH="/opt/homebrew/bin:$PATH"

LEDGER_HEADER=$(printf 'path\tline\tclaim\tcheck\tdisposition')

# The spelled-number pattern is `docs/standards/prose.md` rule 3(c), verbatim.
# It lives in one variable so the run and its positive control cannot drift:
# an emptiness claim and a broken pattern print the same nothing.
SPELLED_RE='\b(one|two|three|four|five|six|seven|eight|nine|ten|twenty|thirty|forty|fifty|sixty|ninety|hundred)[- ](second|minute|px|pixel|ms|kW|sites?)'

# The seam the harness needs. Pre-checks (a), (b) and (d) can be made to fail
# with a real git — a bad pathspec in the ledger does it — but the two `git diff`
# calls below take no ledger input at all, so their failure paths are
# unreachable from a fixture and would ship unasserted. Same precedent and same
# narrow scope as `LINT_SHELL_GIT_CMD` in lint-shell.sh: it covers these diff
# calls ONLY, and the repo-identity `rev-parse` above stays plain git.
: "${SWEEP_REPORT_GIT_CMD:=git}"

# The width at which a comment line counts as a "full-width continuation" for
# pre-check (e). Prettier does not reflow comments, so a three-word line above a
# line this long is a comment that was edited and left ragged.
REFLOW_CONTINUATION_COLS=60

usage() {
  cat <<'EOF'
Usage: bash .claude/scripts/sweep-report.sh <ledger.tsv> <base-sha>

  ledger.tsv   claim ledger — path/line/claim/check/disposition TSV
  base-sha     the commit the batch branched from

Exit: 0 all checks passed, 1 a check failed, 2 no verdict reached.
EOF
}

fatal() { # fatal <headline> [detail...] — no verdict is reachable
  printf 'sweep-report: %s\n' "$1" >&2
  shift
  while [ $# -gt 0 ]; do
    printf '  %s\n' "$1" >&2
    shift
  done
  exit 2
}

case "${1:-}" in
  -h | --help)
    usage
    exit 0
    ;;
esac

if [ $# -ne 2 ]; then
  usage >&2
  exit 2
fi

ledger_arg="$1"
base_arg="$2"

# The ledger path is resolved against the CALLER's directory, before the cd to
# the repository root below moves the ground under a relative path.
case "$ledger_arg" in
  /*) ledger="$ledger_arg" ;;
  *) ledger="$PWD/$ledger_arg" ;;
esac
[ -f "$ledger" ] || fatal "ledger is not a readable file: $ledger_arg"

repo_root=$(git rev-parse --show-toplevel 2>/dev/null) || fatal "not inside a git repository"
cd "$repo_root" || fatal "cannot enter the repository root: $repo_root"

# Resolved to a full hex sha, and used in that form everywhere below: pre-check
# (c) embeds it in a command STRING, and a hex sha is the one spelling that
# cannot carry anything else into that string.
base_sha=$(git rev-parse --verify --quiet "$base_arg^{commit}")
rc=$?
if [ "$rc" -ne 0 ] || [ -z "$base_sha" ]; then
  fatal "base-sha does not resolve to a commit in this repository: $base_arg"
fi

work=$(mktemp -d "${TMPDIR:-/tmp}/sweep-report.XXXXXX") || fatal "cannot create a temp directory"
trap 'rm -rf "$work"' EXIT INT TERM

ROWS="$work/rows.tsv"
SUBJECTS="$work/subjects.tsv"
SWEEPS="$work/sweeps.tsv"
SCOPE="$work/scope.tsv"
QUOTES="$work/quotes.tsv"
RESOLVED="$work/resolved.tsv"
FAILURES="$work/failures"
PARSE_ERRORS="$work/parse-errors"
CMD_OUT="$work/cmd.out"
CMD_ERR="$work/cmd.err"
CMD_RC=0

: >"$ROWS"
: >"$SUBJECTS"
: >"$SWEEPS"
: >"$SCOPE"
: >"$QUOTES"
: >"$RESOLVED"
: >"$FAILURES"
: >"$PARSE_ERRORS"

# A literal tab, for the parameter expansions that split the records below.
# `IFS=$'\t' read` cannot do that job: tab is IFS whitespace, so bash collapses
# runs of it and strips it from both ends, and an empty `line` column would
# shift every field after it.
TAB=$(printf '\t')

# --- ledger parse and validation ------------------------------------------------------------
#
# One awk pass: it validates every row and emits the pre-checks' inputs into
# purpose-shaped files, so nothing downstream re-parses the ledger and nothing
# downstream can disagree with this pass about what the ledger said.
#
# Diagnostics go to a FILE the shell then prints to stderr, rather than to
# awk's "/dev/stderr": that name is a gawk/BSD-awk convenience, not POSIX, and
# this script has to say the same thing under whichever awk the box has.

awk -v HEADER="$LEDGER_HEADER" \
  -v ERRS="$PARSE_ERRORS" \
  -v ROWS="$ROWS" \
  -v SUBJECTS="$SUBJECTS" \
  -v SWEEPS="$SWEEPS" \
  -v SCOPE="$SCOPE" \
  -v QUOTES="$QUOTES" '
BEGIN {
  FS = "\t"; OFS = "\t"
  split("verified-true trued deleted out-of-scope restored", d, " ")
  for (i in d) OKD[d[i]] = 1
  split("subject sweep control quote", k, " ")
  for (i in k) OKK[k[i]] = 1
  errs = 0; rows = 0
}

function err(msg) { printf("  ledger line %d: %s\n", FNR, msg) > (ERRS); errs++ }

NR == 1 {
  if ($0 != HEADER) {
    printf("  the header is not the fixed format\n") > (ERRS)
    printf("    expected: %s\n", HEADER) > (ERRS)
    printf("    found:    %s\n", $0) > (ERRS)
    errs++
  }
  next
}

/^[ \t]*$/ { next }

{
  if (NF < 5) {
    err("has " NF " field(s); the fixed format is five tab-separated columns")
    next
  }
  path = $1; line = $2; claim = $3; check = $4; disp = $5
  if (path == "") err("column 1 (path) is empty")
  if (claim == "") err("column 3 (claim) is empty")
  if (check == "") err("column 4 (check) is empty")
  if (!(disp in OKD)) {
    err("unknown disposition \"" disp "\" — allowed: verified-true, trued, deleted, out-of-scope, restored")
    next
  }

  nsubject = 0; nsweep = 0; ncontrol = 0; nquote = 0; sweep = ""; control = ""
  for (i = 6; i <= NF; i++) {
    f = $i
    if (f == "") { err("trailing field " i " is empty — a directive field is key=value"); continue }
    p = index(f, "=")
    if (p < 2) { err("trailing field " i " is not key=value: \"" f "\""); continue }
    key = substr(f, 1, p - 1); val = substr(f, p + 1)
    if (!(key in OKK)) { err("unknown directive key \"" key "\" — allowed: subject, sweep, control, quote"); continue }
    if (val == "") { err("directive \"" key "\" has an empty value"); continue }
    if (key == "subject") { nsubject++; print path, val > (SUBJECTS) }
    else if (key == "sweep") { nsweep++; sweep = val }
    else if (key == "control") { ncontrol++; control = val }
    else if (key == "quote") { nquote++; print FNR, val > (QUOTES) }
  }

  if ((disp == "trued" || disp == "deleted") && nsubject == 0)
    err("a " disp " row must name the trimmed subject — add subject=<identifier>")
  if (disp == "out-of-scope" && nquote == 0)
    err("an out-of-scope row must name at least one quote= for its tech-debt entry")
  if (nsweep > 1) err("more than one sweep= on one row — give a sweep its own row")
  if (ncontrol > 1) err("more than one control= on one row")
  if (nsweep == 1 && ncontrol != 1)
    err("sweep= without control= — a sweep ships with a named carrier it must return (prose.md rule 3(b))")
  if (ncontrol == 1 && nsweep != 1)
    err("control= without sweep=")
  if (nsweep == 1 && ncontrol == 1) print control, sweep > (SWEEPS)
  if (disp == "out-of-scope") print FNR, path, line, claim > (SCOPE)

  print path, disp > (ROWS)
  rows++
}

END {
  if (rows == 0) {
    printf("  the ledger holds no data rows — a report over nothing is not a report\n") > (ERRS)
    errs++
  }
  if (errs > 0) exit 2
}
' "$ledger"
parse_rc=$?

if [ "$parse_rc" -ne 0 ]; then
  printf 'sweep-report: the ledger is not valid — no report is produced.\n' >&2
  cat "$PARSE_ERRORS" >&2
  exit 2
fi

# --- report plumbing ------------------------------------------------------------------------

checks_run=0
checks_failed=0

check_fail() { # check_fail <one-line reason>
  printf 'FAIL — %s\n\n' "$1"
  printf '%s\n' "$1" >>"$FAILURES"
  checks_failed=$((checks_failed + 1))
}

check_pass() { # check_pass <one-line reason>
  printf 'ok — %s\n\n' "$1"
}

# render_cmd — the displayed form of an argv, quoted so that what the report
# shows is what a reader can paste back. It is built FROM the argv the next line
# runs, never typed beside it: a displayed command that drifts from the executed
# one is this script's own version of the defect it exists to stop.
render_cmd() {
  local rendered="" arg
  for arg in "$@"; do
    case "$arg" in
      '') rendered="$rendered ''" ;;
      *[!A-Za-z0-9_./=:-]*) rendered="$rendered '${arg//\'/\'\\\'\'}'" ;;
      *) rendered="$rendered $arg" ;;
    esac
  done
  printf '$%s\n' "$rendered"
}

# emit_streams — render the last run's two streams into the report, stderr under
# a label of its own so a reader can see it was not counted.
emit_streams() {
  if [ -s "$CMD_OUT" ]; then
    cat "$CMD_OUT"
  else
    printf '(no output)\n'
  fi
  if [ -s "$CMD_ERR" ]; then
    printf '# stderr (exit %d):\n' "$CMD_RC"
    cat "$CMD_ERR"
  fi
}

# run_shown — print the command, run that exact argv, print its output.
#
# stdout and stderr go to SEPARATE files, and `$?` is captured on the line
# immediately after the run (docs/standards/evidence.md sanctioned form 1). The
# two streams are not merged for a reason this script learned the hard way: a
# `fatal: Invalid pathspec magic` on stderr, folded into the output file, is one
# LINE — and a line count over that file then reports a git failure as a hit,
# which is a broken check reported as a clean one. The count the report reads is
# produced by the check, or the check is refused — which is what every caller's
# `cmd_errored` test below is for.
run_shown() {
  render_cmd "$@"
  "$@" >"$CMD_OUT" 2>"$CMD_ERR"
  CMD_RC=$?
  emit_streams
}

# run_shown_pipeline — the same contract for the pre-check `prose.md` states AS
# a pipeline. The string is displayed and executed, so they cannot diverge; it
# is composed only from this script's own constants and the resolved hex base
# sha, never from ledger text, which is why an eval-shaped form is safe here and
# argv is used for everything the ledger parameterises.
run_shown_pipeline() {
  printf '$ %s\n' "$1"
  bash -c "$1" >"$CMD_OUT" 2>"$CMD_ERR"
  CMD_RC=$?
  emit_streams
}

# cmd_errored — true when the last run_shown could not answer its question.
# Exit 1 is NOT an error for any subject this script runs: `grep` and `git grep`
# spell "no match" that way, and pre-check (e)'s awk spells "found something"
# that way. Anything above that, or any word on stderr, is a tool that failed
# rather than a tree that is clean.
cmd_errored() {
  [ "$CMD_RC" -gt 1 ] || [ -s "$CMD_ERR" ]
}

cmd_error_detail() { # cmd_error_detail -> the first stderr line, for the failure reason
  if [ -s "$CMD_ERR" ]; then
    command head -n 1 "$CMD_ERR"
  else
    printf 'exit %s with nothing on stderr' "$CMD_RC"
  fi
}

line_count() { # line_count <file> -> the number of lines it holds, as a number
  local n
  n=$(command wc -l <"$1")
  printf '%s' "${n// /}"
}

# --- the report ------------------------------------------------------------------------------

# Static prose is emitted through QUOTED heredocs, never through printf format
# strings: markdown backticks inside a format string read as command
# substitution to shellcheck (SC2016), and a suppression comment is itself a
# lint error (CLAUDE.md). Where a line needs a substitution AND a backtick, the
# whole line is built as one double-quoted argument to `printf '%s\n'`.
cat <<'EOF'
## Sweep report

Every figure and every pasted output below is this script's, not a lane's recollection — a
reviewer re-runs it and diffs the result against the PR body (`docs/standards/prose.md`
§ Trim batches rule 4).

EOF
# The command is printed with the ledger path made repo-relative wherever it is
# inside the repository. `$ledger_arg` as typed is reproducible only from the
# directory the lane happened to stand in, and rule 4 asks a reviewer to re-run
# this from the root — a printed command that resolves from neither directory is
# a command nobody can re-run.
case "$ledger" in
  "$repo_root"/*) ledger_shown=${ledger#"$repo_root"/} ;;
  *) ledger_shown="$ledger" ;;
esac
printf '%s\n' "Command: \`bash .claude/scripts/sweep-report.sh $ledger_shown $base_sha\`"
printf '%s\n\n' "Ledger: \`$ledger_shown\` · base: \`$base_sha\`"

# The diff's scale, from --numstat, which counts lines structurally
# (docs/standards/evidence.md sanctioned form 3). It is in the header because
# pre-checks (c) and (e) are emptiness claims over this diff: without the scale
# beside them, a report generated against the wrong base reads exactly like a
# report over a clean batch. An empty diff fails the run outright, below.
DIFF_FILE="$work/diff.txt"
"$SWEEP_REPORT_GIT_CMD" diff "$base_sha" >"$DIFF_FILE" 2>"$CMD_ERR"
diff_rc=$?
if [ "$diff_rc" -ne 0 ]; then
  fatal "git diff $base_sha failed (exit $diff_rc)" "$(command head -n 1 "$CMD_ERR")"
fi
NUMSTAT_FILE="$work/numstat.txt"
"$SWEEP_REPORT_GIT_CMD" diff --numstat "$base_sha" >"$NUMSTAT_FILE" 2>"$CMD_ERR"
numstat_rc=$?
if [ "$numstat_rc" -ne 0 ]; then
  fatal "git diff --numstat $base_sha failed (exit $numstat_rc)" "$(command head -n 1 "$CMD_ERR")"
fi
diff_scale=$(awk '
  { files++; added += ($1 == "-") ? 0 : $1; removed += ($2 == "-") ? 0 : $2 }
  END { printf("%d file(s), +%d / -%d line(s)", files + 0, added + 0, removed + 0) }' "$NUMSTAT_FILE")
diff_files=${diff_scale%% *}
# Named as "working tree vs base", not "the branch": `git diff <sha>` reads the
# WORKING TREE, so a report run with uncommitted edits describes a state no
# reviewer re-running on a clean checkout will see. Saying which state was read
# is the honest half; making the two agree is `docs/tech-debt.md`'s.
printf '%s\n\n' "Diff at this base (working tree vs \`$base_sha\`): $diff_scale"

# Title fragment and totals table come out of ONE awk END block over ONE row
# file. That is the whole answer to #520: the title line and the table's total
# row are printfs over the same variables, so they cannot disagree.
awk -F'\t' '
function cell(p, d) { return ((p SUBSEP d) in c) ? c[p SUBSEP d] : 0 }
{
  path = $1; disp = $2
  if (!(path in seen)) { seen[path] = 1; order[++n] = path }
  total[path]++
  c[path SUBSEP disp]++
  g[disp]++
  grand++
}
END {
  printf("### PR title fragment\n\n")
  printf("    %d checked — %d trued, %d deleted, %d raised\n\n", grand, g["trued"] + 0, g["deleted"] + 0, g["out-of-scope"] + 0)
  printf("### Claim ledger totals\n\n")
  printf("| file | claims | verified-true | trued | deleted | out-of-scope | restored |\n")
  printf("| --- | ---: | ---: | ---: | ---: | ---: | ---: |\n")
  for (i = 1; i <= n; i++) {
    p = order[i]
    printf("| `%s` | %d | %d | %d | %d | %d | %d |\n", p, total[p], cell(p, "verified-true"), cell(p, "trued"), cell(p, "deleted"), cell(p, "out-of-scope"), cell(p, "restored"))
  }
  printf("| **total** | **%d** | **%d** | **%d** | **%d** | **%d** | **%d** |\n\n", grand, g["verified-true"] + 0, g["trued"] + 0, g["deleted"] + 0, g["out-of-scope"] + 0, g["restored"] + 0)
}
' "$ROWS"

# --- pre-check (a): inbound references --------------------------------------------------------

cat <<'EOF'
### Pre-check (a) — inbound references (`prose.md` rule 3(a))

For every subject the ledger names as trimmed: first the positive control — the subject must
resolve at the base in the file the row names, which is what catches a mistyped subject — then
the inbound sweep with that file excluded. **Every hit below is to be read.**

EOF

if [ ! -s "$SUBJECTS" ]; then
  cat <<'EOF'
(the ledger names no trimmed subject — no `trued` or `deleted` row)

EOF
else
  while IFS= read -r rec; do
    [ -n "$rec" ] || continue
    subj_path=${rec%%"$TAB"*}
    subject=${rec#*"$TAB"}
    checks_run=$((checks_run + 1))
    printf '```\n'
    run_shown git grep -n -F -e "$subject" "$base_sha" -- "$subj_path"
    control_hits=$(line_count "$CMD_OUT")
    control_broke=0
    if cmd_errored; then
      control_broke=1
      control_detail=$(cmd_error_detail)
    fi
    printf '\n'
    run_shown git grep -n -F -e "$subject" -- ":!$subj_path"
    inbound_hits=$(line_count "$CMD_OUT")
    if cmd_errored; then
      control_broke=1
      control_detail=$(cmd_error_detail)
    fi
    printf '```\n\n'
    if [ "$control_broke" -eq 1 ]; then
      check_fail "pre-check (a) could not run for \`$subject\` — git said: $control_detail"
    elif [ "$control_hits" -eq 0 ]; then
      check_fail "positive control: \`$subject\` is not in \`$subj_path\` at $base_sha — the ledger names a subject the base does not carry"
    else
      check_pass "\`$subject\`: control $control_hits hit(s) at base, $inbound_hits inbound reference(s) to read"
    fi
  done <"$SUBJECTS"
fi

# --- pre-check (b): ledger sweeps -------------------------------------------------------------

cat <<'EOF'
### Pre-check (b) — ledger sweeps, each with its positive control (`prose.md` rule 3(b))

EOF

if [ ! -s "$SWEEPS" ]; then
  printf '(the ledger declares no sweep)\n\n'
else
  while IFS= read -r rec; do
    [ -n "$rec" ] || continue
    control=${rec%%"$TAB"*}
    pattern=${rec#*"$TAB"}
    checks_run=$((checks_run + 1))
    printf '```\n'
    run_shown git grep -n -P -e "$pattern"
    sweep_hits=$(line_count "$CMD_OUT")
    sweep_broke=0
    if cmd_errored; then
      sweep_broke=1
      sweep_detail=$(cmd_error_detail)
    fi
    printf '```\n\n'
    # The control is matched against the PATH FIELD of `git grep -n`'s
    # `path:line:content`, never against the whole line. A sweep over a
    # restatement ledger routinely returns lines whose CONTENT names other
    # paths, so a substring test passes whenever the sweep happens to return a
    # line that merely mentions the carrier — the control then certifies text it
    # did not return, which is evidence.md member 7 inside the tool built to
    # enforce it.
    control_seen=$(awk -F: -v carrier="$control" '$1 == carrier { n++ } END { print n + 0 }' "$CMD_OUT")
    if [ "$sweep_broke" -eq 1 ]; then
      check_fail "pre-check (b) could not run the sweep \`$pattern\` — git said: $sweep_detail"
    elif [ "$control_seen" -eq 0 ]; then
      check_fail "sweep \`$pattern\` returned $sweep_hits line(s) and NONE of them is its declared carrier \`$control\` — the pattern is wrong, or the carrier is gone"
    else
      check_pass "sweep \`$pattern\`: $sweep_hits hit(s), carrier \`$control\` among them"
    fi
  done <"$SWEEPS"
fi

# --- pre-check (c): spelled-out figures --------------------------------------------------------

cat <<'EOF'
### Pre-check (c) — no spelled-out figure enters a comment (`prose.md` rule 3(c))

EOF

checks_run=$((checks_run + 1))
printf '```\n'
run_shown_pipeline "$SWEEP_REPORT_GIT_CMD diff $base_sha | command grep -E '^\\+' | command grep -iE '$SPELLED_RE'"
spelled_hits=$(line_count "$CMD_OUT")
spelled_broke=0
if cmd_errored; then
  spelled_broke=1
  spelled_detail=$(cmd_error_detail)
fi
printf '\n'
printf '# positive control — the same pattern against a line known to match\n'
run_shown_pipeline "printf '%s\\n' '+ // a three-second debounce' | command grep -iE '$SPELLED_RE'"
spelled_control=$(line_count "$CMD_OUT")
printf '```\n\n'

if [ "$spelled_control" -eq 0 ]; then
  fatal "pre-check (c)'s own positive control returned nothing" \
    "The pattern matches nothing, so its empty result over the diff proves nothing." \
    "This is a broken check, not a clean tree — no verdict (evidence.md form 5)."
fi
# The control proves the PATTERN works; it cannot prove there was a diff for the
# pattern to work over. Those are two different emptiness claims, and only the
# scale in the header settles the second one.
if [ "$spelled_broke" -eq 1 ]; then
  check_fail "pre-check (c) could not run — the pipeline said: $spelled_detail"
elif [ "$diff_files" -eq 0 ]; then
  check_fail "pre-check (c) had nothing to run over — the diff at $base_sha is empty, so its silence is about the base, not about the batch"
elif [ "$spelled_hits" -gt 0 ]; then
  check_fail "$spelled_hits added line(s) spell a figure out in words — prose.md rule 3(c)"
else
  check_pass "no spelled-out figure across $diff_scale; the control returned $spelled_control line(s)"
fi

# --- pre-check (d): tech-debt quote resolution --------------------------------------------------

cat <<'EOF'
### Pre-check (d) — every quoted string resolves (`prose.md` rule 3(d))

One `git grep -nF` per `quote=` on an `out-of-scope` row. A miss fails loudly and the run exits
non-zero, so the skeletons below can only cite what the tree actually holds.

EOF

if [ ! -s "$QUOTES" ]; then
  cat <<'EOF'
(the ledger has no `out-of-scope` row, so no quote to resolve)

EOF
else
  while IFS= read -r rec; do
    [ -n "$rec" ] || continue
    rowid=${rec%%"$TAB"*}
    quote=${rec#*"$TAB"}
    checks_run=$((checks_run + 1))
    printf '```\n'
    run_shown git grep -n -F -e "$quote"
    quote_hits=$(line_count "$CMD_OUT")
    quote_broke=0
    if cmd_errored; then
      quote_broke=1
      quote_detail=$(cmd_error_detail)
    fi
    printf '```\n\n'
    if [ "$quote_broke" -eq 1 ]; then
      check_fail "pre-check (d) could not resolve \`$quote\` — git said: $quote_detail"
    elif [ "$quote_hits" -eq 0 ]; then
      check_fail "unresolved quote (ledger line $rowid): \`$quote\` is in no file in this tree"
    else
      # The first hit's FILE is what the skeleton cites. tech-debt.md's own
      # format rule forbids bare line numbers in an entry, so the line number
      # stays here — as the evidence that the quote resolved — while the
      # skeleton carries the file and the quoted string, the two pointers that
      # survive an unrelated edit.
      first_hit=$(command head -n 1 "$CMD_OUT")
      hit_file=${first_hit%%:*}
      printf '%s\t%s\t%s\n' "$rowid" "$hit_file" "$quote" >>"$RESOLVED"
      check_pass "\`$quote\` resolves — $quote_hits hit(s), first in \`$hit_file\`"
    fi
  done <"$QUOTES"
fi

# --- pre-check (e): comment reflow --------------------------------------------------------------
#
# The detector is written out here and run twice — once over the diff, once over
# a fixture known to contain exactly one offender. Same program, both times:
# that is the only way "nothing remains" can be told apart from "my detector
# never matched anything".
#
# The rule, stated once: an ADDED comment line of three words or fewer that ends
# without punctuation, immediately above a comment line at least
# REFLOW_CONTINUATION_COLS wide. The short line must be added — it is the line
# the trim shortened — but the CONTINUATION may be a context line, and usually
# is: a trim edits one line and leaves the rest of the paragraph alone, so the
# ragged pair arrives as one `+` above one ` ` line. Requiring both to be added
# would miss the canonical case the rule exists for.
#
# Markdown files are skipped outright: `#` is a heading there and `*` a bullet,
# and prettier reflows markdown prose but not comments, which is the whole
# reason this check exists. Two comment-lookalikes are excluded for the same
# reason — a shebang (`#!…`, one word, no punctuation) above a long `#` comment,
# and a JSDoc tag (`* @param x`) above its long description, are both ordinary
# shapes rather than ragged edits.

REFLOW_AWK="$work/reflow.awk"
cat >"$REFLOW_AWK" <<'AWK'
function is_comment(s,   t) {
  t = s
  sub(/^[ \t]+/, "", t)
  return (t ~ /^\/\//) || (t ~ /^#/) || (t ~ /^\*/) || (t ~ /^--/)
}
function body_of(s,   t) {
  t = s
  sub(/^[ \t]+/, "", t)
  sub(/^(\/\/+|#+|\*+|--+)[ \t]*/, "", t)
  sub(/[ \t]+$/, "", t)
  return t
}
BEGIN { skip = 0; short = 0; hits = 0; in_hunk = 0; file = "(unknown)" }
# A `+++ ` line is a file header only BEFORE the first hunk of that file; inside
# a hunk it is content (a diff quoted in a doc), and treating it as a header
# would silently repoint `file` and `skip` at whatever it names.
/^diff / { in_hunk = 0; short = 0; next }
/^\+\+\+ / && !in_hunk {
  file = substr($0, 7)
  skip = (file ~ /\.md$/)
  short = 0
  next
}
/^@@/ { in_hunk = 1; short = 0; next }
/^(--- |index |old mode|new mode|new file|deleted file|similarity|rename|Binary)/ { short = 0; next }
/^[+ ]/ {
  if (skip) { short = 0; next }
  added = (substr($0, 1, 1) == "+")
  text = substr($0, 2)
  if (!is_comment(text)) { short = 0; next }
  body = body_of(text)
  if (short && length(body) >= COLS) {
    hits++
    printf("%s: \"%s\" then a %d-column continuation: \"%s\"\n", file, prev, length(body), body)
  }
  nwords = (body == "") ? 0 : split(body, w, /[ \t]+/)
  ordinary = (body ~ /^!/) || (body ~ /^@/)
  short = (added && !ordinary && nwords > 0 && nwords <= 3 && body !~ /[.,:;!?)]$/)
  prev = body
  next
}
{ short = 0 }
END { exit (hits > 0) ? 1 : 0 }
AWK

# The control fixture is the canonical shape: one ADDED short line above an
# UNCHANGED (context) continuation. It therefore also proves the arm the
# detector was missing, not merely that the detector runs.
REFLOW_FIXTURE="$work/reflow-control.diff"
cat >"$REFLOW_FIXTURE" <<'FIXTURE'
diff --git a/reflow-control.ts b/reflow-control.ts
+++ b/reflow-control.ts
@@ -1,3 +1,3 @@
+// a short note
 // this continuation line is deliberately wide enough to count as a full-width continuation
FIXTURE

cat <<'EOF'
### Pre-check (e) — comment reflow (`prose.md` rule 3(e))

EOF
printf '%s\n' "Prettier does not reflow comments, so a 3-word-or-shorter unpunctuated comment line above"
printf '%s\n' "a comment line of $REFLOW_CONTINUATION_COLS columns or more is an edit left ragged. The detector runs over the"
cat <<'EOF'
diff and then, immediately, over a fixture holding exactly one offender — the same program both
times; it is written out by this script, so re-running the script is how a reviewer reproduces
it. Markdown is out of scope: `#` is a heading there, not a comment.

EOF

checks_run=$((checks_run + 1))
printf '```\n'
run_shown awk -v COLS="$REFLOW_CONTINUATION_COLS" -f "$REFLOW_AWK" "$DIFF_FILE"
reflow_hits=$(line_count "$CMD_OUT")
reflow_broke=0
if cmd_errored; then
  reflow_broke=1
  reflow_detail=$(cmd_error_detail)
fi
printf '\n'
printf '# positive control — the same detector over a fixture with one known offender\n'
run_shown awk -v COLS="$REFLOW_CONTINUATION_COLS" -f "$REFLOW_AWK" "$REFLOW_FIXTURE"
reflow_control=$(line_count "$CMD_OUT")
printf '```\n\n'

if [ "$reflow_control" -eq 0 ]; then
  fatal "pre-check (e)'s own positive control returned nothing" \
    "The detector matches nothing, so its silence over the diff proves nothing." \
    "This is a broken check, not a clean diff — no verdict (evidence.md form 5)."
fi
if [ "$reflow_broke" -eq 1 ]; then
  check_fail "pre-check (e) could not run — awk said: $reflow_detail"
elif [ "$diff_files" -eq 0 ]; then
  check_fail "pre-check (e) had nothing to run over — the diff at $base_sha is empty, so its silence is about the base, not about the batch"
elif [ "$reflow_hits" -gt 0 ]; then
  check_fail "the diff adds $reflow_hits ragged comment continuation(s) — prose.md rule 3(e)"
else
  check_pass "no ragged comment continuation across $diff_scale; the control found its offender"
fi

# --- tech-debt entry skeletons --------------------------------------------------------------

cat <<'EOF'
### `docs/tech-debt.md` entry skeletons — one per `out-of-scope` row

EOF

if [ ! -s "$SCOPE" ]; then
  cat <<'EOF'
(no `out-of-scope` row, so no entry is owed)

EOF
else
  # The heading's date is a PLACEHOLDER, not today's date. rule 4 has a reviewer
  # re-run this script and diff its output against the PR body, and `date` makes
  # that diff non-empty the moment the review happens on a later day than the
  # run — a reproducible report cannot carry a clock.
  while IFS= read -r rec; do
    [ -n "$rec" ] || continue
    rowid=${rec%%"$TAB"*}
    rest=${rec#*"$TAB"}
    scope_path=${rest%%"$TAB"*}
    rest=${rest#*"$TAB"}
    scope_line=${rest%%"$TAB"*}
    scope_claim=${rest#*"$TAB"}
    printf '```markdown\n'
    printf '## <YYYY-MM-DD> — %s\n' "$scope_claim"
    printf '%s' "- Where: \`$scope_path\`"
    while IFS= read -r res; do
      res_row=${res%%"$TAB"*}
      [ "$res_row" = "$rowid" ] || continue
      res_rest=${res#*"$TAB"}
      res_file=${res_rest%%"$TAB"*}
      res_quote=${res_rest#*"$TAB"}
      printf '%s' " · \`$res_file\` carries \"$res_quote\""
    done <"$RESOLVED"
    printf '\n'
    printf -- '- What: %s\n' "$scope_claim"
    printf -- '- Source: PR #<this PR>, ledger row %s (%s)\n' "$rowid" "${scope_line:-no line pinned}"
    printf '```\n\n'
  done <"$SCOPE"
  cat <<'EOF'
Every pointer above resolved in pre-check (d). `docs/tech-debt.md`'s own format rule forbids
bare line numbers, so an entry cites the file and the quoted string.

EOF
fi

# --- verdict ----------------------------------------------------------------------------------

printf '### Verdict\n\n'
if [ "$checks_failed" -eq 0 ]; then
  printf 'sweep-report: OK — %d check(s) run, 0 failed.\n' "$checks_run"
  exit 0
fi

printf 'sweep-report: %d of %d check(s) FAILED.\n\n' "$checks_failed" "$checks_run"
while IFS= read -r reason; do
  printf -- '- %s\n' "$reason"
done <"$FAILURES"
printf '\n'
printf 'sweep-report: %d of %d check(s) failed — see the report above.\n' "$checks_failed" "$checks_run" >&2
exit 1
