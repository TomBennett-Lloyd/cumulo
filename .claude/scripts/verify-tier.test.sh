#!/usr/bin/env bash
# Test harness for verify-tier.sh, its neighbour in this directory.
#
# The assertion vocabulary is harness-lib.sh next door; the fixtures are real
# git repositories — a bare origin plus a clone of it — built the way
# worktree-lifecycle.test.sh builds its own, because the subject's whole input is
# what git says about a tree and a stub for that is a stub for the thing under
# test.
#
# Every case runs the classifier with --dry-run, so no case ever executes a gate.
# What is asserted is the tier and the leg list the classifier says it would run;
# the delegation itself is one `pnpm <script>` line, and a harness that ran the
# real composite per case would take an hour to say so.
#
# That is also the limit of what the source-prose cases can claim. Whether the
# compiler goes red on a `@ts-expect-error` hidden in a comment is tsc's verdict,
# not this classifier's; what belongs here is that the emit proof did not see the
# pragma — so the tier still comes out source-prose — and that `pnpm typecheck`
# is in the leg list, which is the only way that verdict can ever be reached. The
# red itself is evidence on the PR, run against this repository.
#
# The bias every case is written against: this script can only be wrong in one
# direction. Classifying a markdown-only change as full costs a slow run;
# classifying anything else as docs skips gates that could have caught a defect.
# So the docs-tier cases assert the exact leg list (a docs tier that quietly
# gained `pnpm test` would still say "docs"), and every fail-closed case asserts
# rc AND the reason, because a tier that came out full for the wrong reason is a
# case that will stop covering anything the day the reason changes. The
# source-prose cases inherit both: one asserts its whole leg list, and the
# selection cases name the observing tests they expect rather than counting them.
#
# The emit proof needs an esbuild binary, and the fixtures have no node_modules
# of their own — the classifier resolves one from the repository holding it,
# which is this one. A checkout that has not installed its dependencies cannot
# run these cases, the same precondition `pnpm test:scripts` already carries.
#
# Every fixture carries a *.test.ts file in its base commit, and not for
# decoration: the soundness guard refuses to certify a change set it could not
# check against anything, so a fixture with no test files would take the
# fail-closed path and the docs tier would be unreachable for reasons that have
# nothing to do with the case. One case removes it deliberately, to assert that
# refusal.
#
# One case runs the classifier against the REAL repository with no argument:
# every other case pins it to a fixture, so without it the shipped default path
# — the one `pnpm verify` actually takes — could be broken and the suite would
# still be green (testing.md rule 7).
#
# Usage: bash .claude/scripts/verify-tier.test.sh  (or `pnpm test:scripts`)
# Exit:  0 every case PASS, 1 at least one FAIL, 2 the harness itself broke.
set -uo pipefail

SCRIPTS=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd) || exit 2
TIER="$SCRIPTS/verify-tier.sh"

# shellcheck source=./harness-lib.sh
. "$SCRIPTS/harness-lib.sh"
harness_init_tmp

DOCS_LEGS="pnpm check:adr-index && pnpm check:markdown-links && pnpm format:check"

ROOT=""
WT=""

# --- fixtures ----------------------------------------------------------------------------

# Identity is passed per-command: the harness must not depend on (or write) any git config.
gitc() {
  local dir="$1"
  shift
  git -C "$dir" -c user.email=test@test -c user.name=test -c commit.gpgsign=false "$@"
}

# fixture <name> -> sets ROOT to a fresh $TMP_ROOT/<name> holding a bare origin and WT to a
# clone of it, one commit deep on main. The base commit holds a markdown file, a source file
# and a test file, so a case can change any of the three without also creating it.
#
# The fixture's markdown basenames are deliberately unlike any this repository holds
# (`tier-fixture-*.md`): the guard matches basenames, so a fixture named README.md would
# assert nothing about the guard that the repository's own tree did not already decide.
fixture() {
  ROOT="$TMP_ROOT/$1"
  WT="$ROOT/wt"
  must mkdir -p "$ROOT"
  must git init --quiet --bare -b main "$ROOT/origin.git"
  must git init --quiet -b main "$ROOT/seed"
  must mkdir -p "$ROOT/seed/docs" "$ROOT/seed/src"
  must printf 'node_modules/\n' >"$ROOT/seed/.gitignore"
  must printf '# Guide\n' >"$ROOT/seed/docs/tier-fixture-guide.md"
  must printf 'export const a = 1;\n' >"$ROOT/seed/src/app.ts"
  must printf "it('works', () => {});\n" >"$ROOT/seed/src/app.test.ts"
  must gitc "$ROOT/seed" add -A
  must gitc "$ROOT/seed" commit --quiet -m base
  must gitc "$ROOT/seed" remote add origin "$ROOT/origin.git"
  must gitc "$ROOT/seed" push --quiet origin main
  must rm -rf "$ROOT/seed"
  must git clone --quiet "$ROOT/origin.git" "$WT"
}

