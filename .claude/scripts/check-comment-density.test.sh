#!/usr/bin/env bash
# Test harness for check-comment-density.sh, its neighbour in this directory.
#
# No test framework, no network, no pnpm: the assertion vocabulary is harness-lib.sh
# next door. Every fixture is a throwaway repo-shaped tree under the temp tree
# `harness_init_tmp` makes and a trap deletes on exit, with files written at exact
# ratios — so a case names its own cause and the real repository's baseline is never
# touched.
#
# These cases ARE the gate's negative controls, committed rather than run once by hand
# (testing.md rule 4). The three the issue names — a file that grew, a file that shrank,
# a new file above the median — are sections 4, 5 and 6; the rest are the ways a gate of
# this shape fails silently: a classifier that miscounts, a bootstrap that loads the scan
# as its own baseline, a --ratchet that banks a red run, a baseline nobody can parse, and
# discovery that finds nothing and calls it a pass.
#
# One case deliberately runs the gate with NO argument, against the real repo: every other
# case pins REPO_ROOT to a fixture, so without it the shipped default path could be broken
# and the suite would still be green (testing.md rule 7).
#
# Usage: bash .claude/scripts/check-comment-density.test.sh   (or `pnpm test:scripts`)
# Exit:  0 every case PASS, 1 at least one FAIL, 2 the harness itself broke.
set -uo pipefail

SCRIPTS=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd) || exit 2
CHECK="$SCRIPTS/check-comment-density.sh"
BASELINE_REL=".claude/comment-density.baseline.tsv"

# shellcheck source=./harness-lib.sh
. "$SCRIPTS/harness-lib.sh"
harness_init_tmp

# --- fixtures ----------------------------------------------------------------------------

# srcfile <path> <comment-lines> <code-lines> — a file at an exact ratio. Each comment line
# is a distinct `//` line and each code line a distinct export, with a blank line between
# the two runs to prove blanks land in neither count.
srcfile() {
  local path="$1" comments="$2" code="$3" i
  mkdir -p "$(dirname "$path")" || return 1
  : >"$path" || return 1
  for ((i = 1; i <= comments; i++)); do
    printf '// prose line %d\n' "$i" >>"$path" || return 1
  done
  printf '\n' >>"$path" || return 1
  for ((i = 1; i <= code; i++)); do
    printf 'export const value%d = %d;\n' "$i" "$i" >>"$path" || return 1
  done
}

# fixture <name> -> DIR, a repo-shaped tree whose three files sit at 2000, 4000 and 6000
# basis points. The median of those three rows is 4000, which is what every new-file case
# is measured against.
fixture() {
  DIR="$TMP_ROOT/$1"
  must rm -rf "$DIR"
  must mkdir -p "$DIR/.claude"
  must srcfile "$DIR/packages/shared/src/a.ts" 2 8
  must srcfile "$DIR/packages/shared/src/b.ts" 4 6
  must srcfile "$DIR/apps/web/src/c.ts" 6 4
}

# bootstrap — the baseline the fixture's own files produce, written by the gate.
bootstrap() {
  must bash "$CHECK" --ratchet "$DIR" >/dev/null 2>&1
}

run_check_with() { # run_check_with <bash> <args...>  (the fixture root is appended)
  local interpreter="$1"
  shift
  capture "$interpreter" "$CHECK" "$@" "$DIR"
}

run_check() { # run_check <args...>
  run_check_with bash "$@"
}

baseline_of() { # baseline_of -> the fixture's baseline rows, comments stripped
  command grep -v '^#' "$DIR/$BASELINE_REL"
}

# ==========================================================================================
# 1. the gate parses, and passes on the repository it ships in
# ==========================================================================================

begin "check-comment-density.sh parses (bash -n)"
expect_parses "$CHECK"
end

