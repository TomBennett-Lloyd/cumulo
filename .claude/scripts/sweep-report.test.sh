#!/usr/bin/env bash
# Test harness for sweep-report.sh, its neighbour in this directory.
#
# The assertion vocabulary is harness-lib.sh next door; the fixtures are real
# git repositories, built the way verify-tier.test.sh builds its own, because
# the subject's whole input is a ledger plus what git says about a tree, and a
# stub for git is a stub for the thing under test.
#
# What this harness has to be able to fail on, stated up front, because the
# subject exists to stop a class of defect rather than to compute a number:
#
#   - The TOTALS are the script's, not a lane's. The #520 case below is the
#     fixture the ticket names: a ledger whose true reading is "186 checked —
#     5 trued, 0 deleted, 5 raised" against the "3 trued, 3 raised" that PR
#     #520's title carried into `main` as the squash subject `6943ee6`. The
#     case asserts the true rendering AND the absence of the false one, so a
#     regression that reintroduces a typed number has somewhere to be caught.
#   - The title fragment and the table CANNOT disagree. One case reads the four
#     numbers out of the title line and the six out of the table's total row and
#     compares them, rather than asserting two literals that a future edit could
#     drift apart in step.
#   - A failing tree cannot produce a passing report. Every failure mode —
#     unresolved quote, sweep whose carrier did not come back, subject absent at
#     base, spelled-out figure, ragged comment continuation — has its own case
#     asserting a non-zero exit, because the exit code is what makes the report
#     unpasteable over a red tree.
#   - The subject's OWN positive controls ran. An emptiness claim with no
#     control is indistinguishable from a broken pattern
#     (docs/standards/evidence.md member 7), so two cases assert the control
#     output is present in the report and not merely promised by its prose.
#
# Usage: bash .claude/scripts/sweep-report.test.sh  (or `pnpm test:scripts`)
# Exit:  0 every case PASS, 1 at least one FAIL, 2 the harness itself broke.
set -uo pipefail

SCRIPTS=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd) || exit 2
SUBJECT="$SCRIPTS/sweep-report.sh"

# shellcheck source=./harness-lib.sh
. "$SCRIPTS/harness-lib.sh"
harness_init_tmp

# The fixture's carrier strings. Deliberately unlike anything this repository
# holds: every case runs against its own fixture repo, and a string that also
# occurred in the real tree would make a passing case say nothing.
SUBJECT_ALPHA="FIXTURE_CARRIER_ALPHA"
SUBJECT_BETA="FIXTURE_CARRIER_BETA"
FIXTURE_QUOTE="a fixture claim the ledger cites verbatim"

# PR #520's title, now the squash subject of `main`'s 6943ee6, against a body
# and a lane report that both said five and five. The numbers below are the
# ledger's true reading; this string is what a typed rendering produced.
FALSE_RENDERING="3 trued, 3 raised"

ROOT=""
BASE=""

# --- fixtures ----------------------------------------------------------------------------

# Identity is passed per-command: the harness must not depend on (or write) any git config.
gitc() {
  local dir="$1"
  shift
  git -C "$dir" -c user.email=test@test -c user.name=test -c commit.gpgsign=false "$@"
}

# fixture <name> -> ROOT, a fresh repo one commit deep on main, and BASE, that
# commit's sha. The base commit carries a markdown carrier file and a source
# file, so a case can trim from either, or dirty either, without creating it.
#
# The tree is left DIRTY by one benign uncommitted line. That is not decoration:
# the subject refuses a run whose diff at the base is empty — pre-checks (c) and
# (e) are emptiness claims over that diff, and over no diff they are vacuous —
# so a fixture with a clean tree would make every case exercise the refusal
# instead of the check it names. The line is not a comment and holds no
# spelled-out figure, so it trips neither (c) nor (e).
fixture() {
  ROOT="$TMP_ROOT/$1"
  must mkdir -p "$ROOT/docs" "$ROOT/src"
  must git init --quiet -b main "$ROOT"
  must printf '%s\n' \
    '# Fixture notes' \
    '' \
    "The carrier line: $SUBJECT_ALPHA is defined in src/fixture.ts." \
    "A second carrier: $SUBJECT_BETA, cited nowhere else." \
    "Standing claim — $FIXTURE_QUOTE." \
    >"$ROOT/docs/fixture-notes.md"
  must printf '%s\n' \
    "export const $SUBJECT_ALPHA = 1;" \
    'export const ordinary = 2;' \
    >"$ROOT/src/fixture.ts"
  must gitc "$ROOT" add -A
  must gitc "$ROOT" commit --quiet -m base
  BASE=$(gitc "$ROOT" rev-parse HEAD) || exit 2
  must printf '%s\n' 'export const appended = 3;' >>"$ROOT/src/fixture.ts"
}