write_in() { # write_in <path under the worktree> <line>
  must mkdir -p "$(dirname "$WT/$1")"
  must printf '%s\n' "$2" >"$WT/$1"
}

commit_all() { # commit_all <message> — a commit on the branch, never pushed
  must gitc "$WT" add -A
  must gitc "$WT" commit --quiet -m "$1"
}

# seed_origin <message> — commit AND publish, so what was just written lands in the merge-base
# instead of the change set. Every case that needs a test file to already say something, or a
# workspace package to already exist, needs it invisible to the classifier's diff.
seed_origin() {
  commit_all "$1"
  must gitc "$WT" push --quiet origin main
}

run_tier() { # run_tier — the production invocation, --dry-run, against $WT
  capture bash "$TIER" --dry-run "$WT"
}

# ==========================================================================================
# 1. the classifier parses
# ==========================================================================================
begin "verify-tier.sh parses (bash -n)"
expect_parses "$TIER"
end

# ==========================================================================================
# 2. the real repo, via the shipped default path (no argument)
# ==========================================================================================
# The production configuration: no REPO_ROOT argument, so this is the only case that can
# catch a broken default root resolution — and it is what `pnpm verify` actually runs. It
# asserts the shape of the verdict rather than which tier came out, because the tier depends
# on the working tree the suite happens to run in and a case that demanded one would be a
# case that fails on a clean checkout or on a dirty one, at random.
begin "the real repository classifies with no argument, and names a tier and its legs"
for interpreter in $BASHES; do
  case_ctx="$interpreter"
  capture "$interpreter" "$TIER" --dry-run
  expect_rc 0 "$rc"
  expect_stdout "verify tier: "
  expect_stdout "verify tier: dry run — would run: "
  expect_not_out "unbound variable"
  expect_not_out "No such file"
done
case_ctx=""
end

# ==========================================================================================
# 3. THE SAVING: markdown-only change sets, from each of the three sources
# ==========================================================================================
# The change set has three parts and no single git command reports all of them, so each part
# gets its own case: drop one of the three collections and exactly one of these goes red —
# and, worse than red, an uncollected part would make a mixed change set look markdown-only.
begin "an edited markdown file alone is the docs tier, and runs only the four md gates"
must fixture edited_md
write_in docs/tier-fixture-guide.md '# Guide, revised'
for interpreter in $BASHES; do
  case_ctx="$interpreter"
  capture "$interpreter" "$TIER" --dry-run "$WT"
  expect_rc 0 "$rc"
  expect_stdout "verify tier: docs — 1 file(s)"
  expect_stdout "docs/tier-fixture-guide.md"
  expect_stdout "would run: $DOCS_LEGS"
  expect_not_out "verify:full"
  expect_not_out "unbound variable"
done
case_ctx=""
end

begin "an untracked markdown file alone is the docs tier"
must fixture untracked_md
write_in docs/tier-fixture-note.md '# Note'
run_tier
expect_rc 0 "$rc"
expect_stdout "verify tier: docs — 1 file(s)"
expect_stdout "docs/tier-fixture-note.md"
expect_stdout "would run: $DOCS_LEGS"
end

begin "markdown committed on the branch since the merge-base is the docs tier"
must fixture committed_md
write_in docs/tier-fixture-guide.md '# Guide, revised'
commit_all 'docs: revise the guide'
run_tier
expect_rc 0 "$rc"
expect_stdout "verify tier: docs — 1 file(s)"
expect_stdout "docs/tier-fixture-guide.md"
expect_not_out "verify:full"
end

