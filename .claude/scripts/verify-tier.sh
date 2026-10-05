#!/usr/bin/env bash
#
# The tier classifier behind `pnpm verify` (#476, #477).
#
# `verify` used to be one composite, run whole before every commit, and most
# change sets cannot be observed by most of it. This script asks one question per
# rung — can a gate see this change at all? — and runs the answer:
#
#   every changed path matches \.md$              ->  docs tier
#   every changed path is .md or a source file
#     whose minified emit is unchanged            ->  source-prose tier
#   anything else                                 ->  `pnpm verify:full`
#
# The tier is DERIVED, never chosen. That distinction is the whole design:
# CLAUDE.md bans hand-picking legs because a human picking "the relevant ones"
# is how a gate stops running, and a flag like `--docs` would be exactly that
# ban with a nicer spelling. Nobody is asked what changed; git and esbuild are.
#
# FAIL CLOSED, everywhere. An empty change set, a git command that fails, a fetch
# that cannot reach the remote, a path no rung can classify, a proof that cannot
# be run — every one of them runs the full composite. A rung is reached only by a
# positive answer to its own question, so the failure direction is always "ran
# too much", never "ran too little". Offline is therefore not a regression: it is
# today's behaviour.
#
# CI is deliberately NOT tiered: .github/workflows/ci.yml calls `verify:full`
# explicitly. The saving here is on the local iteration loop, where the composite
# is paid several times per PR; widening it to CI is a separate decision with its
# own evidence, and until then CI's coverage is unchanged by this script.
#
# ---------------------------------------------------------------------------
# RUNG 1 — docs (#476)
#
# For a markdown-only change set only four legs can observe the change:
# verify:root, check:adr-index, check:markdown-links, format:check. The rest are
# never given a .md file at all, or read manifests, Terraform and TypeScript.
#
# THE SOUNDNESS GUARD, and where it differs from #476's wording. The rung rests
# on a claim — "no test can observe this markdown" — and a claim nobody checks is
# an assumption. #476 asked for a blanket grep: any \.md reference anywhere in
# the test trees forces full. That form is not implementable here, and the reason
# is worth stating rather than discovering again. check-adr-index.test.sh and
# check-markdown-links.test.sh build markdown FIXTURES by the dozen, so the
# blanket grep returns hundreds of hits on a clean tree and would pin every run
# on the full tier forever.
#
# So the guard is scoped to the change set, which is the sharper question in any
# case: could a test observe THESE files? Any hit is printed with file and line,
# and forces the full tier. The basename arm is what catches a path assembled at
# run time — join(root, 'docs', 'x.md') contains no repo-relative path but does
# contain the basename — and it costs false positives on prose that merely names
# a file ("testing.md rule 7"). Those cost a full run, the direction this script
# is allowed to be wrong in.
#
# ---------------------------------------------------------------------------
# RUNG 2 — source-prose (#477)
#
# A comment-only source edit changes no emitted code, and most of the composite
# reads emitted code. The proof is mechanical: esbuild minifies the baseline blob
# and the working file with the extension's loader, and the two outputs are
# compared byte for byte. Identical output means every difference between the two
# sources was a comment or whitespace.
#
# THE BASELINE IS THE MERGE-BASE, not HEAD, and this is load-bearing. The change
# set below spans merge-base...HEAD as well as the worktree, so a file whose code
# change was COMMITTED on this branch is byte-identical between HEAD and the
# worktree — a HEAD baseline would prove that file comment-only and skip the very
# tests that catch it. One baseline for the whole change set, and it is the one
# the change set is derived from.
#
# --legal-comments=none is mandatory, and not for tidiness: esbuild's default
# outside bundling is to preserve legal comments (/*! … */, //! …) in place, so a
# file carrying a licence header would never minify identically and the rung
# would be unreachable for it. Stripping them makes the proof cover every comment
# in the file. The residual, stated because the tier line does not say it: an
# edit to a licence header is proven comment-only here, which is right about
# behaviour and would be wrong for a licence audit. Nothing in `verify` performs
# one.
#
# IDENTIFIER MINIFICATION IS OFF (--minify-whitespace --minify-syntax, never
# --minify). esbuild names mangled bindings from a character-frequency histogram
# of the whole source text, comments included, so rewriting a docblock can
# permute which letter each binding gets and two behaviourally identical files
# emit differently — #480 caught exactly that on a comment-only batch. Whitespace
# and syntax minification depend on the code alone, which is the property the
# proof needs. A false positive here is safe (it runs the full composite) but is
# documented to the author as "you changed code by accident", so it must not fire
# on prose.
#
# esbuild is a dependency of vite already, and is RESOLVED, never installed —
# $ROOT's node_modules first, then the repository holding this script, which is
# the same directory in production and is what lets verify-tier.test.sh classify
# throwaway fixture repositories that have no node_modules of their own. No
# binary, or a binary that errors on a file, is a full run.
#
# WHAT STILL RUNS UNDER THIS RUNG, because comments are observable:
#
#   * typecheck — pragmas live in comments (@ts-expect-error, /// <reference>),
#     and the emit proof cannot see them. This is the leg the rung exists to keep.
#   * eslint on the changed files — suppression comments are themselves lint
#     errors by CLAUDE.md's policy, and comment-shaped rules exist.
#   * stylelint on the changed .css — the same, for CSS comment rules.
#   * prettier --check on the changed files — comments are formatted like
#     anything else.
#   * check:aws-test-guard — the one check:* gate that greps a .ts file's TEXT
#     (a vitest config, for a fixed token) rather than its shape, and text is
#     what a comment is.
#   * check:adr-index and check:markdown-links, when the set also holds .md.
#   * the observing tests, below.
#
# The legs are emitted in `verify:full`'s own order, so a red under this tier
# stops at the same leg the composite would have stopped at.
#
# Skipped, provably unaffected: every other package's vitest; stylelint when no
# .css changed; the shell harnesses when none is selected; and the check:* gates
# that read code SHAPE — module-names reads filenames, node-types and
# supply-chain-policy read manifests, infra-mirrors reads Terraform. None of them
# can change under an unchanged emit.
#
# THE OBSERVING TESTS, selected mechanically. A test can observe a comment in
# exactly two ways, and each gets an arm: it reads files as data (readFileSync,
# import.meta.glob, fs.*), or it names a changed file. Both arms are greps over
# the test census, so a test added next month is selected by what it does rather
# than by anybody remembering to list it. An empty selection runs no tests, which
# is the honest answer and not a silent one — the tier line prints the set.
#
# *.spec.* files are scanned but never selected to RUN. docs/standards/testing.md
# rule 10 splits the lanes by suffix — "*.test.ts colocated is vitest (rule 6),
# e2e/*.spec.ts is the browser lane" — and places that lane "deliberately outside
# `verify`". The composite this tier stands in for does not run a spec, so a tier
# that did would be STRICTER than the thing it replaces, and a spurious red is
# how a gate gets bypassed. They stay in the census for rung 1's guard, which
# forces the full tier rather than running anything.
#
# A selected *.test.sh runs as `bash <harness>` rather than through
# run-script-tests.sh, which discovers a DIRECTORY and has no file-level entry
# point. The exit convention that runner aggregates on is stated by `finish` in
# harness-lib.sh, which every harness ends on, so a directly-run harness reports
# the same verdict.
#
# WHERE THE RUNGS DISAGREE, deliberately. A markdown-only change set whose file a
# test names goes full (rung 1's guard); the same file alongside a comment-only
# source edit reaches rung 2, which runs that test instead of everything. Rung 1
# is #476's and is left as it was: both answers are safe, and the cheaper one is
# not worth reopening a merged decision for.
#
# ---------------------------------------------------------------------------
# Usage: bash .claude/scripts/verify-tier.sh [--dry-run] [REPO_ROOT]
#          REPO_ROOT defaults to the repository holding this script; the argument
#          exists so the harness can point the classifier at throwaway fixtures.
#          --dry-run classifies and prints, and runs no gate.
# Exit:  the delegated tier's exit code (0 pass, non-zero a red gate), or 2 if
#        the invocation itself was wrong.
#
set -uo pipefail
# Homebrew's prefix is not on a non-interactive shell's default PATH on this
# machine (same reason worktree-lib.sh does it). Harmless on Linux, where the
# directory does not exist.
#
# Appended, not prepended: prepending outranks a shellcheck the caller put
# ahead of Homebrew on purpose, which is the escape hatch lint-shell.sh's
# version refusal points at — that file's comment on this same line carries
# the reasoning, and every step of this chain has to agree or the one that
# prepends decides. (#502)
export PATH="$PATH:/opt/homebrew/bin"