# --- ledger construction -------------------------------------------------------------------
#
# Tabs are the format, so they are never typed into a case. ledger_new writes
# the fixed header; row joins its arguments with tabs via IFS, which is the one
# spelling that cannot silently produce a space where the format wants a tab.

LEDGER=""

ledger_new() { # ledger_new <name> -> sets LEDGER to a fresh ledger holding only the header
  LEDGER="$TMP_ROOT/$1.tsv"
  must printf 'path\tline\tclaim\tcheck\tdisposition\n' >"$LEDGER"
}

row() { # row <field>... — one ledger row, fields joined with tabs
  local IFS
  IFS=$(printf '\t')
  printf '%s\n' "$*" >>"$LEDGER"
}

run_report() { # run_report [ledger] — the production invocation against $ROOT
  capture -C "$ROOT" bash "$SUBJECT" "${1:-$LEDGER}" "$BASE"
}

# --- the two renderings, read back out of the report ----------------------------------------
#
# Both helpers reduce their line to "claims/trued/deleted/raised" by taking the
# numbers in order, so a case can compare the title against the table without
# re-stating either layout. A layout change breaks them loudly rather than
# quietly passing.

numbers_of_title() {
  printf '%s\n' "$out" | awk '
    / checked / && / raised$/ {
      gsub(/[^0-9 ]/, " ")
      n = split($0, a, / +/)
      c = 0
      for (i = 1; i <= n; i++) if (a[i] != "") v[++c] = a[i]
      print v[1] "/" v[2] "/" v[3] "/" v[4]
      exit
    }'
}

numbers_of_total_row() {
  printf '%s\n' "$out" | awk '
    /\*\*total\*\*/ {
      gsub(/[^0-9 ]/, " ")
      n = split($0, a, / +/)
      c = 0
      for (i = 1; i <= n; i++) if (a[i] != "") v[++c] = a[i]
      print v[1] "/" v[3] "/" v[4] "/" v[5]
      exit
    }'
}

# --- cases: the subject parses ---------------------------------------------------------------

begin "sweep-report.sh parses under every bash on the box"
expect_parses "$SUBJECT"
end

# --- cases: arguments -------------------------------------------------------------------------

fixture args

begin "--help prints usage and exits 0"
capture -C "$ROOT" bash "$SUBJECT" --help
expect_rc 0
expect_stdout "Usage: bash .claude/scripts/sweep-report.sh"
end

begin "no arguments is refused with no verdict"
capture -C "$ROOT" bash "$SUBJECT"
expect_rc 2
expect_stderr "Usage: bash .claude/scripts/sweep-report.sh"
end

begin "a ledger that is not a readable file is refused"
capture -C "$ROOT" bash "$SUBJECT" "$TMP_ROOT/absent.tsv" "$BASE"
expect_rc 2
expect_stderr "ledger is not a readable file"
end

begin "a base that does not resolve to a commit is refused"
ledger_new base-unknown
row docs/fixture-notes.md 3 "a claim" "read the file" verified-true
capture -C "$ROOT" bash "$SUBJECT" "$LEDGER" "deadbee"
expect_rc 2
expect_stderr "base-sha does not resolve to a commit"
end

# --- cases: ledger validation ------------------------------------------------------------------

begin "a header that is not the fixed format is refused, and names both forms"
LEDGER="$TMP_ROOT/bad-header.tsv"
must printf 'file\tline\tclaim\tcheck\tdisposition\n' >"$LEDGER"
row docs/fixture-notes.md 3 "a claim" "read the file" verified-true
run_report
expect_rc 2
expect_stderr "the header is not the fixed format"
expect_stderr "expected: path"
expect_not_stdout "### PR title fragment"
end

begin "an unknown disposition is rejected by name and ledger line"
ledger_new bad-disposition
row docs/fixture-notes.md 3 "a claim" "read the file" verified-true
row docs/fixture-notes.md 4 "another claim" "read the file" "mostly-true"
run_report
expect_rc 2
expect_stderr "ledger line 3"
expect_stderr 'unknown disposition "mostly-true"'
expect_stderr "verified-true, trued, deleted, out-of-scope, restored"
end