# The production configuration: no REPO_ROOT override, so this is the only case that can
# catch a broken default path or a committed baseline the tree has outgrown — and it is what
# `pnpm verify` actually runs. Under every bash on the box, the real tree being the largest
# argument list this gate builds.
begin "the repo's own source tree is at or below its committed baseline, with no argument"
for interpreter in $BASHES; do
  case_ctx="$interpreter"
  capture "$interpreter" "$CHECK"
  expect_rc 0 "$rc"
  expect_stdout "check-comment-density: OK"
  expect_not_out "unbound variable"
done
case_ctx=""
end

# ==========================================================================================
# 2. the classifier
# ==========================================================================================
# The gate's whole verdict rests on one definition, so each shape gets a case asserting the
# RATIO the gate reports rather than its verdict: a miscount that happens to stay under the
# baseline would pass every verdict case in this file.

classify() { # classify <file contents on stdin> -> the one file's reported ratio in `out`
  must rm -rf "$DIR"
  must mkdir -p "$DIR/.claude" "$DIR/packages/shared/src"
  must cp /dev/stdin "$DIR/packages/shared/src/only.ts"
  run_check --ratchet
}

begin "ten lines of // over ten lines of code is 5000 bp, and blank lines are in neither count"
DIR="$TMP_ROOT/classify-line"
must srcfile "$TMP_ROOT/classify-src.ts" 10 10
must rm -rf "$DIR"
must mkdir -p "$DIR/.claude" "$DIR/packages/shared/src"
must cp "$TMP_ROOT/classify-src.ts" "$DIR/packages/shared/src/only.ts"
run_check --ratchet
expect_rc 0
expect_stdout "packages/shared/src/only.ts: 50.00% (5000) (new row)"
end

begin "a block comment's interior counts even where its lines do not start with *"
DIR="$TMP_ROOT/classify-block"
classify <<'EOF'
/*
  Three interior lines, none of them starting with a star, and the opener
  and the closer besides, which is five comment lines over the five of
  code below.
*/
export const a = 1;
export const b = 2;
export const c = 3;
export const d = 4;
export const e = 5;
EOF
expect_rc 0
expect_stdout "packages/shared/src/only.ts: 50.00% (5000) (new row)"
end

begin "a multi-line {/* … */} JSX comment counts, opener to closer"
DIR="$TMP_ROOT/classify-jsx"
classify <<'EOF'
{/* The opener, which a line-start // scan misses entirely, and two
    continuation lines that start with neither a slash nor a star
    before the closer arrives at the end of this one. */}
export const a = 1;
EOF
expect_rc 0
expect_stdout "packages/shared/src/only.ts: 75.00% (7500) (new row)"
end

begin "a line that closes a comment and then carries code is a code line"
DIR="$TMP_ROOT/classify-closer"
classify <<'EOF'
/* an opener
   and an interior */ export const a = 1;
export const b = 2;
EOF
expect_rc 0
expect_stdout "packages/shared/src/only.ts: 33.33% (3333) (new row)"
end

# The one shape the in-block state machine cannot reach: the opener shares its line with
# code, so the machine never enters the block. The `*`-continuation arm counts the
# continuation lines that begin with `*`, and only this shape exercises that arm — a mutant
# deleting it left every other case green. A continuation line that does NOT begin with `*`
# is counted as code; that residual is pinned by the case after this one.
begin "a block opened after code on the same line still has its continuation lines counted"
DIR="$TMP_ROOT/classify-midline"
classify <<'EOF'
export const a = run(); /* why it is done this way,
 * on a continuation line the state machine never saw open,
 */
export const b = 2;
EOF
expect_rc 0
expect_stdout "packages/shared/src/only.ts: 50.00% (5000) (new row)"
end

begin "a block opened after code is not entered, so its bare continuation lines count as code"
DIR="$TMP_ROOT/classify-midline-bare"
classify <<'EOF'
export const a = 1; /*
prose one
prose two
*/
export const b = 2;
EOF
expect_rc 0
expect_stdout "packages/shared/src/only.ts: 20.00% (2000) (new row)"
end

