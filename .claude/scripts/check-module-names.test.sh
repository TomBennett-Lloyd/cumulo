#!/usr/bin/env bash
# Test harness for check-module-names.sh, its neighbour in this directory.
#
# No test framework, no network, no pnpm: the assertion vocabulary is harness-lib.sh
# next door, sourced below and shared with every sibling harness. Every fixture is a
# throwaway repo-shaped tree under the temp tree `harness_init_tmp` makes and a trap
# deletes on exit, so the offending cases — a bare utils.ts, a utils/ directory — are
# exercised for real without ever adding a banned name to this repo.
#
# These cases ARE the gate's negative controls, committed rather than run once by
# hand (testing.md rule 4): a gate whose failure path nobody exercises is
# indistinguishable from a gate that cannot fail, and this one's whole job is to
# fail on a name that is trivially easy to reintroduce.
#
# One case deliberately runs the gate with NO argument, against the real repo:
# every other case pins REPO_ROOT to a fixture, so without it the shipped default
# path could be broken and the suite would still be green (testing.md rule 7).
#
# Usage: bash .claude/scripts/check-module-names.test.sh   (or `pnpm test:scripts`)
# Exit:  0 every case PASS, 1 at least one FAIL, 2 the harness itself broke.
set -uo pipefail

SCRIPTS=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd) || exit 2
CHECK="$SCRIPTS/check-module-names.sh"

# shellcheck source=./harness-lib.sh
. "$SCRIPTS/harness-lib.sh"
harness_init_tmp

# --- fixtures ----------------------------------------------------------------------------

# fixture <name> -> sets DIR to a fresh, *clean* repo-shaped tree: a packages/ and an
# apps/ with properly named modules in them. Each case then adds exactly one banned
# name, so a failure names its own cause.
fixture() {
  DIR="$TMP_ROOT/$1"
  must mkdir -p "$DIR/packages/shared/src" "$DIR/apps/web/src"
  must module "$DIR/packages/shared/src/site.ts"
  must module "$DIR/apps/web/src/App.tsx"
}

module() { # module <path>
  mkdir -p "$(dirname "$1")" && printf 'export const noop = () => undefined;\n' >"$1"
}

run_check_with() { # run_check_with <bash> <args...>
  local interpreter="$1"
  shift
  capture "$interpreter" "$CHECK" "$@"
}

run_check() { # run_check <args...>
  run_check_with bash "$@"
}

# ==========================================================================================
# 1. the gate parses
# ==========================================================================================
begin "check-module-names.sh parses (bash -n)"
expect_parses "$CHECK"
end

# ==========================================================================================
# 2. the real repo, via the shipped default path (no argument)
# ==========================================================================================
# The production configuration: no REPO_ROOT override, so this is the only case that can
# catch a broken default path — and it is what `pnpm verify` actually runs. It also runs
# under every bash on the box, because the real tree is the biggest array this gate builds.
begin "the repo's own packages/ and apps/ pass with no argument"
for interpreter in $BASHES; do
  case_ctx="$interpreter"
  run_check_with "$interpreter"
  expect_rc 0 "$rc"
  expect_out "check-module-names: OK"
  expect_not_out "unbound variable"
done
case_ctx=""
end

# ==========================================================================================
# 3. a clean fixture passes
# ==========================================================================================
begin "a tree with no banned names passes"
fixture clean
run_check "$DIR"
expect_rc 0 "$rc"
expect_out "OK"
expect_not_out "ERROR"
end

# ==========================================================================================
# 4. ACCEPTANCE (a): a bare utils.ts file
# ==========================================================================================
begin "a bare utils.ts fails the gate"
fixture utils_file
must module "$DIR/packages/shared/src/utils.ts"
run_check "$DIR"
expect_rc 1 "$rc"
expect_out "ERROR packages/shared/src/utils.ts"
expect_out "1 banned module name(s)"
end

# ==========================================================================================
# 5. ACCEPTANCE (b): a utils/ directory
# ==========================================================================================
# The directory form is the one architecture.md rule 5 has always banned in prose, and it is
# the form that survives a rename of the file inside it.
begin "a utils/ directory fails the gate"
fixture utils_dir
must mkdir -p "$DIR/packages/shared/src/utils"
must module "$DIR/packages/shared/src/utils/format.ts"
run_check "$DIR"
expect_rc 1 "$rc"
expect_out "ERROR packages/shared/src/utils"
end

# ==========================================================================================
# 6. every banned extension, not just .ts
# ==========================================================================================
# The extension list is generated in the gate; a case that only ever tried .ts would leave
# the generation untested and let a typo in the list ship as a silent hole.
begin "utils.{ts,tsx,mts,cts,js,mjs} are all banned"
for ext in ts tsx mts cts js mjs; do
  case_ctx="utils.$ext"
  fixture "ext_$ext"
  must module "$DIR/apps/web/src/utils.$ext"
  run_check "$DIR"
  expect_rc 1 "$rc"
  expect_out "ERROR apps/web/src/utils.$ext"
done
case_ctx=""
end

# ==========================================================================================
# 7. the ban is on the bare name, not the substring
# ==========================================================================================
# A gate that also rejected date-utils.ts would be reaching past the rule it enforces, and
# a gate that over-reaches gets itself suppressed. These names say what they are: they pass.
begin "names that merely contain 'utils' are not banned"
fixture near_miss
must module "$DIR/packages/shared/src/date-utils.ts"
must module "$DIR/packages/shared/src/utils-of-measure.ts"
must mkdir -p "$DIR/packages/shared/src/site-utils"
must module "$DIR/packages/shared/src/site-utils/parse.ts"
run_check "$DIR"
expect_rc 0 "$rc"
expect_not_out "ERROR"
end