begin "a ledger holding only its header is refused"
ledger_new empty
run_report
expect_rc 2
expect_stderr "holds no data rows"
end

begin "a row with fewer than five columns is refused"
ledger_new short-row
must printf 'docs/fixture-notes.md\t3\ta claim\n' >>"$LEDGER"
run_report
expect_rc 2
expect_stderr "the fixed format is five tab-separated columns"
end

begin "a trued row that names no trimmed subject is refused"
ledger_new no-subject
row docs/fixture-notes.md 3 "a claim" "read the file" trued
run_report
expect_rc 2
expect_stderr "must name the trimmed subject"
end

begin "an out-of-scope row that names no quote is refused"
ledger_new no-quote
row docs/fixture-notes.md 3 "the code is wrong" "read the code" out-of-scope
run_report
expect_rc 2
expect_stderr "must name at least one quote="
end

begin "a sweep without its positive control is refused"
ledger_new sweep-no-control
row docs/fixture-notes.md 3 "a claim" "read the file" verified-true "sweep=FIXTURE_CARRIER_\\w+"
run_report
expect_rc 2
expect_stderr "sweep= without control="
end

begin "an unknown directive key is rejected by name"
ledger_new bad-key
row docs/fixture-notes.md 3 "a claim" "read the file" verified-true "carrier=docs/fixture-notes.md"
run_report
expect_rc 2
expect_stderr 'unknown directive key "carrier"'
end

# --- cases: totals, and the two renderings agreeing ------------------------------------------

# Every disposition is non-zero somewhere in this ledger, `deleted` included:
# it is one of the four numbers in the PR title fragment (PR #512's real title
# carried "1 deleted"), so an arm nothing exercises is an arm that can be
# deleted without a case going red.
ledger_new totals
row docs/fixture-notes.md 3 "carrier claim" "read the file" verified-true
row docs/fixture-notes.md 4 "second claim" "git grep" trued "subject=$SUBJECT_BETA"
row docs/fixture-notes.md 5 "an unverifiable claim" "no reader can settle it" deleted "subject=$SUBJECT_BETA"
row src/fixture.ts 1 "the constant exists" "read the file" verified-true
row src/fixture.ts 2 "a deleted carrier, since restored" "git show base" restored
row src/fixture.ts 2 "the code is wrong here" "read the code" out-of-scope "quote=$FIXTURE_QUOTE"

begin "totals come out per file and in a total row, every disposition non-zero"
run_report
expect_rc 0
expect_stdout "    6 checked — 1 trued, 1 deleted, 1 raised"
expect_stdout "| \`docs/fixture-notes.md\` | 3 | 1 | 1 | 1 | 0 | 0 |"
expect_stdout "| \`src/fixture.ts\` | 3 | 1 | 0 | 0 | 1 | 1 |"
expect_stdout '| **total** | **6** | **2** | **1** | **1** | **1** | **1** |'
end

begin "the title fragment's numbers equal the table's total row"
# Re-run rather than read the previous case's $out: an assertion over a run
# somebody else made is an assertion a future inserted case silently repoints.
run_report
title=$(numbers_of_title)
totals=$(numbers_of_total_row)
[ -n "$title" ] || bad "no title fragment in the report"
[ "$title" = "$totals" ] || bad "title says $title, the table's total row says $totals"
[ "$title" = "6/1/1/1" ] || bad "title numbers are $title, expected 6/1/1/1"
end

begin "#520's ledger: the true rendering is printed and the typed one is absent"
# 186 claims: 176 verified-true, 5 trued, 0 deleted, 5 out-of-scope — the reading
# PR #520's body and lane report both gave. Its TITLE said 3 and 3, and the title
# is what merge-pr.sh turns into the squash subject, so that is the rendering that
# became history. Here both renderings come out of one computation.
ledger_new pr520
i=1
while [ "$i" -le 176 ]; do
  row docs/fixture-notes.md "$i" "verified claim $i" "read the file" verified-true
  i=$((i + 1))
done
i=1
while [ "$i" -le 5 ]; do
  row docs/fixture-notes.md "$i" "trued claim $i" "git grep" trued "subject=$SUBJECT_BETA"
  i=$((i + 1))