# Single-line blocks take the closer arm, which no multi-line case reaches: a mutant that
# stopped counting them dropped 135 real files' ratios and read as merely "stale".
begin "single-line /** … */ and {/* … */} blocks each count as one comment line"
DIR="$TMP_ROOT/classify-single-line-block"
classify <<'EOF'
/** what the symbol is for */
{/* a JSX note */}
export const a = 1;
export const b = 2;
EOF
expect_rc 0
expect_stdout "packages/shared/src/only.ts: 50.00% (5000) (new row)"
end

begin "a trailing comment on a code line is a code line, so terse annotation costs nothing"
DIR="$TMP_ROOT/classify-trailing"
classify <<'EOF'
export const a = 1; // why, in four words
export const b = 2; // and again here
EOF
expect_rc 0
expect_stdout "packages/shared/src/only.ts: 0.00% (0) (new row)"
end

begin "a file with no non-blank line is reported unmeasurable rather than counted as zero"
DIR="$TMP_ROOT/classify-blank"
must rm -rf "$DIR"
must mkdir -p "$DIR/.claude" "$DIR/packages/shared/src"
must srcfile "$DIR/packages/shared/src/a.ts" 4 6
must printf '\n\n\n' >"$DIR/packages/shared/src/blank.ts"
run_check --ratchet
expect_rc 0
expect_stdout "1 file(s) have no non-blank line"
expect_not_stdout "packages/shared/src/blank.ts: 0.00%"
end

begin "a zero-byte file is reported unmeasurable too, though awk never sees a record of it"
DIR="$TMP_ROOT/classify-zero-byte"
must rm -rf "$DIR"
must mkdir -p "$DIR/.claude" "$DIR/packages/shared/src"
must srcfile "$DIR/packages/shared/src/a.ts" 4 6
must touch "$DIR/packages/shared/src/empty.ts"
run_check --ratchet
expect_rc 0
expect_stdout "1 file(s) have no non-blank line"
end

# ==========================================================================================
# 3. the bootstrap, which is the one run with no bar to measure against
# ==========================================================================================

begin "no baseline and no --ratchet is no verdict, and names the command that makes one"
fixture bootstrap-refuse
run_check
expect_rc 2
expect_stderr "no baseline at $BASELINE_REL"
expect_stderr "--ratchet"
end

# The regression this case exists for: the baseline arm used to be selected by awk's
# `NR == FNR` idiom, which reads "still on the first file" and is therefore true for EVERY
# record of the second file when the first is empty. The bootstrap run's baseline is empty
# by construction, so it loaded the whole scan as its own baseline, compared nothing, and
# wrote a baseline of zero rows while reporting success.
begin "--ratchet with no baseline pins every file, and does not mistake the scan for a baseline"
fixture bootstrap-write
run_check --ratchet
expect_rc 0
expect_stdout "0 lowered, 3 added, 0 dropped"
[ "$(baseline_of | command grep -c '')" = "3" ] || bad "expected 3 baseline rows, got: $(baseline_of)"
baseline_of | command grep -qE '^packages/shared/src/a\.ts	2000$' || bad "a.ts row wrong: $(baseline_of)"
baseline_of | command grep -qE '^apps/web/src/c\.ts	6000$' || bad "c.ts row wrong: $(baseline_of)"
end

# Only a MISSING baseline bootstraps. One that exists with no row would set the median to
# the scale's ceiling, admit everything, and let --ratchet pin every file at its current
# ratio — raising every row.
begin "a baseline that exists but holds no row is refused in both modes, and left untouched"
fixture baseline-empty
must printf '# header only\n' >"$DIR/$BASELINE_REL"
must cp "$DIR/$BASELINE_REL" "$TMP_ROOT/baseline-empty.before"
run_check
expect_rc 2
expect_stderr "exists but holds no row"
run_check --ratchet
expect_rc 2
expect_stderr "exists but holds no row"
cmp -s "$TMP_ROOT/baseline-empty.before" "$DIR/$BASELINE_REL" ||
  bad "a --ratchet run against a row-less baseline wrote it: $(cat "$DIR/$BASELINE_REL")"