# A deletion is a change to a markdown file like any other, and the gate that can observe it
# is check-markdown-links — a link into the deleted file is exactly what breaks. The path is
# in the change set while the file is not on disk, which is the shape that would trip a
# classifier that stat'ed paths instead of reading git's answer.
begin "a deleted markdown file is still the docs tier"
must fixture deleted_md
must gitc "$WT" rm --quiet docs/tier-fixture-guide.md
run_tier
expect_rc 0 "$rc"
expect_stdout "verify tier: docs — 1 file(s)"
expect_stdout "docs/tier-fixture-guide.md"
end

# Line-based parsing of git's output is only safe while a path stays on one line. A space is
# the everyday version of that question and the one a docs directory actually meets.
begin "a markdown path containing a space is still classified, and still the docs tier"
must fixture spaced_md
write_in 'docs/tier fixture spaced.md' '# Spaced'
run_tier
expect_rc 0 "$rc"
expect_stdout "verify tier: docs — 1 file(s)"
expect_stdout "docs/tier fixture spaced.md"
end

begin "several markdown files, from different sources, are one docs-tier change set"
must fixture many_md
write_in docs/tier-fixture-guide.md '# Guide, revised'
commit_all 'docs: revise the guide'
write_in docs/tier-fixture-note.md '# Note'
write_in docs/tier-fixture-more.md '# More'
run_tier
expect_rc 0 "$rc"
expect_stdout "verify tier: docs — 3 file(s)"
expect_stdout "docs/tier-fixture-guide.md"
expect_stdout "docs/tier-fixture-note.md"
expect_stdout "docs/tier-fixture-more.md"
end

# ==========================================================================================
# 4. anything else is the full composite
# ==========================================================================================
begin "a source file whose emit changed is the full tier, and the offending path is named"
must fixture edited_ts
write_in src/app.ts 'export const a = 2;'
run_tier
expect_rc 0 "$rc"
expect_stdout "verify tier: full"
expect_stdout "the minified emit changed — src/app.ts"
expect_stdout "would run: pnpm verify:full"
expect_not_stdout "verify tier: docs"
expect_not_stdout "verify tier: source-prose"
end

# The case the docs tier exists to get right in the dangerous direction: markdown present, so
# a classifier that asked "does this touch markdown" instead of "is this ALL markdown" would
# skip the compiler and the tests over a source edit. The source-prose rung does not rescue
# it either — that rung's question is about the emit, and this emit moved.
begin "markdown plus a source file whose emit changed is the full tier"
must fixture mixed
write_in docs/tier-fixture-guide.md '# Guide, revised'
write_in src/app.ts 'export const a = 2;'
run_tier
expect_rc 0 "$rc"
expect_stdout "verify tier: full — 2 file(s)"
expect_stdout "the minified emit changed — src/app.ts"
expect_not_stdout "verify tier: docs"
expect_not_stdout "verify tier: source-prose"
end

# Case matters, and this is the fail-closed direction: prettier and the link checker are
# configured for the extension this repository actually writes, so a .MD file is not
# self-evidently covered by the docs tier's four gates — and no esbuild loader claims it
# either, so the source-prose rung cannot take it. It gets the composite.
begin "an upper-case .MD extension is not the docs tier"
must fixture upper_md
write_in docs/TIER-FIXTURE.MD '# Shouty'
run_tier
expect_rc 0 "$rc"
expect_stdout "verify tier: full"
expect_stdout "neither markdown nor a source type the emit proof handles — docs/TIER-FIXTURE.MD"
end

begin "an empty change set is the full tier, not a free pass"
must fixture clean
run_tier
expect_rc 0 "$rc"
expect_stdout "verify tier: full — the change set is empty"
expect_stdout "would run: pnpm verify:full"
expect_not_stdout "verify tier: docs"
end

# ==========================================================================================
# 5. THE SECOND RUNG: a source edit that changed no emitted code
# ==========================================================================================
# The rung's claim is "this edit changed no emitted code", proven by minifying the merge-base
# blob and the working file and comparing bytes. Section 4 above holds its refutations — a
# moved token, an unhandled extension — so what these cases own is the positive answer and
# what it buys: the tier line, the legs that can still see a comment, and the observing set.
#
# One fail-closed path is missing from this section and cannot honestly be added: a checkout
# with no esbuild binary. Constructing it means removing the node_modules the harness itself
# resolves the binary from, so the case would break every other case in the file to assert
# one line. It is covered by the same `if ! ESBUILD=$(find_esbuild)` shape as every other
# guard here, and by nothing else.