done
i=1
while [ "$i" -le 5 ]; do
  row docs/fixture-notes.md "$i" "the code is wrong, not the prose ($i)" "read the code" out-of-scope "quote=$FIXTURE_QUOTE"
  i=$((i + 1))
done
run_report
expect_rc 0
expect_stdout "    186 checked — 5 trued, 0 deleted, 5 raised"
expect_stdout '| **total** | **186** | **176** | **5** | **0** | **5** | **0** |'
expect_not_stdout "$FALSE_RENDERING"
end

begin "#520's ledger: the title and the table still agree at 186 rows"
run_report
title=$(numbers_of_title)
totals=$(numbers_of_total_row)
[ "$title" = "186/5/0/5" ] || bad "title numbers are $title, expected 186/5/0/5"
[ "$title" = "$totals" ] || bad "title says $title, the table's total row says $totals"
end

# --- cases: the pre-checks pass on a clean tree -------------------------------------------------

begin "a clean ledger and tree: every pre-check runs, with its command above its output"
ledger_new clean
row docs/fixture-notes.md 3 "the carrier is cited" "git grep" trued "subject=$SUBJECT_ALPHA"
row docs/fixture-notes.md 4 "the second carrier" "sweep" verified-true "sweep=FIXTURE_CARRIER_\\w+" "control=docs/fixture-notes.md"
row src/fixture.ts 1 "the code is wrong here" "read the code" out-of-scope "quote=$FIXTURE_QUOTE"
run_report
expect_rc 0
expect_stdout "sweep-report: OK"
expect_stdout "### Pre-check (a) — inbound references"
expect_stdout "### Pre-check (b) — ledger sweeps"
expect_stdout "### Pre-check (c) — no spelled-out figure"
expect_stdout "### Pre-check (d) — every quoted string resolves"
expect_stdout "### Pre-check (e) — comment reflow"
# The command is printed above its own output, from the argv that ran.
expect_stdout "\$ git grep -n -F -e $SUBJECT_ALPHA $BASE -- docs/fixture-notes.md"
expect_stdout "\$ git grep -n -F -e $SUBJECT_ALPHA -- ':!docs/fixture-notes.md'"
# Pre-check (a)'s inbound sweep found src/fixture.ts, which is the hit a reader must read.
expect_stdout "src/fixture.ts:1:export const $SUBJECT_ALPHA"
end

begin "the subject's own positive controls are in the report, not merely promised"
# evidence.md member 7: an emptiness claim with no control says nothing. Both
# built-in controls must have produced visible output.
run_report
expect_stdout "+ // a three-second debounce"
expect_stdout "reflow-control.ts:"
end

begin "a tech-debt skeleton is emitted per out-of-scope row, quotes resolved"
run_report
expect_stdout "- Where: \`src/fixture.ts\` · \`docs/fixture-notes.md\` carries \"$FIXTURE_QUOTE\""
expect_stdout "- What: the code is wrong here"
# The heading carries a placeholder, never today's date: rule 4 has a reviewer
# re-run the script and diff its output against the PR body, and a clock in the
# output makes that diff non-empty for a reason nobody chose.
expect_stdout "## <YYYY-MM-DD> — the code is wrong here"
end

# --- cases: a failing check cannot produce a passing report --------------------------------------

begin "an unresolved quote fails the run"
ledger_new missing-quote
row src/fixture.ts 1 "the code is wrong here" "read the code" out-of-scope "quote=a claim no file in this tree carries"
run_report
expect_rc 1
expect_stdout "unresolved quote"
expect_stderr "check(s) failed"
expect_not_stdout "sweep-report: OK"
end

begin "a sweep whose declared carrier does not come back fails the run"
# The sweep matches both real carriers; the carrier it DECLARES is a file it
# never returns, which is the shape prose.md rule 3(b)'s control exists to catch
# — a pattern that looks productive while missing the member that matters.
ledger_new sweep-miss
row docs/fixture-notes.md 3 "a claim" "sweep" verified-true "sweep=FIXTURE_CARRIER_\\w+" "control=docs/uncited-carrier.md"
run_report
expect_rc 1
expect_stdout "NONE of them is its declared carrier"
end

begin "a subject the base does not carry fails the run on its positive control"
ledger_new subject-miss
row docs/fixture-notes.md 3 "a claim" "git grep" trued "subject=FIXTURE_CARRIER_TYPO"
run_report
expect_rc 1
expect_stdout "positive control"
expect_stdout "the ledger names a subject the base does not carry"
end

