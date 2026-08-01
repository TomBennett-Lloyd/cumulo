#!/usr/bin/env bash
# Test harness for check-web-bundle.sh, its neighbour in this directory.
#
# Self-contained on purpose (same shape as check-module-names.test.sh next door):
# no test framework, no network, no pnpm, and — the point of the fixture design —
# no `vite build`. Every case runs the gate against a throwaway repo-shaped tree
# under a single `mktemp -d` that a trap deletes on exit, with the "entry chunk"
# a file of the exact size the case needs, so the failure paths are exercised for
# real in milliseconds.
#
# These cases ARE the gate's negative controls, committed rather than run once by
# hand (testing.md rule 4): a size budget that passes because it silently
# measured nothing looks identical to one that passes because the bundle is
# small. The boundary cases (exactly the budget, one byte over), the vacuity
# cases (a marker that no longer exists in the gallery source) and the
# stale-artefact case are all there to make those two outcomes distinguishable.
#
# The fixtures are sized from the gate's own `--print-budget` rather than from a
# restated constant: a second copy of the budget in this file would drift the
# moment the real one is deliberately reset, and would drift silently in the
# direction that keeps the harness green.
#
# One case deliberately runs the gate with NO argument, against the real repo:
# every other case pins REPO_ROOT to a fixture, so without it the shipped default
# path could be broken and the suite would still be green (testing.md rule 7).
#
# Usage: bash .claude/scripts/check-web-bundle.test.sh   (or `pnpm test:scripts`)
# Exit:  0 every case PASS, 1 at least one FAIL, 2 the harness itself broke.
set -uo pipefail

SCRIPTS=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd) || exit 2
CHECK="$SCRIPTS/check-web-bundle.sh"

tmp_raw=$(mktemp -d) || exit 2
trap 'rm -rf "$tmp_raw"' EXIT INT TERM
TMP_ROOT=$(cd "$tmp_raw" && pwd -P) || exit 2

passed=0
failed=0
case_name=""
case_failed=0
case_ctx=""
out=""
rc=0
budget=0

# The gate has to survive the oldest bash it can meet, and the interpreter is not a
# detail: under `set -u`, bash 3.2 (which macOS ships as /bin/bash) aborts where 4.4+
# shrugs. The array-building in this gate is exactly that kind of code, so the cases
# that exercise it run under every distinct bash on the box.
BASHES="bash"
if [ -x /bin/bash ] && [ "$(command -v bash)" != "/bin/bash" ]; then
  BASHES="$BASHES /bin/bash"
fi

# --- harness plumbing --------------------------------------------------------------------

must() {
  "$@" || {
    printf 'FATAL harness setup failed: %s\n' "$*" >&2
    exit 2
  }
}

begin() {
  case_name="$1"
  case_failed=0
  case_ctx=""
}

end() {
  if [ "$case_failed" = "0" ]; then
    printf 'PASS %s\n' "$case_name"
    passed=$((passed + 1))
  else
    printf 'FAIL %s\n' "$case_name"
    failed=$((failed + 1))
  fi
}

# case_ctx names the variant a failure came from, for cases that run the gate more than once.
bad() {
  printf '  ! %s%s\n' "$1" "${case_ctx:+ (under $case_ctx)}" >&2
  case_failed=1
}

expect_rc() { # expect_rc <expected> <actual>
  [ "$1" = "$2" ] || bad "exit code: expected $1, got $2"
}

expect_out() { # expect_out <substring>
  case "$out" in
    *"$1"*) ;;
    *) bad "output missing '$1'; got: $out" ;;
  esac
}

expect_not_out() { # expect_not_out <substring>
  case "$out" in
    *"$1"*) bad "output should not contain '$1'; got: $out" ;;
  esac
}

# --- fixtures ----------------------------------------------------------------------------

sized_file() { # sized_file <path> <bytes>
  mkdir -p "$(dirname "$1")" && head -c "$2" /dev/zero >"$1"
}

text_file() { # text_file <path> <contents>
  mkdir -p "$(dirname "$1")" && printf '%s\n' "$2" >"$1"
}