begin "a comment-only .ts edit is the source-prose tier, and runs exactly the legs that can see a comment"
must fixture comment_only_ts
write_in src/app.ts 'export const a = 1; // now with a note'
for interpreter in $BASHES; do
  case_ctx="$interpreter"
  capture "$interpreter" "$TIER" --dry-run "$WT"
  expect_rc 0 "$rc"
  expect_stdout "verify tier: source-prose — 1 file(s) proven comment-only; observing tests: none"
  expect_stdout "  src/app.ts"
  expect_stdout "would run: pnpm exec eslint --no-warn-ignored --max-warnings 0 -- src/app.ts && pnpm typecheck && pnpm check:aws-test-guard && pnpm exec prettier --check --ignore-unknown -- src/app.ts"
  expect_not_out "verify:full"
  expect_not_out "unbound variable"
done
case_ctx=""
end

# The pragma case, and the reason the compiler stays in the leg list. `@ts-expect-error` is a
# comment: esbuild strips it, the two emits match, and the rung takes the change — which is
# exactly right, because the pragma changes no behaviour and exactly wrong if the tier then
# skipped tsc, the only gate that reads it. What tsc then says is tsc's business (see this
# file's header).
begin "a @ts-expect-error hidden in a comment does not defeat the proof, and typecheck still runs"
must fixture pragma_in_comment
write_in src/app.ts 'export const a = 1; // @ts-expect-error'
run_tier
expect_rc 0 "$rc"
expect_stdout "verify tier: source-prose — 1 file(s) proven comment-only"
expect_stdout "pnpm typecheck"
end

# A .css comment is observable by stylelint and by nothing else in the composite, so the leg
# list is the assertion: stylelint present, eslint absent (it was given no file it handles).
begin "a comment-only .css edit is the source-prose tier, and stylelint is the leg that runs"
must fixture comment_only_css
write_in src/app.css '.a { color: red; }'
seed_origin 'style: a stylesheet to comment on'
write_in src/app.css '.a { color: red; } /* now with a note */'
run_tier
expect_rc 0 "$rc"
expect_stdout "verify tier: source-prose — 1 file(s) proven comment-only; observing tests: none"
expect_stdout "would run: pnpm exec stylelint --max-warnings 0 -- src/app.css && pnpm typecheck"
expect_not_stdout "eslint"
expect_not_out "verify:full"
end

# A file with no emit to compare against is not a file with an unchanged emit. This is the
# state a comment-only branch reaches the moment it also adds a module.
begin "an untracked source file is the full tier"
must fixture new_source
write_in src/brand-new.ts 'export const b = 1;'
run_tier
expect_rc 0 "$rc"
expect_stdout "verify tier: full"
expect_stdout "new since the merge-base, so there is no emit to compare against — src/brand-new.ts"
expect_not_stdout "verify tier: source-prose"
end

# THE OBSERVING SET, arm (a): a test that reads files as data can see a comment without ever
# naming the file it lives in. Asserted as a delta in one repository rather than as two
# fixtures, because the claim is about the test CHANGING — a selection that was already
# correct before the change would pass a two-fixture version of this case.
begin "a test that gains a readFileSync joins the observing set, and vitest runs it from its package"
must fixture observing_data
write_in pkg/package.json '{ "name": "@fixture/pkg", "private": true }'
write_in pkg/src/reader.test.ts "it('reads nothing', () => {});"
seed_origin 'test: a test that reads nothing'
write_in src/app.ts 'export const a = 1; // now with a note'
run_tier
expect_rc 0 "$rc"
expect_stdout "observing tests: none"
expect_not_stdout "vitest"

must gitc "$WT" checkout --quiet -- src/app.ts
write_in pkg/src/reader.test.ts "it('reads', () => readFileSync('somewhere'));"
seed_origin 'test: the test now reads a file'
write_in src/app.ts 'export const a = 1; // now with a note'
run_tier
expect_rc 0 "$rc"
expect_stdout "verify tier: source-prose — 1 file(s) proven comment-only; observing tests: pkg/src/reader.test.ts"
expect_stdout "pnpm --filter ./pkg exec vitest run src/reader.test.ts"
end