# ==========================================================================================
# 8. an unrelated extension is not a module
# ==========================================================================================
begin "utils.md and utils.css are not banned module names"
fixture other_ext
must module "$DIR/packages/shared/src/utils.md"
must module "$DIR/packages/ui/src/utils.css"
run_check "$DIR"
expect_rc 0 "$rc"
expect_not_out "ERROR"
end

# ==========================================================================================
# 9. build output and vendored code are pruned
# ==========================================================================================
# Every package builds into dist/, and a dist/ mirror of a source tree would double-report
# each real offender — but worse, a vendored node_modules/…/utils.js would fail the build
# over a naming decision nobody here made.
begin "node_modules, dist and coverage are not searched"
fixture pruned
must module "$DIR/packages/shared/node_modules/dep/utils.js"
must module "$DIR/packages/shared/dist/utils.js"
must module "$DIR/packages/shared/coverage/utils.js"
must mkdir -p "$DIR/apps/web/node_modules/dep/utils"
must module "$DIR/apps/web/node_modules/dep/utils/index.js"
run_check "$DIR"
expect_rc 0 "$rc"
expect_not_out "ERROR"
end

# ==========================================================================================
# 10. both source trees are searched, not just the first
# ==========================================================================================
# The search-dir loop is easy to write so that it silently stops at packages/. Two offenders
# in two trees, one run: both must be named.
begin "offenders under packages/ and apps/ are both reported"
fixture both_trees
must module "$DIR/packages/shared/src/utils.ts"
must module "$DIR/apps/web/src/utils.ts"
run_check "$DIR"
expect_rc 1 "$rc"
expect_out "ERROR packages/shared/src/utils.ts"
expect_out "ERROR apps/web/src/utils.ts"
expect_out "2 banned module name(s)"
end

# ==========================================================================================
# 11. a tree with the right directories but no modules at all
# ==========================================================================================
# Green-by-absence, reached through a filter bug rather than a path bug: if the extension
# list stopped matching anything, "no offenders" and "nothing looked at" are the same
# output, and this gate must be able to tell them apart.
begin "source dirs containing no modules exit 2, not 0"
fixture no_modules
must rm "$DIR/packages/shared/src/site.ts" "$DIR/apps/web/src/App.tsx"
for interpreter in $BASHES; do
  case_ctx="$interpreter"
  run_check_with "$interpreter" "$DIR"
  expect_rc 2 "$rc"
  expect_out "the filter is broken, not the repo"
  expect_not_out "unbound variable"
done
case_ctx=""
end

# ==========================================================================================
# 12. a tree with neither packages/ nor apps/
# ==========================================================================================
# The wrong-directory case: point the gate at a moved or renamed tree and "nothing to
# check" must not read as "fine".
begin "a root with neither packages/ nor apps/ exits 2"
DIR="$TMP_ROOT/no_source_dirs"
must mkdir -p "$DIR/docs"
for interpreter in $BASHES; do
  case_ctx="$interpreter"
  run_check_with "$interpreter" "$DIR"
  expect_rc 2 "$rc"
  expect_out "none of these exist under"
  # Not academic: this is the path where search_dirs is empty, which is precisely where
  # bash 3.2 under `set -u` aborts on an array expansion 4.4+ tolerates.
  expect_not_out "unbound variable"
done
case_ctx=""
end

# ==========================================================================================
# 13. a root that is not there at all
# ==========================================================================================
begin "a nonexistent root exits 2, not 1"
run_check "$TMP_ROOT/does-not-exist"
expect_rc 2 "$rc"
expect_out "not a directory"
end

# ==========================================================================================
# 14. a partial discovery (unreadable subdirectory) exits 2, not a subset reported as OK
# ==========================================================================================
# The census and the ban are both `find`, and a `find` that cannot descend into one
# subdirectory exits non-zero while still listing everything it reached. Unrefused, that
# partial listing becomes "OK — no bare utils modules (N modules scanned)": a verdict over
# a tree the gate never finished reading, with the banned name that sits behind the
# unreadable directory unreported. The gate's two `if ! find` guards are what refuse it,
# and this is the case that exercises them (modelled on run-script-tests.test.sh's
# ratified reproduction of the same shape, #84).
#
# There is no way to fake this: the condition IS a filesystem permission. Under a root uid,
# chmod 000 restricts nothing and the case cannot be created — so it fails loudly rather
# than passing on a path it never exercised.
begin "a partial discovery (unreadable subdirectory) exits 2, not a subset reported as OK"
fixture unreadable_dir
must mkdir -p "$DIR/apps/locked"
must chmod 000 "$DIR/apps/locked"
if find "$DIR/apps" -type f -name '*.ts' >/dev/null 2>&1; then
  bad "could not make a directory unreadable (running as root?) — the partial-discovery path was NOT exercised"
else
  run_check "$DIR"
  expect_rc 2 "$rc"
  expect_out "find failed while scanning"
  expect_not_out "OK"
fi
# Restored unconditionally: the trap's `rm -rf` cannot remove a directory it cannot enter.
must chmod 755 "$DIR/apps/locked"
end

# ==========================================================================================

finish