SCRIPTS=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd) || exit 2
TOOLROOT=$(git -C "$SCRIPTS" rev-parse --show-toplevel 2>/dev/null) || TOOLROOT=""

# How many of the classified paths are listed before the list is summarised. A
# branch can carry a hundred files since its merge-base and a hundred-line dump
# before every gate is noise; the tier and the count are the load-bearing parts.
LIST_CAP=20

# The data-reading arm of the observing-test selection: a test matching this can
# see a comment without naming the file the comment lives in.
DATA_READING='readFileSync|readFile\(|import\.meta\.glob|fs\.'

dry_run=0
root_arg=""

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run)
      dry_run=1
      ;;
    -h | --help)
      cat <<'EOF'
Usage: bash .claude/scripts/verify-tier.sh [--dry-run] [REPO_ROOT]

  REPO_ROOT   repository to classify (default: the one holding this script)
  --dry-run   classify and print the tier, run no gate

Exit: the delegated tier's exit code, or 2 if the invocation was wrong.
EOF
      exit 0
      ;;
    -*)
      printf 'verify-tier: unknown option %s\n' "$1" >&2
      exit 2
      ;;
    *)
      if [ -n "$root_arg" ]; then
        printf 'verify-tier: expected at most one directory, got a second: %s\n' "$1" >&2
        exit 2
      fi
      root_arg="$1"
      ;;
  esac
  shift