# Arm (b), and the reason it exists: a contract test that names the file it asserts about
# observes a comment in it without reading anything at run time.
begin "a test naming the changed file's basename joins the observing set"
must fixture observing_basename
write_in pkg/package.json '{ "name": "@fixture/pkg", "private": true }'
write_in pkg/src/names.test.ts "it('knows app.ts', () => {});"
seed_origin 'test: a test that names the module'
write_in src/app.ts 'export const a = 1; // now with a note'
run_tier
expect_rc 0 "$rc"
expect_stdout "observing tests: pkg/src/names.test.ts"
expect_stdout "pnpm --filter ./pkg exec vitest run src/names.test.ts"
end

# The Playwright lane is outside `verify` (testing.md rule 10), so a *.spec.* file is never
# selected to run however loudly it observes the change — a tier stricter than the composite
# it stands in for is a spurious red, and a spurious red is how a gate gets bypassed. This
# case is what goes red if the suffix filter is ever dropped as redundant.
begin "a browser spec that reads files is not selected, because the composite never runs one"
must fixture observing_spec
write_in pkg/package.json '{ "name": "@fixture/pkg", "private": true }'
write_in pkg/e2e/browser.spec.ts "test('reads', () => readFileSync('app.ts'));"
seed_origin 'test: a browser spec that reads a file'
write_in src/app.ts 'export const a = 1; // now with a note'
run_tier
expect_rc 0 "$rc"
expect_stdout "verify tier: source-prose — 1 file(s) proven comment-only; observing tests: none"
expect_not_stdout "vitest"
expect_not_stdout "browser.spec.ts"
end

# Markdown rides along: the count is what was PROVEN, not what changed, and the two gates that
# can observe a .md rejoin the list. Without this, a prose PR that also touches one comment
# would silently stop checking its own links.
begin "markdown alongside a comment-only source edit keeps the markdown gates"
must fixture prose_and_source
write_in docs/tier-fixture-guide.md '# Guide, revised'
write_in src/app.ts 'export const a = 1; // now with a note'
run_tier
expect_rc 0 "$rc"
expect_stdout "verify tier: source-prose — 1 file(s) proven comment-only"
expect_stdout "  docs/tier-fixture-guide.md"
expect_stdout "  src/app.ts"
expect_stdout "pnpm check:adr-index && pnpm check:markdown-links"
expect_stdout "pnpm exec prettier --check --ignore-unknown -- docs/tier-fixture-guide.md src/app.ts"
end

# ==========================================================================================
# 6. THE SOUNDNESS GUARD: the docs tier's claim, checked rather than assumed
# ==========================================================================================
# The docs tier rests on "no test can observe this markdown". These two cases are what turn
# that from an assumption into a checked fact — and they are the cases that go red if the
# guard is ever removed as an optimisation, because everything else about a markdown-only
# change set stays true.
begin "a test naming the changed markdown path forces the full tier, and the hit is printed"
must fixture guard_path
write_in src/copy.test.ts "const doc = 'docs/tier-fixture-guide.md';"
seed_origin 'test: read the guide'
write_in docs/tier-fixture-guide.md '# Guide, revised'
run_tier
expect_rc 0 "$rc"
expect_stdout "verify tier: full"
expect_stdout "a test file references a markdown path in this change set"
expect_stdout "guard: src/copy.test.ts:1:"
expect_not_stdout "verify tier: docs"
end

# The basename arm, and the reason it exists: a path assembled at run time holds no
# repo-relative path anywhere in the source, so a guard matching only full paths would
# certify this change set as unobservable while the test reads exactly the file that changed.
begin "a test naming only the changed file's basename forces the full tier"
must fixture guard_basename
write_in src/copy.spec.ts "const doc = join(root, 'docs', 'tier-fixture-guide.md');"
seed_origin 'test: join the guide path'
write_in docs/tier-fixture-guide.md '# Guide, revised'
run_tier
expect_rc 0 "$rc"
expect_stdout "verify tier: full"
expect_stdout "guard: src/copy.spec.ts:1:"
end