begin "a spelled-out figure added to the diff fails the run"
fixture spelled
must printf '%s\n' \
  "export const $SUBJECT_ALPHA = 1;" \
  '// a three-second debounce before the retry' \
  >"$ROOT/src/fixture.ts"
fixture_has "$ROOT/src/fixture.ts" "three-second"
ledger_new spelled
row docs/fixture-notes.md 3 "a claim" "read the file" verified-true
run_report
expect_rc 1
expect_stdout "spell a figure out in words"
end

begin "a ragged comment continuation added to the diff fails the run"
fixture reflow
must printf '%s\n' \
  "export const $SUBJECT_ALPHA = 1;" \
  '// a short note' \
  '// this continuation line is deliberately wide enough to count as a full-width one' \
  >"$ROOT/src/fixture.ts"
fixture_has "$ROOT/src/fixture.ts" "a short note"
ledger_new reflow
row docs/fixture-notes.md 3 "a claim" "read the file" verified-true
run_report
expect_rc 1
expect_stdout "ragged comment continuation"
end

begin "a trim whose continuation is an UNCHANGED line is still a reflow finding"
# The canonical shape, and the one a "both lines added" detector misses: a trim
# shortens one comment line and leaves the paragraph under it alone, so the
# continuation reaches the diff as a context line.
fixture reflow-context
must printf '%s\n' \
  "export const $SUBJECT_ALPHA = 1;" \
  '// The retry backoff is capped at the ceiling the transport sets, per ADR 0009.' \
  '// and this continuation line is wide enough to count as a full-width continuation' \
  >"$ROOT/src/fixture.ts"
must gitc "$ROOT" add -A
must gitc "$ROOT" commit --quiet -m "the untrimmed comment"
BASE=$(gitc "$ROOT" rev-parse HEAD) || exit 2
must printf '%s\n' \
  "export const $SUBJECT_ALPHA = 1;" \
  '// The retry backoff' \
  '// and this continuation line is wide enough to count as a full-width continuation' \
  >"$ROOT/src/fixture.ts"
fixture_has "$ROOT/src/fixture.ts" "// The retry backoff"
fixture_lacks "$ROOT/src/fixture.ts" "per ADR 0009"
ledger_new reflow-context
row docs/fixture-notes.md 3 "a claim" "read the file" verified-true
run_report
expect_rc 1
expect_stdout "ragged comment continuation"
end

begin "a shebang above a long comment is not a reflow finding"
# `#!/usr/bin/env bash` is one unpunctuated word under a `#` marker, and every
# shell script in this repository has a long comment directly beneath it.
fixture reflow-shebang
must printf '%s\n' \
  '#!/usr/bin/env bash' \
  '# A docblock line that is comfortably wider than the continuation threshold.' \
  >"$ROOT/src/fixture.ts"
fixture_has "$ROOT/src/fixture.ts" "#!/usr/bin/env bash"
ledger_new reflow-shebang
row docs/fixture-notes.md 3 "a claim" "read the file" verified-true
run_report
expect_rc 0
expect_stdout "no ragged comment continuation"
end

begin "the same shape in a markdown file is not a reflow finding"
# `#` is a heading and `*` a bullet in markdown, and prettier reflows markdown
# prose but not comments — so without the skip the check fires on ordinary
# prose edits. Both lines here are comment-lookalikes under the detector's own
# markers, so the case reds if the skip is removed.
fixture reflow-markdown
must printf '%s\n' \
  '# Fixture notes' \
  '' \
  '## A heading' \
  '* this bullet line is deliberately wide enough to count as a full-width continuation' \
  >"$ROOT/docs/fixture-notes.md"
fixture_has "$ROOT/docs/fixture-notes.md" "A heading"
ledger_new reflow-markdown
row src/fixture.ts 1 "a claim" "read the file" verified-true
run_report
expect_rc 0
expect_stdout "no ragged comment continuation"
end

# --- cases: a broken tool is not a clean tree ---------------------------------------------------