done

if [ -n "$root_arg" ]; then
  if [ ! -d "$root_arg" ]; then
    printf 'verify-tier: not a directory: %s\n' "$root_arg" >&2
    exit 2
  fi
  ROOT=$(cd "$root_arg" && pwd -P) || exit 2
else
  # The script's own directory, not the caller's: `pnpm verify` runs from the
  # workspace root today, but a classifier that silently followed a stale shell
  # cwd into another checkout is the failure the `verify root:` line exists to
  # catch, and this one would pick the tier from the wrong tree's diff.
  ROOT=$(git -C "$SCRIPTS" rev-parse --show-toplevel) || exit 2
fi
# Every later command runs in the repository under classification, so a `cd`
# that failed cannot be mistaken for a grep that found nothing.
cd "$ROOT" || exit 2

TMP=$(mktemp -d "${TMPDIR:-/tmp}/verify-tier.XXXXXX") || exit 2
trap 'rm -rf "$TMP"' EXIT INT TERM

CHANGED="$TMP/changed"
TESTS="$TMP/tests"
PATTERNS="$TMP/patterns"
PROVEN="$TMP/proven"
OBSERVING="$TMP/observing"

# core.quotePath=false keeps non-ASCII paths readable rather than \xNN-escaped.
# A path holding a quote or a newline is still quoted by git, and a quoted path
# matches no extension either rung handles, so it runs the full composite —
# fail-closed, and the reason line shows the quoting.
git_at() {
  git -C "$ROOT" -c core.quotePath=false "$@"
}

reason=""
proof_reason=""
BASE=""
ESBUILD=""