# fixture <name> [entry_bytes] -> sets DIR to a fresh, *clean* repo-shaped tree that the
# gate passes: one entry chunk under the budget, both gallery markers present in
# src/preview/, the gallery's own document at the app root, and nothing of the gallery in
# dist/. Each case then breaks exactly one of those properties, so a failure names its own
# cause. entry_bytes defaults to one byte under the budget.
fixture() {
  DIR="$TMP_ROOT/$1"
  entry_bytes=${2:-$((budget - 1))}
  must mkdir -p "$DIR/apps/web/dist/assets" "$DIR/apps/web/src/preview"
  must sized_file "$DIR/apps/web/dist/assets/index-abc123.js" "$entry_bytes"
  must text_file "$DIR/apps/web/dist/assets/index-abc123.css" '.map-view{display:block}'
  must text_file "$DIR/apps/web/dist/index.html" '<script src="/assets/index-abc123.js"></script>'
  must text_file "$DIR/apps/web/src/preview/preview.css" '.swatch-chip {'
  must text_file "$DIR/apps/web/src/preview/TokensPreview.tsx" 'const heading = "Direction B";'
  must text_file "$DIR/apps/web/tokens.html" '<script type="module" src="/src/preview/main.tsx"></script>'
}

run_check_with() { # run_check_with <bash> <args...>
  local interpreter="$1"
  shift
  out=$("$interpreter" "$CHECK" "$@" 2>&1)
  rc=$?
}

run_check() { # run_check <args...>
  run_check_with bash "$@"
}

# ==========================================================================================
# 1. the gate parses
# ==========================================================================================
begin "check-web-bundle.sh parses (bash -n)"
for interpreter in $BASHES; do
  case_ctx="$interpreter"
  if ! syntax=$("$interpreter" -n "$CHECK" 2>&1); then
    bad "check-web-bundle.sh failed -n: $syntax"
  fi
done
case_ctx=""
end

# ==========================================================================================
# 2. --print-budget, which every sizing case below depends on
# ==========================================================================================
begin "--print-budget prints a positive integer and exits 0"
run_check --print-budget
expect_rc 0 "$rc"
budget="$out"
case "$budget" in
  '' | *[!0-9]*) bad "expected a bare integer, got: $budget" ;;
  *) [ "$budget" -gt 0 ] || bad "expected a positive budget, got: $budget" ;;
esac
end

# Not a case: the sizing fixtures below are meaningless without a usable number, and a
# cascade of confusing failures is worse than one honest stop.
case "$budget" in
  '' | *[!0-9]*)
    printf 'FATAL harness cannot size fixtures: --print-budget gave "%s"\n' "$budget" >&2
    exit 2
    ;;
esac

# ==========================================================================================
# 3. a clean build passes
# ==========================================================================================
begin "a build under budget with the gallery contained passes"
fixture clean
run_check "$DIR"
expect_rc 0 "$rc"
expect_out "check-web-bundle: OK"
expect_out "$((budget - 1))"
expect_not_out "ERROR"
end

# ==========================================================================================
# 4. ACCEPTANCE: the budget boundary, from both sides
# ==========================================================================================
# The negative control for the whole gate. One byte apart, opposite verdicts: a budget that
# cannot fail and a budget that fires on anything both pass the "clean fixture" case above,
# and only this pair tells them apart. The comparison is `>` budget, so exactly the budget
# is inside it.
begin "exactly the budget passes, one byte over fails"
case_ctx="entry == budget"
fixture at_budget "$budget"
run_check "$DIR"
expect_rc 0 "$rc"
expect_out "check-web-bundle: OK"

case_ctx="entry == budget + 1"
fixture over_budget "$((budget + 1))"
run_check "$DIR"
expect_rc 1 "$rc"
expect_out "over budget"
expect_out "$((budget + 1))"
expect_out "$budget"
case_ctx=""
end

# ==========================================================================================
# 5. a gross overage says what to do about it
# ==========================================================================================
# The message is the deliverable here: whoever trips this needs to know that the number is
# reset with a fresh measurement in the same PR, and only when the growth was deliberate.
begin "a grossly over-budget entry fails with the remediation guidance"
fixture way_over "$((budget * 2))"
run_check "$DIR"
expect_rc 1 "$rc"
expect_out "ENTRY_BUDGET_BYTES"
expect_out "deliberate"
expect_out "over by $budget bytes"
end