begin "a git failure is reported as a failure, not counted as a hit"
# run_shown keeps stderr out of the file it counts. Merged, `fatal: …` is one
# line, and a line count over it reports a broken command as a found carrier.
fixture git-error
ledger_new git-error
row ':(bogus)src/fixture.ts' 1 "a claim" "git grep" trued "subject=$SUBJECT_ALPHA"
run_report
expect_rc 1
expect_stdout "pre-check (a) could not run"
expect_stdout "Invalid pathspec magic"
expect_not_stdout "sweep-report: OK"
# The stderr block is what proves the streams are SEPARATE. Merged, this label
# never appears and git's fatal sits in the file the report counts lines from —
# which is the shape that reports a broken command as a found carrier.
expect_stdout "# stderr (exit "
end

begin "a sweep's control must be the FILE a hit came from, not text inside one"
# `git grep -n` prints `path:line:content`, and a restatement ledger's sweep
# routinely returns lines whose CONTENT names other paths. A substring test over
# the whole line lets the control certify a carrier the sweep never returned.
fixture control-in-content
must printf '%s\n' \
  '# Fixture notes' \
  '' \
  "The carrier list names src/absent-carrier.ts as a site: $SUBJECT_ALPHA." \
  >"$ROOT/docs/fixture-notes.md"
fixture_has "$ROOT/docs/fixture-notes.md" "src/absent-carrier.ts"
ledger_new control-in-content
row docs/fixture-notes.md 3 "a claim" "sweep" verified-true "sweep=$SUBJECT_ALPHA" "control=src/absent-carrier.ts"
run_report
expect_rc 1
expect_stdout "NONE of them is its declared carrier"
end

# --- case: an empty diff is not a clean batch ----------------------------------------------------

begin "a diff that is empty at the base fails checks (c) and (e) rather than passing them"
# Their silence would otherwise be about the base, not about the batch — a
# report generated against the wrong sha reads exactly like a clean one.
fixture empty-diff
must gitc "$ROOT" checkout -- .
ledger_new empty-diff
row docs/fixture-notes.md 3 "a claim" "read the file" verified-true
run_report
expect_rc 1
expect_stdout "Diff at this base (tracked working tree vs \`$BASE\`): 0 file(s), +0 / -0 line(s)"
expect_stdout "pre-check (c) had nothing to run over"
expect_stdout "pre-check (e) had nothing to run over"
end

begin "the diff's scale is in the header, so an emptiness claim has its scale beside it"
fixture scale
ledger_new scale
row docs/fixture-notes.md 3 "a claim" "read the file" verified-true
run_report
expect_rc 0
expect_stdout "Diff at this base (tracked working tree vs \`$BASE\`): 1 file(s), +1 / -0 line(s)"
end

# --- cases: the diff calls' failure paths, through the SWEEP_REPORT_GIT_CMD seam --------------
#
# Pre-checks (a) and (b) are made to fail with a real git from the ledger — a
# bad pathspec for (a), an invalid PCRE for (b). The three `git diff` calls take
# no ledger input at all, so their failure paths are unreachable from a fixture;
# the seam is how they get asserted, the same move lint-shell.sh makes for its
# own discovery call. The stub fails on the Nth call and otherwise delegates to
# the real git: calls 1 and 3 are argv-identical, so order is the only thing
# that tells them apart — 1 the header diff, 2 the header --numstat, 3
# pre-check (c)'s pipeline.

# The stub is written through a QUOTED heredoc rather than a printf of
# single-quoted lines: shell code inside a format string reads as unexpanded
# expressions to shellcheck (SC2016), and a suppression is itself a lint error.
STUB_GIT=""
make_stub_git() {
  STUB_GIT="$TMP_ROOT/stub-git"
  cat >"$STUB_GIT" <<'STUB'
#!/usr/bin/env bash
n=$(cat "$STUB_GIT_COUNT" 2>/dev/null || printf 0)
n=$((n + 1))
printf '%s' "$n" >"$STUB_GIT_COUNT"
if [ "$n" = "$STUB_GIT_FAIL_ON" ]; then
  printf 'stub-git: deliberate failure on call %s\n' "$n" >&2
  exit 3
fi
exec git "$@"
STUB
  fixture_has "$STUB_GIT" 'exec git "$@"'
  must chmod +x "$STUB_GIT"
}

run_with_stub_git() { # run_with_stub_git <fail-on-call-number>
  must rm -f "$TMP_ROOT/stub-git.count"
  capture -C "$ROOT" env \
    "SWEEP_REPORT_GIT_CMD=$STUB_GIT" \
    "STUB_GIT_COUNT=$TMP_ROOT/stub-git.count" \
    "STUB_GIT_FAIL_ON=$1" \
    bash "$SUBJECT" "$LEDGER" "$BASE"
}