end

begin "a baseline's comment and blank lines are skipped, not parsed as rows"
fixture baseline-comments
bootstrap
must printf '\n# a hand-added note\n' >>"$DIR/$BASELINE_REL"
run_check
expect_rc 0
expect_stdout "3 baseline row(s)"
end

# ==========================================================================================
# 4. a file that grew — the issue's first negative control
# ==========================================================================================

begin "one added comment line fails the gate, with both numbers and the line counts"
fixture grew
bootstrap
must printf '// one more line of prose\n' >>"$DIR/packages/shared/src/b.ts"
run_check
expect_rc 1
expect_stderr "1 file(s) above the committed comment density"
expect_stderr "ERROR packages/shared/src/b.ts: 45.45% (4545) > baseline 40.00% (4000) — 5 comment / 11 non-blank line(s)"
expect_stderr "delete, cite or move-to-test"
expect_not_stdout "check-comment-density: OK"
end

begin "deleting a code line fails the gate too — the ratio is the subject, not the comment count"
fixture grew-by-shrinking
bootstrap
must perl -ni -e 'print unless /^export const value6 = 6;$/' "$DIR/packages/shared/src/b.ts"
fixture_lacks "$DIR/packages/shared/src/b.ts" "export const value6"
run_check
expect_rc 1
expect_stderr "ERROR packages/shared/src/b.ts: 44.44% (4444) > baseline 40.00% (4000)"
end

begin "a --ratchet run that is red writes nothing — a half-lowered baseline is worse than none"
fixture ratchet-red
bootstrap
must cp "$DIR/$BASELINE_REL" "$TMP_ROOT/ratchet-red.before"
must printf '// one more line of prose\n' >>"$DIR/packages/shared/src/b.ts"
must perl -ni -e 'print unless /^\/\/ prose line 6$/' "$DIR/apps/web/src/c.ts"
fixture_lacks "$DIR/apps/web/src/c.ts" "// prose line 6"
run_check --ratchet
expect_rc 1
expect_stderr "ERROR packages/shared/src/b.ts"
cmp -s "$TMP_ROOT/ratchet-red.before" "$DIR/$BASELINE_REL" ||
  bad "the baseline was rewritten by a red --ratchet run: $(baseline_of)"
end

# ==========================================================================================
# 5. a file that shrank — the issue's second negative control
# ==========================================================================================

begin "a file that shrank passes, and the pass says the baseline is now stale"
fixture shrank
bootstrap
must perl -ni -e 'print unless /^\/\/ prose line 6$/' "$DIR/apps/web/src/c.ts"
fixture_lacks "$DIR/apps/web/src/c.ts" "// prose line 6"
run_check
expect_rc 0
expect_stdout "check-comment-density: OK"
expect_stdout "baseline is stale (1 lower, 0 unpinned, 0 gone)"
end

begin "--ratchet banks the fall, and the lowered row is what the next run holds the file to"
fixture ratchet-down
bootstrap
must perl -ni -e 'print unless /^\/\/ prose line 6$/' "$DIR/apps/web/src/c.ts"
fixture_lacks "$DIR/apps/web/src/c.ts" "// prose line 6"
run_check --ratchet
expect_rc 0
expect_stdout "1 lowered, 0 added, 0 dropped"
expect_stdout "apps/web/src/c.ts: 60.00% (6000) -> 55.55% (5555)"
baseline_of | command grep -qE '^apps/web/src/c\.ts	5555$' || bad "row not lowered: $(baseline_of)"
# The ratchet's point: the line cannot come back.
must printf '// prose line 6\n' >>"$DIR/apps/web/src/c.ts"
run_check
expect_rc 1
expect_stderr "> baseline 55.55% (5555)"
end