# ==========================================================================================
# 6. no build is no verdict
# ==========================================================================================
# Exit 2, never 0: this gate's input is build output, and "there is nothing to measure" must
# never read as "the bundle is fine". Both shapes of it — no dist at all, and a dist whose
# entry chunk is missing — take the same path.
begin "a missing build exits 2 and names the build command"
case_ctx="no dist/ at all"
fixture no_dist
must rm -rf "$DIR/apps/web/dist"
run_check "$DIR"
expect_rc 2 "$rc"
expect_out "no build to check"
expect_out "pnpm --filter @cumulo/web build"

case_ctx="dist/assets with no index-*.js"
fixture no_entry
must rm "$DIR/apps/web/dist/assets/index-abc123.js"
run_check "$DIR"
expect_rc 2 "$rc"
expect_out "no build to check"
case_ctx=""
end

# ==========================================================================================
# 7. two entry chunks is no verdict either
# ==========================================================================================
# A local dist that was never cleaned accumulates one index-<hash>.js per build. Measuring
# whichever one the glob happens to yield first is a verdict about a file nobody ships, and
# it is the reading that silently passes: the older, smaller chunk is the likely winner.
begin "two index-*.js files exit 2 as stale artefacts"
fixture stale
must sized_file "$DIR/apps/web/dist/assets/index-def456.js" "$((budget + 1))"
run_check "$DIR"
expect_rc 2 "$rc"
expect_out "stale artefacts"
expect_out "index-abc123.js"
expect_out "index-def456.js"
expect_out "rm -rf apps/web/dist"
end

# ==========================================================================================
# 8. the harness document: in dist/ is a failure, missing entirely is no verdict
# ==========================================================================================
# tokens.html reaching dist/ means the gallery was promoted into the build input, which
# ships the whole swatch grid. Its absence from the app root means the opposite kind of
# problem — the thing being guarded is gone, so the guard proves nothing.
begin "tokens.html in dist fails; tokens.html missing from the app root exits 2"
case_ctx="emitted into dist/"
fixture tokens_shipped
must text_file "$DIR/apps/web/dist/tokens.html" '<script src="/assets/tokens-abc123.js"></script>'
run_check "$DIR"
expect_rc 1 "$rc"
expect_out "apps/web/dist/tokens.html"

case_ctx="missing from the app root"
fixture tokens_gone
must rm "$DIR/apps/web/tokens.html"
run_check "$DIR"
expect_rc 2 "$rc"
expect_out "tokens.html"
expect_out "Update the markers in this script"
case_ctx=""
end

# ==========================================================================================
# 9. ACCEPTANCE: a gallery marker anywhere in dist/ fails, naming the file
# ==========================================================================================
# The two markers came from #149 and cover the two shapes the regression takes: a stray
# `import './preview/preview.css'` lands the class in a stylesheet, a value import of
# TokensPreview lands the palette prose in a script. Each is planted in the file type it
# would really arrive in.
begin "a planted gallery marker in dist fails, naming the offending file"
case_ctx="swatch-chip in a dist stylesheet"
fixture marker_css
must text_file "$DIR/apps/web/dist/assets/index-abc123.css" '.map-view{display:block}.swatch-chip{padding:0}'
run_check "$DIR"
expect_rc 1 "$rc"
expect_out "apps/web/dist/assets/index-abc123.css"
expect_out "swatch-chip"

case_ctx="Direction B in a dist script"
fixture marker_js
must text_file "$DIR/apps/web/dist/assets/palette-xyz789.js" 'const h="Direction B";'
run_check "$DIR"
expect_rc 1 "$rc"
expect_out "apps/web/dist/assets/palette-xyz789.js"
expect_out "Direction B"
case_ctx=""
end