make_stub_git

begin "a failing git diff is no verdict, not an empty diff"
fixture git-diff-fails
ledger_new git-diff-fails
row docs/fixture-notes.md 3 "a claim" "read the file" verified-true
run_with_stub_git 1
expect_rc 2
expect_stderr "diff $BASE failed (exit 3)"
expect_stderr "deliberate failure on call 1"
end

begin "a failing git diff --numstat is no verdict, not a zero-line scale"
run_with_stub_git 2
expect_rc 2
expect_stderr "--numstat $BASE failed (exit 3)"
end

begin "pre-check (c) refuses when its pipeline could not run"
# Without this refusal the pipeline's silence reads as a clean tree — the same
# class as the git-failure case above, one caller short (evidence.md form 5).
run_with_stub_git 3
expect_rc 1
expect_stdout "pre-check (c) could not run"
# The stub's own words, so the failure DETAIL is load-bearing rather than
# decorative: a reader is told which command failed and how.
expect_stdout "deliberate failure on call 3"
expect_not_stdout "no spelled-out figure across"
end

begin "a sweep whose pattern git cannot compile fails the run, and says so"
# This is how pre-check (b)'s refusal arm is reachable without a stub: the
# pattern is the one part of a sweep the ledger controls, and an invalid PCRE
# makes git itself refuse. Measured without the arm: the run reports "returned 0
# line(s) and NONE of them is its declared carrier" — a tool failure
# misdiagnosed as a wrong pattern or a carrier that has gone.
fixture bad-pcre
ledger_new bad-pcre
row docs/fixture-notes.md 3 "a claim" "sweep" verified-true "sweep=FIXTURE_CARRIER_(unclosed" "control=docs/fixture-notes.md"
run_report
expect_rc 1
expect_stdout "pre-check (b) could not run the sweep"
expect_not_stdout "sweep-report: OK"
end

begin "a seam value that could reach bash -c as more than one word is refused"
# pre-check (c) runs as a STRING through bash -c, so the seam is validated to a
# path-safe character class before anything reads it; lint-shell.sh's precedent
# uses its own seam in argv position only, where a value is inert.
#
# The discriminating assertion is expect_stderr, not the exit code: unguarded,
# BOTH values below still exit 2 — they reach the header's `git diff` in argv
# position first, where a value holding a metacharacter is simply not an
# executable, and the run dies there with "diff <sha> failed (exit 127)". The
# message is what tells "refused by the seam's own validation" apart from
# "happened to fail later for another reason". The second value is the one that
# would survive argv position and still break: a real directory whose name holds
# a space, which `bash -c` splits into two words.
fixture hostile-seam
ledger_new hostile-seam
row docs/fixture-notes.md 3 "a claim" "read the file" verified-true
capture -C "$ROOT" env "SWEEP_REPORT_GIT_CMD=git; touch $TMP_ROOT/pwned" bash "$SUBJECT" "$LEDGER" "$BASE"
expect_rc 2
expect_stderr "SWEEP_REPORT_GIT_CMD must be a command name or path"
expect_not_stderr "failed (exit 127)"

must mkdir -p "$TMP_ROOT/seam dir"
must cp "$STUB_GIT" "$TMP_ROOT/seam dir/git"
capture -C "$ROOT" env "SWEEP_REPORT_GIT_CMD=$TMP_ROOT/seam dir/git" bash "$SUBJECT" "$LEDGER" "$BASE"
expect_rc 2
expect_stderr "SWEEP_REPORT_GIT_CMD must be a command name or path"
end

begin "a ledger inside the repo is printed repo-relative, so the command pastes back"
# The path as typed resolves only from the directory the lane happened to stand
# in; rule 4 asks a reviewer to re-run this from the root.
fixture ledger-in-repo
must mkdir -p "$ROOT/docs/sweeps"
LEDGER="$ROOT/docs/sweeps/522-ledger.tsv"
must printf 'path\tline\tclaim\tcheck\tdisposition\n' >"$LEDGER"
row docs/fixture-notes.md 3 "a claim" "read the file" verified-true
run_report
expect_rc 0
expect_stdout "Command: \`bash .claude/scripts/sweep-report.sh docs/sweeps/522-ledger.tsv $BASE\`"
expect_not_stdout "Command: \`bash .claude/scripts/sweep-report.sh $ROOT"
end

finish