begin "--ratchet with nothing to bank leaves the file alone and says so"
fixture ratchet-noop
bootstrap
must cp "$DIR/$BASELINE_REL" "$TMP_ROOT/ratchet-noop.before"
run_check --ratchet
expect_rc 0
expect_stdout "baseline already matches — nothing to ratchet"
cmp -s "$TMP_ROOT/ratchet-noop.before" "$DIR/$BASELINE_REL" ||
  bad "a no-op --ratchet rewrote the baseline"
end

begin "a deleted file's row is dropped by --ratchet, and is harmless until then"
fixture ratchet-drop
bootstrap
must rm "$DIR/packages/shared/src/b.ts"
run_check
expect_rc 0
expect_stdout "baseline is stale (0 lower, 0 unpinned, 1 gone)"
run_check --ratchet
expect_rc 0
expect_stdout "0 lowered, 0 added, 1 dropped"
baseline_of | command grep -q 'packages/shared/src/b.ts' &&
  bad "the deleted file's row survived --ratchet: $(baseline_of)"
end

# ==========================================================================================
# 6. a file with no row — the issue's third negative control, and the median rule
# ==========================================================================================

begin "a new file above the median fails, naming the median it was measured against"
fixture new-above
bootstrap
must srcfile "$DIR/packages/shared/src/new.ts" 6 4
run_check
expect_rc 1
expect_stderr "ERROR packages/shared/src/new.ts: 60.00% (6000) > repo median 40.00% (4000)"
expect_stderr "admitted at or below the median"
end

begin "a new file AT the median is admitted, and one below it is too"
fixture new-at
bootstrap
must srcfile "$DIR/packages/shared/src/at.ts" 4 6
must srcfile "$DIR/packages/shared/src/below.ts" 1 9
run_check
expect_rc 0
expect_stdout "check-comment-density: OK"
expect_stdout "0 lower, 2 unpinned, 0 gone"
end

# The median is read from the BASELINE's rows, not from the current scan — so a batch of new
# dense files cannot lift the bar it is being judged against. Without that, five files at
# 6000 would drag the scan's median to 6000 and admit themselves.
begin "the median comes from the committed rows, so new dense files cannot raise their own bar"
fixture new-cannot-lift
bootstrap
for n in 1 2 3 4 5; do
  must srcfile "$DIR/packages/shared/src/dense$n.ts" 6 4
done
run_check
expect_rc 1
expect_stderr "repo median 40.00% (4000)"
expect_stderr "ERROR packages/shared/src/dense5.ts"
end

# An even row count has no middle, and the choice is the stricter one. Pinned because a
# future reader would otherwise have to re-derive it from the arithmetic.
begin "an even number of baseline rows takes the LOWER middle as the median"
fixture median-even
must srcfile "$DIR/packages/shared/src/d.ts" 8 2
bootstrap
must srcfile "$DIR/packages/shared/src/new.ts" 5 5
run_check
expect_rc 1
expect_stderr "repo median 40.00% (4000)"
end

# Every other fixture ratio has four digits, where a text sort and a numeric sort agree. Rows
# of mixed width are what tell them apart: as text, 900 sorts after 6000 and the median
# becomes 6000 instead of 2000.
begin "the median sorts numerically, not as text"
DIR="$TMP_ROOT/median-width"
must rm -rf "$DIR"
must mkdir -p "$DIR/.claude"
must srcfile "$DIR/packages/shared/src/a.ts" 9 91
must srcfile "$DIR/packages/shared/src/b.ts" 2 8
must srcfile "$DIR/apps/web/src/c.ts" 6 4
bootstrap
must srcfile "$DIR/packages/shared/src/new.ts" 4 6
run_check
expect_rc 1
expect_stderr "repo median 20.00% (2000)"
end

# ==========================================================================================
# 7. scope: what the gate does and does not read
# ==========================================================================================

begin "test, type-test and spec files are out of scope however dense they are"
fixture scope-tests
bootstrap
must srcfile "$DIR/packages/shared/src/a.test.ts" 9 1
must srcfile "$DIR/packages/shared/src/a.test-d.ts" 9 1
must srcfile "$DIR/apps/web/src/c.spec.tsx" 9 1
run_check
expect_rc 0
expect_stdout "3 file(s) at or below baseline"
end