# collect_change_set -> writes the change set to $CHANGED, one path per line, and
# the merge-base it is measured from to $BASE. Returns 1 with $reason set if any
# part of the derivation could not be trusted.
#
# Three sources, because no single git command covers them: what is edited or
# staged against HEAD, what is untracked but not ignored, and what this branch
# has committed since it left origin/main. The fetch is what makes the third one
# honest — a stale refs/remotes/origin/main puts the merge-base too far back,
# which widens the change set, which can only ever move the tier towards full.
collect_change_set() {
  if ! git_at fetch --quiet origin main >/dev/null 2>&1; then
    reason="could not fetch origin main (offline, or no such remote)"
    return 1
  fi
  if ! BASE=$(git_at merge-base HEAD refs/remotes/origin/main 2>/dev/null) || [ -z "$BASE" ]; then
    reason="no merge-base between HEAD and origin/main"
    return 1
  fi
  if ! git_at diff --name-only HEAD >"$TMP/raw" 2>/dev/null; then
    reason="git diff --name-only HEAD failed"
    return 1
  fi
  if ! git_at ls-files --others --exclude-standard >>"$TMP/raw" 2>/dev/null; then
    reason="git ls-files --others failed"
    return 1
  fi
  if ! git_at diff --name-only "$BASE...HEAD" >>"$TMP/raw" 2>/dev/null; then
    reason="git diff --name-only $BASE...HEAD failed"
    return 1
  fi
  if ! LC_ALL=C sort -u "$TMP/raw" >"$TMP/sorted"; then
    reason="could not sort the change set"
    return 1
  fi
  # grep exits 1 when nothing survives, which here means an empty change set —
  # a legitimate state the caller reports on its own terms, not a failure. Hence
  # the explicit `return 0` rather than falling off the end on grep's status.
  grep -v '^$' "$TMP/sorted" >"$CHANGED"
  return 0
}

# census_tests -> writes to $TESTS every *.test.* / *.spec.* path git knows about
# that is present in the working tree. Returns 1 with $reason set otherwise.
#
# An empty census is a broken census, not a clean one — the rule the check:*
# gates apply to their own scans. A repository whose test files cannot be found
# has no evidence to offer about what its tests can see, so it gets no rung at
# all: rung 1 cannot certify the change unobservable, and rung 2 cannot find the
# tests that observe it.
census_tests() {
  local f count=0
  if ! git_at ls-files >"$TMP/allfiles" 2>/dev/null ||
    ! git_at ls-files --others --exclude-standard >>"$TMP/allfiles" 2>/dev/null; then
    reason="could not enumerate the test files to check the change set against"
    return 1
  fi
  grep -E '(\.test\.|\.spec\.)' "$TMP/allfiles" | LC_ALL=C sort -u >"$TMP/tests-all"

  if [ ! -s "$TMP/tests-all" ]; then
    reason="found no test files to check the change set against — an empty scan is not a clean one"
    return 1
  fi

  # ls-files lists paths that are deleted in the working tree too; grep would
  # exit 2 on those and turn a clean scan into an error.
  : >"$TESTS"
  while IFS= read -r f; do
    [ -f "$ROOT/$f" ] || continue
    printf '%s\n' "$f" >>"$TESTS"
    count=$((count + 1))
  done <"$TMP/tests-all"
  if [ "$count" -eq 0 ]; then
    reason="every discovered test file is absent from the working tree"
    return 1
  fi
  return 0
}

# change_set_patterns -> writes to $PATTERNS the fixed strings a test file is
# searched for: every changed path, and every changed basename.
change_set_patterns() {
  local f
  : >"$PATTERNS"
  while IFS= read -r f; do
    printf '%s\n%s\n' "$f" "${f##*/}" >>"$PATTERNS"
  done <"$CHANGED"
}

# guard_hits -> 0 the change set is unobservable by any test, 1 it may not be.
# Writes the offending file:line matches to $TMP/hits when it returns 1.
guard_hits() {
  local f files
  census_tests || return 1
  change_set_patterns

  files=()
  while IFS= read -r f; do
    files+=("$f")
  done <"$TESTS"

  # -F: the patterns are paths, and a path's dots are not wildcards.
  grep -nF -f "$PATTERNS" -- "${files[@]}" >"$TMP/hits" 2>/dev/null
  case $? in
    0)
      reason="a test file references a markdown path in this change set"
      return 1
      ;;
    1)
      return 0
      ;;
    *)
      reason="the guard grep over the test files failed"
      return 1
      ;;
  esac
}