# The control on both: a test that mentions some OTHER markdown file must not hold the tier
# hostage. Without this, a guard that simply grepped for `\.md` anywhere in the test trees
# would pass every case above — and would pin this repository, whose harnesses build markdown
# fixtures by the dozen, on the full tier forever.
begin "a test naming an unrelated markdown file leaves the docs tier alone"
must fixture guard_unrelated
write_in src/copy.test.ts "const doc = 'docs/some-other-document.md';"
seed_origin 'test: read another document'
write_in docs/tier-fixture-guide.md '# Guide, revised'
run_tier
expect_rc 0 "$rc"
expect_stdout "verify tier: docs — 1 file(s)"
expect_not_stdout "guard: "
end

# An empty census is a broken census, not a clean one — the rule the check:* gates apply to
# their own scans. A repository whose test files cannot be found has no evidence to offer
# about what its tests can see, so it does not get the tier that depends on that evidence.
begin "a change set that could be checked against no test file at all is the full tier"
must fixture guard_no_tests
must gitc "$WT" rm --quiet src/app.test.ts
must gitc "$WT" commit --quiet -m 'chore: drop the tests'
must gitc "$WT" push --quiet origin main
write_in docs/tier-fixture-guide.md '# Guide, revised'
run_tier
expect_rc 0 "$rc"
expect_stdout "verify tier: full"
expect_stdout "found no test files to check the change set against"
expect_not_stdout "verify tier: docs"
end

# ==========================================================================================
# 7. FAIL CLOSED: a change set the classifier cannot trust is a full run
# ==========================================================================================
# Both cases below would classify as markdown-only if the failure were swallowed — the
# working tree holds one edited .md and nothing else — so each one is precisely the state in
# which a silently-degraded classifier would skip the composite.
begin "a fetch that cannot reach the remote is the full tier, with the reason"
must fixture no_remote
write_in docs/tier-fixture-guide.md '# Guide, revised'
must gitc "$WT" remote set-url origin "$ROOT/does-not-exist.git"
run_tier
expect_rc 0 "$rc"
expect_stdout "verify tier: full — could not fetch origin main"
expect_not_stdout "verify tier: docs"
end

begin "a HEAD with no merge-base against origin/main is the full tier, with the reason"
must fixture orphan
must gitc "$WT" checkout --quiet --orphan lonely
must gitc "$WT" commit --quiet -m 'orphan'
write_in docs/tier-fixture-guide.md '# Guide, revised'
run_tier
expect_rc 0 "$rc"
expect_stdout "verify tier: full — no merge-base between HEAD and origin/main"
expect_not_stdout "verify tier: docs"
end

# ==========================================================================================
# 8. the report itself
# ==========================================================================================
# A branch can carry a hundred files since its merge-base, and a hundred-line dump before
# every gate is noise nobody reads. The count is the load-bearing number; the list is a
# courtesy, and it is summarised past the cap.
begin "a change set past the list cap is summarised, not dumped"
must fixture capped
i=1
while [ "$i" -le 22 ]; do
  write_in "docs/tier-fixture-$i.md" "# Doc $i"
  i=$((i + 1))
done
run_tier
expect_rc 0 "$rc"
expect_stdout "verify tier: docs — 22 file(s)"
expect_stdout "… and 2 more"
end

# ==========================================================================================
# 9. invocations the classifier cannot give a verdict on
# ==========================================================================================
# Exit 2, never a tier: an invocation this script cannot make sense of is not evidence that
# the change set is safe, and answering "full" would hide the typo behind a slow green run.
begin "a nonexistent root exits 2, and names no tier"
capture bash "$TIER" --dry-run "$TMP_ROOT/does-not-exist"
expect_rc 2 "$rc"
expect_stderr "not a directory"
expect_not_stdout "verify tier: "
end

begin "an unknown option exits 2"
capture bash "$TIER" --docs
expect_rc 2 "$rc"
expect_stderr "unknown option --docs"
expect_not_stdout "verify tier: "
end

begin "a second directory argument exits 2"
must fixture two_args
capture bash "$TIER" --dry-run "$WT" "$WT"
expect_rc 2 "$rc"
expect_stderr "expected at most one directory"
expect_not_stdout "verify tier: "
end

begin "--help exits 0 and runs nothing"
capture bash "$TIER" --help
expect_rc 0 "$rc"
expect_stdout "Usage: bash .claude/scripts/verify-tier.sh"
expect_not_stdout "verify tier: "
end

# ==========================================================================================

finish