begin "node_modules, dist and coverage are pruned"
fixture scope-pruned
bootstrap
must srcfile "$DIR/packages/shared/src/node_modules/dep/index.ts" 9 1
must srcfile "$DIR/packages/shared/src/dist/bundle.ts" 9 1
must srcfile "$DIR/apps/web/src/coverage/report.ts" 9 1
run_check
expect_rc 0
expect_stdout "3 file(s) at or below baseline"
end

begin "a .tsx file is in scope alongside .ts"
fixture scope-tsx
must srcfile "$DIR/apps/web/src/Panel.tsx" 3 7
bootstrap
must printf '// one more line of prose\n' >>"$DIR/apps/web/src/Panel.tsx"
run_check
expect_rc 1
expect_stderr "ERROR apps/web/src/Panel.tsx"
end

# Green by absence is what a path-based gate dies of: pointed at a tree whose layout moved,
# "nothing to check" must not read as "fine".
begin "a tree with no apps/*/src or packages/*/src is no verdict, not a pass"
DIR="$TMP_ROOT/scope-no-src"
must rm -rf "$DIR"
must mkdir -p "$DIR/.claude" "$DIR/packages/shared/lib"
must srcfile "$DIR/packages/shared/lib/a.ts" 4 6
run_check
expect_rc 2
expect_stderr "no apps/*/src directory"
expect_not_stdout "check-comment-density: OK"
end

begin "src directories holding no ts or tsx file is no verdict either"
DIR="$TMP_ROOT/scope-empty-src"
must rm -rf "$DIR"
must mkdir -p "$DIR/.claude" "$DIR/packages/shared/src"
must printf 'body { color: red; }\n' >"$DIR/packages/shared/src/style.css"
run_check
expect_rc 2
expect_stderr "the filter is broken, not the repo"
end

# ==========================================================================================
# 8. a baseline nobody can parse is refused, never partly believed
# ==========================================================================================

malformed() { # malformed <row> — a baseline holding one valid row and that one
  fixture "malformed-$1"
  bootstrap
  must printf '%s\n' "$1" >>"$DIR/$BASELINE_REL"
  run_check
  expect_rc 2
  expect_stderr "is malformed"
}

begin "a row with the wrong field count is refused"
malformed "packages/shared/src/a.ts"
expect_stderr "field(s), expected 2"
end

begin "a row whose ratio is not a number is refused"
malformed "$(printf 'packages/shared/src/z.ts\tsixty percent')"
expect_stderr "not a ratio in 0-10000 basis points"
end

begin "a row whose ratio exceeds the scale is refused"
malformed "$(printf 'packages/shared/src/z.ts\t10001')"
expect_stderr "not a ratio in 0-10000 basis points"
end

begin "a path appearing twice is refused — two rows cannot both bound one file"
malformed "$(printf 'packages/shared/src/a.ts\t9999')"
expect_stderr "repeats a path already in the baseline"
end

# ==========================================================================================
# 9. the invocation itself
# ==========================================================================================

begin "an unknown option exits 2"
fixture args
capture bash "$CHECK" --ratchett "$DIR"
expect_rc 2
expect_stderr "unknown option --ratchett"
end

begin "a second directory argument exits 2"
fixture args-two
capture bash "$CHECK" "$DIR" "$DIR"
expect_rc 2
expect_stderr "expected at most one directory"
end

begin "a nonexistent root exits 2, and measures nothing"
capture bash "$CHECK" "$TMP_ROOT/not-a-directory"
expect_rc 2
expect_stderr "not a directory"
expect_not_stdout "check-comment-density: OK"
end

begin "--help exits 0 and runs no gate"
capture bash "$CHECK" --help
expect_rc 0
expect_stdout "Usage: bash .claude/scripts/check-comment-density.sh"
expect_not_stdout "check-comment-density: OK"
end

finish