# loader_for <path> -> the esbuild loader for the path's extension, or 1 when the
# emit proof does not handle it. This list is rung 2's whole domain: a path
# outside it is neither markdown nor provable, so it runs the composite.
loader_for() {
  case "$1" in
    *.ts) printf 'ts\n' ;;
    *.tsx) printf 'tsx\n' ;;
    *.js | *.mjs | *.cjs) printf 'js\n' ;;
    *.css) printf 'css\n' ;;
    *) return 1 ;;
  esac
}

# find_esbuild -> the path to an esbuild binary, or 1.
find_esbuild() {
  local d c
  for d in "$ROOT" "$TOOLROOT"; do
    [ -n "$d" ] || continue
    for c in "$d/node_modules/.bin/esbuild" "$d/node_modules/.pnpm/node_modules/.bin/esbuild"; do
      if [ -x "$c" ]; then
        printf '%s\n' "$c"
        return 0
      fi
    done
  done
  return 1
}

# prove_comment_only <path> <loader> -> 0 when the path's minified emit is
# unchanged since $BASE, 1 with $proof_reason set otherwise.
prove_comment_only() {
  local path="$1" loader="$2"
  if ! git_at cat-file -e "$BASE:$path" 2>/dev/null; then
    proof_reason="new since the merge-base, so there is no emit to compare against — $path"
    return 1
  fi
  if [ ! -f "$ROOT/$path" ]; then
    proof_reason="gone from the working tree, which removes its emit entirely — $path"
    return 1
  fi
  if ! git_at show "$BASE:$path" >"$TMP/base.src" 2>/dev/null; then
    proof_reason="could not read the merge-base blob — $path"
    return 1
  fi
  if ! "$ESBUILD" --minify-whitespace --minify-syntax "--loader=$loader" --legal-comments=none \
    <"$TMP/base.src" >"$TMP/base.min" 2>"$TMP/esbuild.err"; then
    proof_reason="esbuild could not minify the merge-base version — $path"
    return 1
  fi
  if ! "$ESBUILD" --minify-whitespace --minify-syntax "--loader=$loader" --legal-comments=none \
    <"$ROOT/$path" >"$TMP/work.min" 2>"$TMP/esbuild.err"; then
    proof_reason="esbuild could not minify the working version — $path"
    return 1
  fi
  if ! cmp -s "$TMP/base.min" "$TMP/work.min"; then
    proof_reason="the minified emit changed — $path"
    return 1
  fi
  return 0
}

proven_count=0

# prove_change_set -> 0 when every non-markdown path in the change set is a
# source file proven comment-only, those paths written to $PROVEN and counted in
# $proven_count. 1 with $reason set otherwise.
prove_change_set() {
  local f loader
  proven_count=0
  : >"$PROVEN"

  if ! ESBUILD=$(find_esbuild); then
    reason="no esbuild binary under node_modules to prove an unchanged emit with"
    return 1
  fi

  while IFS= read -r f; do
    case "$f" in
      *.md) continue ;;
    esac
    if ! loader=$(loader_for "$f"); then
      reason="neither markdown nor a source type the emit proof handles — $f"
      return 1
    fi
    if ! prove_comment_only "$f" "$loader"; then
      reason="$proof_reason"
      return 1
    fi
    printf '%s\n' "$f" >>"$PROVEN"
    proven_count=$((proven_count + 1))
  done <"$CHANGED"
  return 0
}

# select_observing_tests -> writes to $OBSERVING every runnable test file that can
# observe this change set. Returns 1 with $reason set when the selection could not
# be made, which is a full run like any other unanswerable question.
select_observing_tests() {
  local f files grc
  census_tests || return 1
  change_set_patterns
  : >"$OBSERVING"

  grep -v -E '\.spec\.' "$TESTS" >"$TMP/runnable"
  [ -s "$TMP/runnable" ] || return 0

  files=()
  while IFS= read -r f; do
    files+=("$f")
  done <"$TMP/runnable"

  : >"$TMP/observing-raw"
  grep -lE "$DATA_READING" -- "${files[@]}" >>"$TMP/observing-raw" 2>/dev/null
  grc=$?
  if [ "$grc" -gt 1 ]; then
    reason="the data-reading scan over the test files failed"
    return 1
  fi
  # -F: the patterns are paths, and a path's dots are not wildcards.
  grep -lF -f "$PATTERNS" -- "${files[@]}" >>"$TMP/observing-raw" 2>/dev/null
  grc=$?
  if [ "$grc" -gt 1 ]; then
    reason="the basename scan over the test files failed"
    return 1
  fi

  if ! LC_ALL=C sort -u "$TMP/observing-raw" >"$OBSERVING"; then
    reason="could not sort the observing-test selection"
    return 1
  fi
  return 0
}