# ==========================================================================================
# 10. a marker that no longer exists in the gallery source is no verdict
# ==========================================================================================
# The vacuity control, and the reason case 9 can be believed. The markers were chosen by
# elimination and can rot: rename the class or reword the prose and the containment scan
# becomes a grep for a string nothing emits, green forever while measuring nothing. That
# must be distinguishable from a genuinely contained gallery — hence 2, not 0.
begin "a marker missing from src/preview exits 2, not 0"
for marker_file in preview.css TokensPreview.tsx; do
  case_ctx="$marker_file rewritten without its marker"
  fixture "vacuous_${marker_file%%.*}"
  must text_file "$DIR/apps/web/src/preview/$marker_file" 'const renamed = true;'
  run_check "$DIR"
  expect_rc 2 "$rc"
  expect_out "no longer appears in non-test source under apps/web/src/preview"
  expect_out "Update the markers in this script"
  expect_not_out "check-web-bundle: OK"
done
case_ctx=""
end

# ==========================================================================================
# 11. a marker surviving only in a test file is no verdict either
# ==========================================================================================
# The loophole the census had in review: src/preview/ really does contain a test file that
# quotes both markers in prose — tokens-harness-contract.test.ts documents this gate's
# assertions verbatim. A census over the whole directory is satisfied by that comment alone,
# so renaming the class and rewording the palette heading left the gate green while the
# containment scan below had become a grep for strings nothing emits. Case 10 cannot see
# this: it deletes the markers from the whole tree. Only a file that could actually put a
# marker into dist/ may vouch for one.
begin "markers surviving only in a *.test.ts under src/preview exit 2, not 0"
fixture markers_only_in_test
must text_file "$DIR/apps/web/src/preview/preview.css" '.renamed-chip {'
must text_file "$DIR/apps/web/src/preview/TokensPreview.tsx" 'const heading = "Direction C";'
must text_file "$DIR/apps/web/src/preview/tokens-harness-contract.test.ts" \
  '// asserts: ! grep -rq "swatch-chip" dist && ! grep -rq "Direction B" dist'
run_check "$DIR"
expect_rc 2 "$rc"
expect_out "no longer appears in non-test source under apps/web/src/preview"
expect_not_out "check-web-bundle: OK"
end

# ==========================================================================================
# 12. argument errors reach a verdict of "no verdict"
# ==========================================================================================
# A bad invocation must never read as a passing bundle. The second-argument case runs
# against a tree the gate would otherwise pass, so its 2 is the parser refusing; the
# unknown-option case never resolves a root at all, so its discriminator is the
# "unknown option" message assertion, not the tree; the nonexistent-root case is the
# resolver itself refusing.
begin "a nonexistent root exits 2, not 1"
run_check "$TMP_ROOT/does-not-exist"
expect_rc 2 "$rc"
expect_out "not a directory"
end

begin "an unknown option exits 2"
run_check --nope
expect_rc 2 "$rc"
expect_out "unknown option"
expect_not_out "check-web-bundle: OK"
end

begin "a second REPO_ROOT argument exits 2"
fixture two_roots
run_check "$DIR" "$DIR"
expect_rc 2 "$rc"
expect_out "expected at most one REPO_ROOT"
expect_not_out "check-web-bundle: OK"
end

# ==========================================================================================
# 13. the shipped default path (no argument), against the real repo
# ==========================================================================================
# Every case above pins REPO_ROOT to a fixture, so without this one the default path could
# be broken and the suite would still be green (testing.md rule 7).
#
# It accepts 0 OR 2, which is weaker than check-module-names' equivalent case and is the
# honest contract for a gate whose input is build output: dist/ is gitignored and is
# legitimately absent whenever `pnpm test:scripts` runs before a build — which is exactly
# what the CI `checks` job does. Pinning this to 0 would make the suite fail on a clean
# checkout; pinning it to 2 would make it fail for any developer who has built. What it
# does prove is that the default root resolves to this repo (the output names
# apps/web/dist either way) and that no array expansion aborts under bash 3.2's `set -u`.
# 1 is refused: that would be a real assertion failure, not an absent build.
begin "the repo's own tree passes or reports no build, with no argument"
for interpreter in $BASHES; do
  case_ctx="$interpreter"
  run_check_with "$interpreter"
  case "$rc" in
    0 | 2) ;;
    *) bad "expected 0 (assertions hold) or 2 (no build to check), got $rc" ;;
  esac
  expect_out "apps/web/dist"
  expect_not_out "unbound variable"
done
case_ctx=""
end

# ==========================================================================================

printf '\n%d passed, %d failed\n' "$passed" "$failed"
[ "$failed" = "0" ] || exit 1