# owning_package_dir <repo-relative file> -> the nearest ancestor directory
# holding a package.json, which is the workspace member vitest must run from.
# Walked rather than read off pnpm-workspace.yaml: those globs are that file's to
# own (docs/standards/architecture.md rule 9), and a second copy here would go
# stale the day a third top-level directory joins apps/ and packages/.
owning_package_dir() {
  local d="${1%/*}"
  while [ -n "$d" ] && [ "$d" != "." ] && [ "$d" != "$1" ]; do
    if [ -f "$ROOT/$d/package.json" ]; then
      printf '%s\n' "$d"
      return 0
    fi
    case "$d" in
      */*) d="${d%/*}" ;;
      *) d="" ;;
    esac
  done
  return 1
}

legs=""

append_leg() {
  legs="${legs:+$legs && }$1"
}

# append_file_leg <command prefix> <file holding the paths> -> one leg naming
# every path in the list, shell-quoted, or no leg at all when the list is empty.
append_file_leg() {
  local prefix="$1" list="$2" f leg
  [ -s "$list" ] || return 0
  leg="$prefix"
  while IFS= read -r f; do
    leg="$leg $(printf '%q' "$f")"
  done <"$list"
  append_leg "$leg"
}

# build_source_prose_legs -> fills $legs with rung 2's gates, in the order
# `verify:full` runs its own, so a red stops where the composite would have.
build_source_prose_legs() {
  local f ext pkg prev args

  : >"$TMP/lintable"
  : >"$TMP/css"
  : >"$TMP/present"
  while IFS= read -r f; do
    [ -f "$ROOT/$f" ] || continue
    printf '%s\n' "$f" >>"$TMP/present"
    ext="${f##*.}"
    case "$ext" in
      ts | tsx | js | mjs | cjs) printf '%s\n' "$f" >>"$TMP/lintable" ;;
      css) printf '%s\n' "$f" >>"$TMP/css" ;;
    esac
  done <"$CHANGED"

  # --no-warn-ignored: a changed path the flat config ignores is not an error,
  # it is a path eslint has nothing to say about (package.json's lint-staged
  # entry passes the same flag for the same reason).
  append_file_leg "pnpm exec eslint --no-warn-ignored --max-warnings 0 --" "$TMP/lintable"
  append_file_leg "pnpm exec stylelint --max-warnings 0 --" "$TMP/css"
  append_leg "pnpm typecheck"
  append_leg "pnpm check:aws-test-guard"
  if grep -qE '\.md$' "$CHANGED"; then
    append_leg "pnpm check:adr-index"
    append_leg "pnpm check:markdown-links"
  fi

  : >"$TMP/vitest-jobs"
  : >"$TMP/harness-jobs"
  while IFS= read -r f; do
    case "$f" in
      *.test.sh)
        printf '%s\n' "$f" >>"$TMP/harness-jobs"
        continue
        ;;
    esac
    if ! pkg=$(owning_package_dir "$f"); then
      reason="an observing test sits in no workspace package, so nothing knows how to run it — $f"
      return 1
    fi
    printf '%s\t%s\n' "$pkg" "$f" >>"$TMP/vitest-jobs"
  done <"$OBSERVING"

  if ! LC_ALL=C sort -o "$TMP/vitest-jobs" "$TMP/vitest-jobs"; then
    reason="could not group the observing tests by package"
    return 1
  fi

  # One vitest per package, its files named RELATIVE to that package: vitest
  # matches a positional against paths from its own working directory, so a
  # repo-relative path matches nothing and exits 1 with "No test files found".
  prev=""
  args=""
  while IFS=$'\t' read -r pkg f; do
    if [ "$pkg" != "$prev" ]; then
      [ -z "$prev" ] || append_leg "pnpm --filter $(printf '%q' "./$prev") exec vitest run$args"
      prev="$pkg"
      args=""
    fi
    args="$args $(printf '%q' "${f#"$pkg"/}")"
  done <"$TMP/vitest-jobs"
  [ -z "$prev" ] || append_leg "pnpm --filter $(printf '%q' "./$prev") exec vitest run$args"

  while IFS= read -r f; do
    append_leg "bash $(printf '%q' "$f")"
  done <"$TMP/harness-jobs"

  # --ignore-unknown: the same contract as the lint-staged `*` entry — a path
  # prettier has no parser for is skipped, not failed.
  append_file_leg "pnpm exec prettier --check --ignore-unknown --" "$TMP/present"
  return 0
}

print_list() {
  local shown=0 f
  while IFS= read -r f; do
    if [ "$shown" -ge "$LIST_CAP" ]; then
      printf '  … and %d more\n' "$((changed_count - LIST_CAP))"
      break
    fi
    printf '  %s\n' "$f"
    shown=$((shown + 1))
  done <"$CHANGED"
}

# observing_summary -> the selected set on one line, or `none`.
observing_summary() {
  local f shown=0 total line=""
  total=$(grep -c '' <"$OBSERVING")
  if [ "$total" -eq 0 ]; then
    printf 'none'
    return 0
  fi
  while IFS= read -r f; do
    if [ "$shown" -ge "$LIST_CAP" ]; then
      line="$line, … and $((total - LIST_CAP)) more"
      break
    fi
    line="${line:+$line, }$f"
    shown=$((shown + 1))
  done <"$OBSERVING"
  printf '%s' "$line"
}

tier=full
changed_count=0

if collect_change_set; then
  changed_count=$(grep -c '' <"$CHANGED")
  if [ "$changed_count" -eq 0 ]; then
    reason="the change set is empty"
  else
    non_md=$(grep -v -E '\.md$' "$CHANGED" | head -1)
    if [ -z "$non_md" ]; then
      if guard_hits; then
        tier=docs
        reason="every path is markdown, and no test references one of them"
      fi
    elif prove_change_set && select_observing_tests && build_source_prose_legs; then
      tier=source-prose
    fi
  fi
fi

case "$tier" in
  docs)
    printf 'verify tier: docs — %d file(s); %s\n' "$changed_count" "$reason"
    print_list
    # The four legs that can observe markdown at all; verify:root is not among
    # them because `verify` has already run it before reaching this script.
    legs="pnpm check:adr-index && pnpm check:markdown-links && pnpm format:check"
    ;;
  source-prose)
    printf 'verify tier: source-prose — %d file(s) proven comment-only; observing tests: %s\n' \
      "$proven_count" "$(observing_summary)"
    print_list
    ;;
  *)
    if [ "$changed_count" -gt 0 ]; then
      printf 'verify tier: full — %d file(s); %s\n' "$changed_count" "$reason"
      print_list
    else
      printf 'verify tier: full — %s\n' "$reason"
    fi
    if [ -s "$TMP/hits" ]; then
      while IFS= read -r hit; do
        printf '  guard: %s\n' "$hit"
      done <"$TMP/hits"
    fi
    # The full tier delegates to the unconditional composite rather than
    # restating its legs: package.json is the one place that list lives (the same
    # reason the CI step calls the composite instead of enumerating gates), and a
    # second copy here would be the drift #47 was filed for.
    #
    # The `verify root:` line is therefore printed twice on this tier — once by
    # `verify`, once by the composite it delegates to. They are the same line
    # about the same tree; the alternative is a `verify:full` that no longer
    # states which tree it ran in, which the evidence ritual depends on.
    legs="pnpm verify:full"
    ;;
esac

# One string, printed by --dry-run and executed otherwise. Not two copies of the
# list: every harness case asserts what --dry-run PRINTS, and a separate copy for
# the executing path would make those assertions about a string nothing runs.
if [ "$dry_run" = "1" ]; then
  printf 'verify tier: dry run — would run: %s\n' "$legs"
  exit 0
fi

eval "$legs"
