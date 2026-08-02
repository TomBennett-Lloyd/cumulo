#!/usr/bin/env bash
# Test harness for check-markdown-links.sh, its neighbour in this directory.
#
# Self-contained on the same terms as check-adr-index.test.sh and lint-shell.test.sh: no
# framework, no network, no pnpm. Every fixture is a throwaway git work tree under a single
# `mktemp -d` that a trap deletes on exit, so the drift cases — a renamed heading, an ignored
# target, a link that walks out of the repository — are exercised for real without ever
# mutating this repo's own markdown.
#
# Fixtures `git init` but, with one exception, never commit: the gate discovers with
# `git ls-files --cached --others --exclude-standard`, so an untracked-unignored file is
# already in the population. That is deliberate, not a shortcut — it means the fixtures
# exercise the `--others` half of the discovery rule, which is the half that governs a doc
# you have just written (precedent: lint-shell.test.sh's fixtures, which do commit because
# that gate's regression is about the index disagreeing with the working tree). The exception
# is case 20, whose whole subject is the index and the working tree disagreeing: a target can
# only be `--cached` and absent from disk if it was committed first.
#
# One case deliberately runs the gate with NO argument, against the real repo: every other
# case pins ROOT to a fixture, so without it the shipped default path could rot green
# (testing.md rule 7).
#
# Case numbering below matches the #127 plan's C2 case list 1-16 one-for-one, so a reviewer
# can read them side by side. Case 0 is the parse check the sibling harnesses open with, and
# case 17 pins two shipped behaviours C1 recorded as deviations from the plan's wording.
# Cases 18-20 come from review cycle 1. 18 and 19 are the two shapes that exposed a real
# fence-parity bug: against the gate as first shipped, each one's broken-link-after-the-fence
# fixture exited 0 announcing "1 link(s) checked" (the link was never looked at), while 19's
# second fixture reported a link that was sitting inside a fence — the same parity error seen
# from the other side. 20 covers the tracked-but-absent target, the one branch pair nothing
# else reached.
#
# What a green run of THIS harness does not say: it measures the gate, not GitHub. Every
# anchor expectation here is the gate's slug algorithm agreeing with itself. The claim that
# the algorithm matches GitHub's was established against the real corpus during planning and
# is restated in the gate's own header — it is not, and cannot be, tested from here.
#
# Usage: bash .claude/scripts/check-markdown-links.test.sh   (or `pnpm test:scripts`)
# Exit:  0 every case PASS, 1 at least one FAIL, 2 the harness itself broke.
set -uo pipefail

SCRIPTS=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd) || exit 2
CHECK="$SCRIPTS/check-markdown-links.sh"

tmp_raw=$(mktemp -d) || exit 2
trap 'rm -rf "$tmp_raw"' EXIT INT TERM
# Canonical from the start: macOS hides temp dirs behind /var -> /private/var, and the gate
# compares its ROOT against a `pwd -P`'d work-tree toplevel.
TMP_ROOT=$(cd "$tmp_raw" && pwd -P) || exit 2

# Case 14 asserts that a directory outside any git work tree gets no verdict. If TMPDIR
# happened to sit inside a repository, that case would silently be testing something else, so
# the assumption is checked rather than assumed.
if git -C "$TMP_ROOT" rev-parse --show-toplevel >/dev/null 2>&1; then
  printf 'FATAL harness setup failed: %s is inside a git work tree; case 14 cannot run\n' \
    "$TMP_ROOT" >&2
  exit 2
fi

passed=0
failed=0
case_name=""
case_failed=0
case_ctx=""
out=""
rc=0

# The gate has to survive the oldest bash it can meet: macOS ships /bin/bash 3.2, where
# pattern substitution, `[[ =~ ]]` with an unquoted pattern variable and byte-wise matching
# under LC_ALL=C all behave subtly differently from 4.4+. The two cases that lean hardest on
# those — the omnibus pass case and the duplicate-heading dedupe — run under every distinct
# bash on the box rather than whichever one PATH happens to hand over.
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

write() { # write <path> <line...>
  local path="$1" line
  shift
  : >"$path" || return 1
  for line in "$@"; do
    printf '%s\n' "$line" >>"$path" || return 1
  done
}

append() { # append <path> <line...>
  local path="$1" line
  shift
  for line in "$@"; do
    printf '%s\n' "$line" >>"$path" || return 1
  done
}

# Identity is passed per-command: the harness must not depend on (or write) any git config.
# Only case 20 commits.
gitc() {
  local dir="$1"
  shift
  git -C "$dir" -c user.email=test@test -c user.name=test -c commit.gpgsign=false "$@"
}

# work_tree <name> -> sets ROOT to a fresh, empty git work tree.
work_tree() {
  ROOT="$TMP_ROOT/$1"
  must mkdir -p "$ROOT"
  must git init --quiet -b main "$ROOT"
}

# fixture <name> -> sets ROOT to a work tree holding the minimal *passing* corpus: a README
# whose line 3 links the guide, and a guide with a `## Usage` heading. Cases append exactly
# one broken line — landing on line 4 — so a failure names its own cause, and the surviving
# good link keeps the census non-vacuous (without it a broken-link case would exit 2, not 1,
# and would pass for the wrong reason).
fixture() {
  work_tree "$1"
  must mkdir -p "$ROOT/docs"
  must write "$ROOT/docs/guide.md" '# Guide' '' '## Usage' '' 'Prose.'
  must write "$ROOT/README.md" '# Readme' '' 'See the [guide](docs/guide.md).'
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
# 0. the gate parses
# ==========================================================================================
begin "check-markdown-links.sh parses (bash -n)"
if ! syntax=$(bash -n "$CHECK" 2>&1); then
  bad "check-markdown-links.sh failed bash -n: $syntax"
fi
end

# ==========================================================================================
# 1. every passing shape at once
# ==========================================================================================
# One fixture rather than nine, because the risk with a link extractor is not that it rejects
# a shape in isolation — cases 2-13 cover rejection — but that a tightening somewhere makes
# an ordinary spelling unusable. The link COUNT is asserted, not just the exit code: 12 is
# the number of links outside code, and the two link-shaped strings inside a fence and an
# inline code span are what makes 14 the wrong answer. Exit 0 alone cannot tell those apart.
begin "every passing link shape resolves: paths, directories, anchors, external, code"
work_tree pass_shapes
must mkdir -p "$ROOT/docs/deep" "$ROOT/assets"
must write "$ROOT/assets/logo.txt" 'not markdown'
cat <<'EOF' >"$ROOT/README.md"
# Readme

A [guide](docs/guide.md), the [same guide](./docs/guide.md) and the
[root-relative spelling](/docs/guide.md).

The [assets directory](assets/) and [the repo root](.) both resolve.

Anchors: [this file's own top](#readme) and
[a section of the guide](docs/guide.md#usage), including the em dash in
[Phase A](docs/guide.md#phase-a--plan).

External, counted and skipped: [Open-Meteo](https://open-meteo.com/).

Inline code is prose about a link, not a link: `[x](never-existed.md)`.

```text
[also not a link](never-existed.md)
```
EOF
must test -s "$ROOT/README.md"
cat <<'EOF' >"$ROOT/docs/guide.md"
# Guide

## Usage

Back to the [readme](../README.md).

## Phase A — plan

Nested: [nested](deep/nested.md).
EOF
must test -s "$ROOT/docs/guide.md"
must write "$ROOT/docs/deep/nested.md" '# Nested' '' 'Up and across: [the guide](../guide.md).'
for interpreter in $BASHES; do
  case_ctx="$interpreter"
  run_check_with "$interpreter" "$ROOT"
  expect_rc 0 "$rc"
  # The census numbers are the assertion. 3 files: assets/logo.txt is not markdown and must
  # not be scanned as a source. 12 links: the fenced one and the inline-code one are absent.
  # 1 external: the https:// link was classified and skipped, not resolved as a path.
  expect_out "OK — 3 markdown file(s), 12 link(s) checked (1 external, skipped)"
  expect_not_out "ERROR"
  # Under bash 3.2 the em-dash slug is byte-wise pattern substitution; a locale or version
  # that folded it differently would report the Phase A link rather than resolve it.
  expect_not_out "phase-a--plan"
done
end

# ==========================================================================================
# 2. a relative file link to nothing
# ==========================================================================================
begin "a broken relative file link fails the gate and names file, line and target"
fixture broken_path
must append "$ROOT/README.md" 'Gone: [missing](docs/missing.md).'
run_check "$ROOT"
expect_rc 1 "$rc"
expect_out "README.md:4"
expect_out "docs/missing.md"
expect_out "is not a file or directory git lists"
end

# ==========================================================================================
# 3. a same-file anchor naming no heading
# ==========================================================================================
begin "a broken same-file anchor fails the gate"
fixture broken_self_anchor
must append "$ROOT/README.md" 'Anchor: [nope](#no-such-heading).'
run_check "$ROOT"
expect_rc 1 "$rc"
expect_out "README.md:4"
expect_out "#no-such-heading"
expect_out "but README.md has no heading with that anchor"
end

# ==========================================================================================
# 4. a cross-file anchor into a file that exists
# ==========================================================================================
# The error has to name the file whose headings were searched, not only the file the link was
# written in: "no such anchor" is unactionable without knowing where the gate looked.
begin "a broken cross-file anchor fails and names the file whose headings were searched"
fixture broken_cross_anchor
must append "$ROOT/README.md" 'Cross: [gone](docs/guide.md#gone).'
run_check "$ROOT"
expect_rc 1 "$rc"
expect_out "README.md:4"
expect_out "but docs/guide.md has no heading with that anchor"
# The path half resolved. If it had not, this would be a missing-file report wearing an
# anchor's clothes, and the case would prove nothing about anchor checking.
expect_not_out "is not a file or directory git lists"
end

# ==========================================================================================
# 5. a heading that only exists inside a fence is not a heading
# ==========================================================================================
# infra/README.md's runbook fences contain `# expect: …` comment lines. If those became
# anchors, every one of them would be a heading nobody can link to on GitHub, and the gate
# would resolve links that 404 in the browser — silent green, the failure class this gate is
# for.
begin "a '#' line inside a fence contributes no anchor"
fixture fenced_heading
must write "$ROOT/docs/guide.md" '# Guide' '' '~~~sh' '# expect foo' '~~~' '' '## Usage' '' 'Prose.'
must append "$ROOT/README.md" 'Fenced: [nope](docs/guide.md#expect-foo) but [real](docs/guide.md#usage).'
run_check "$ROOT"
expect_rc 1 "$rc"
expect_out "#expect-foo"
expect_out "but docs/guide.md has no heading with that anchor"
# Exactly one: `## Usage` sits AFTER the fence, so a fence-toggle that never closed would
# swallow it and report two. The count is what proves the fence closed.
expect_out "1 broken link(s)"
end

# ==========================================================================================
# 6. a link inside a fence is not a link — and the fence marker must be in column 1
# ==========================================================================================
begin "links inside a fence are skipped, and an indented fence is scanned as prose"
case_ctx="column-1 fence"
fixture fenced_link
must append "$ROOT/README.md" '~~~text' '[not a link](docs/missing.md)' '~~~'
run_check "$ROOT"
expect_rc 0 "$rc"
# The base fixture's one link is still counted, so this is "the fenced link was skipped",
# not "nothing was extracted" — which would have been exit 2 anyway.
expect_out "1 link(s) checked"
expect_not_out "docs/missing.md"
case_ctx="indented fence"
# Documented residual, pinned rather than left to drift: only a column-1 marker toggles
# fenced state, so an indented block is scanned as prose and can only ever OVER-report. The
# opposite choice — honouring indented fences — would make a link inside one silently
# unchecked, which is the direction that ships broken links.
fixture indented_fence
must append "$ROOT/README.md" '  ~~~text' '  [not a link](docs/missing.md)' '  ~~~'
run_check "$ROOT"
expect_rc 1 "$rc"
expect_out "docs/missing.md"
case_ctx=""
end

# ==========================================================================================
# 7. a link inside an inline code span is not a link
# ==========================================================================================
# The in-repo proof case: docs/adr/README.md:9 documents the index row shape as
# `- [NNNN — Title](NNNN-slug.md)`, naming a file that has never existed and never will.
begin "a link inside an inline code span is skipped"
fixture inline_code_link
cat <<'EOF' >>"$ROOT/README.md"
The index row shape is `- [NNNN — Title](NNNN-slug.md)`.
EOF
run_check "$ROOT"
expect_rc 0 "$rc"
expect_out "1 link(s) checked"
expect_not_out "NNNN-slug.md"
end

# ==========================================================================================
# 8. duplicate headings dedupe in document order
# ==========================================================================================
# Two `## Teardown` sections is the ordinary shape of a multi-stack runbook, and `#teardown-1`
# is the only spelling that reaches the second one. `-2` must NOT resolve: a dedupe that
# handed out suffixes without bound would accept anchors GitHub 404s.
begin "duplicate headings dedupe: #teardown and #teardown-1 resolve, #teardown-2 does not"
fixture dupe_headings
must write "$ROOT/docs/guide.md" \
  '# Guide' '' '## Teardown' '' 'Prose.' '' '## Teardown' '' 'More prose.'
for interpreter in $BASHES; do
  case_ctx="$interpreter, both real anchors"
  must write "$ROOT/README.md" \
    '# Readme' '' '[one](docs/guide.md#teardown) and [two](docs/guide.md#teardown-1).'
  run_check_with "$interpreter" "$ROOT"
  expect_rc 0 "$rc"
  expect_out "2 link(s) checked"
  case_ctx="$interpreter, one suffix too far"
  must write "$ROOT/README.md" '# Readme' '' '[three](docs/guide.md#teardown-2).'
  run_check_with "$interpreter" "$ROOT"
  expect_rc 1 "$rc"
  expect_out "#teardown-2"
  expect_out "but docs/guide.md has no heading with that anchor"
done
case_ctx=""
end

# ==========================================================================================
# 9. a link that walks out of the repository
# ==========================================================================================
# Existence is not the test. The target below is a real file on this disk, and the gate still
# rejects it — not because such a link necessarily 404s (it need not: github.com's blob view
# resolves `../..` above the repo root against the org path, which is how README.md's old
# `[issues](../../issues)` worked), but because a target outside the work tree is unresolvable
# from the only thing this gate can see, and is not portable across the hosts and contexts the
# same file is read in. Refusing it is a rule, not a diagnosis, and lexical resolution rather
# than `-e` is what makes the rule hold regardless of what happens to be on the disk.
begin "a link escaping the repository root fails even though the target exists on disk"
fixture containment
must write "$TMP_ROOT/escapee.md" '# Escapee'
must test -f "$TMP_ROOT/escapee.md"
must append "$ROOT/README.md" 'Out: [escapee](../escapee.md).'
run_check "$ROOT"
expect_rc 1 "$rc"
expect_out "README.md:4"
expect_out "escapes the repository root"
end

# ==========================================================================================
# 10. a gitignored target
# ==========================================================================================
begin "a link to a gitignored file fails even though the file is present"
fixture ignored_target
must write "$ROOT/.gitignore" 'secret.md'
must write "$ROOT/secret.md" '# Secret'
must test -f "$ROOT/secret.md"
must append "$ROOT/README.md" 'Hidden: [secret](secret.md).'
run_check "$ROOT"
expect_rc 1 "$rc"
expect_out "secret.md"
expect_out "missing, or ignored"
end

# ==========================================================================================
# 11. a target whose spelling differs only in case
# ==========================================================================================
# On the macOS filesystem this harness usually runs on, `test -f Notes.md` SUCCEEDS for a file
# created as notes.md — so a gate written around `-e` would pass this case locally and hand
# the 404 to GitHub and to every Linux CI runner. Matching the git listing as a string is what
# makes the local answer and the remote one the same answer.
begin "a link whose case does not match the git listing fails"
fixture case_mismatch
must write "$ROOT/notes.md" '# Notes'
must append "$ROOT/README.md" 'Miscased: [notes](Notes.md).'
run_check "$ROOT"
expect_rc 1 "$rc"
expect_out "Notes.md"
expect_out "missing, or ignored"
end

# ==========================================================================================
# 12. malformed targets
# ==========================================================================================
# Both in one run, because the report has to survive more than one finding, and because the
# second is the link-title residual the gate's header documents: `](path "title")` is legal
# markdown that this gate does not support, and it fails LOUD rather than resolving `path`.
begin "an empty target and a whitespace-bearing target are both reported"
fixture malformed
must append "$ROOT/README.md" \
  'Empty: [nothing]().' \
  'Titled: [t](docs/guide.md "Guide").'
run_check "$ROOT"
expect_rc 1 "$rc"
expect_out "README.md:4"
expect_out "has an empty link target"
expect_out "README.md:5"
expect_out "contains whitespace"
expect_out "2 broken link(s)"
end

# ==========================================================================================
# 13. a fragment on a target that is not markdown
# ==========================================================================================
begin "a fragment on a non-markdown target is reported as unverifiable"
fixture json_fragment
must write "$ROOT/data.json" '{}'
must append "$ROOT/README.md" 'Data: [field](data.json#foo).'
run_check "$ROOT"
expect_rc 1 "$rc"
expect_out "README.md:4"
expect_out "a fragment on a non-markdown file cannot be checked"
end

# ==========================================================================================
# 14. ROOT that is not a git work-tree toplevel
# ==========================================================================================
# `git ls-files` reports paths relative to the toplevel. Point the gate one directory down and
# every link would be resolved against the wrong base — quietly, and mostly successfully. All
# three shapes below are "the gate cannot reach a verdict", which is 2, never 1: a bad
# invocation reported as "broken links" would send somebody hunting through their docs.
begin "a ROOT that is not a work-tree toplevel exits 2, not 1"
case_ctx="outside any git work tree"
ROOT="$TMP_ROOT/not_a_repo"
must mkdir -p "$ROOT"
must write "$ROOT/README.md" '# Readme' '' 'See the [guide](guide.md).'
run_check "$ROOT"
expect_rc 2 "$rc"
expect_out "not inside a git work tree"
case_ctx="a subdirectory of a work tree"
fixture subdir_root
run_check "$ROOT/docs"
expect_rc 2 "$rc"
expect_out "is not a git work-tree toplevel"
case_ctx="a directory that is not there"
run_check "$TMP_ROOT/does-not-exist"
expect_rc 2 "$rc"
expect_out "not a directory"
case_ctx=""
end

# ==========================================================================================
# 15. the vacuity census
# ==========================================================================================
# Green-by-absence is the failure mode a docs gate is most likely to die of: a discovery
# filter that stops matching, or an extractor that stops extracting, both look exactly like a
# repository with no broken links. Both halves are therefore no-verdict, not pass.
begin "a work tree with no markdown, and one with no links, both exit 2"
case_ctx="no markdown files"
work_tree no_markdown
must write "$ROOT/notes.txt" 'not markdown'
run_check "$ROOT"
expect_rc 2 "$rc"
expect_out "no markdown files found in"
case_ctx="markdown but no links"
work_tree no_links
must write "$ROOT/README.md" '# Readme' '' 'Prose with no links in it at all.'
run_check "$ROOT"
expect_rc 2 "$rc"
expect_out "extracted no links at all from"
case_ctx=""
end

# ==========================================================================================
# 16. the real repo, via the shipped default path (no argument)
# ==========================================================================================
# The production configuration: no ROOT override, so this is the only case that can catch a
# broken default path — and it is what `pnpm verify` actually runs (testing.md rule 7).
begin "the repo's own markdown passes with no argument"
run_check
expect_rc 0 "$rc"
expect_out "check-markdown-links: OK"
end

# ==========================================================================================
# 17. a reported error outranks the vacuity guard
# ==========================================================================================
# Recorded as a deviation when C1 shipped, and pinned here because it is a precedence rule
# that nothing else exercises. An unclosed `](` is reported but never COUNTED — nothing was
# extracted from it — so a tree whose only link-like text is malformed reaches the census with
# errors>0 and links=0. Answering "the extractor is broken" (2) there would bury a finding the
# extractor had just made. A reported problem is itself proof the extractor ran, so 1 wins.
begin "a tree whose only link is malformed exits 1, not 2"
work_tree malformed_only
must write "$ROOT/README.md" '# Readme' '' 'An unclosed [link](docs/guide.md'
run_check "$ROOT"
expect_rc 1 "$rc"
expect_out "README.md:3"
expect_out "has a '](' that is never closed on the same line"
expect_not_out "extracted no links at all"
end

# ==========================================================================================
# 18. a fence marker of the other kind does not close the fence
# ==========================================================================================
# The regression that motivated the close rule, in the reviewer's own shape. Fenced state used
# to be a boolean toggled by ANY marker, so the ``` line below closed the ~~~ fence and the
# ~~~ line then re-opened it — leaving the rest of the file "inside a fence" and every link in
# it silently unchecked. Against that gate this fixture exited 0 and announced
# "1 link(s) checked", which is the exact failure class the gate exists to prevent: a green
# run that means "I stopped looking". The `~~~text` / ``` pairing is not exotic, it is how you
# document a fence inside a fence, which this repo's docs about markdown gates now do.
begin "a backtick marker inside a tilde fence is content, and later links are still checked"
fixture fence_other_marker
must append "$ROOT/README.md" '~~~text' '```' '~~~' '' 'Gone: [missing](docs/missing.md).'
# Under every bash on the box, like cases 1 and 8: measuring the marker's run length peels it
# one character at a time with `${rest#"$ch"}`, and quote removal inside a pattern is one of
# the places 3.2 and 4.4+ have differed.
for interpreter in $BASHES; do
  case_ctx="$interpreter"
  run_check_with "$interpreter" "$ROOT"
  expect_rc 1 "$rc"
  # Line 8, not line 4: the broken link is the one in prose AFTER the fence closed.
  expect_out "README.md:8"
  expect_out "docs/missing.md"
  expect_out "is not a file or directory git lists"
  expect_out "1 broken link(s)"
done
case_ctx=""
end

# ==========================================================================================
# 19. a shorter run of the same character does not close the fence either
# ==========================================================================================
# The length half of CommonMark's close rule, which the character half alone does not give
# you: a four-backtick fence is the standard way to show three-backtick markdown, and a close
# rule that ignored run length would end the fence on the line being quoted.
begin "a three-backtick line inside a four-backtick fence is content: a close needs the run length"
case_ctx="broken link after the fence"
fixture fence_shorter_run
must append "$ROOT/README.md" '````text' '```' '````' '' 'Gone: [missing](docs/missing.md).'
run_check "$ROOT"
expect_rc 1 "$rc"
expect_out "README.md:8"
expect_out "docs/missing.md"
expect_out "1 broken link(s)"
# The other direction, and the sharper assertion of the two: the fence has to still be OPEN on
# the line after the short run, so a link there is content and goes unchecked. Exit code alone
# could not tell "the fence stayed open" from "parity happened to land right".
case_ctx="link inside the fence, after the short run"
fixture fence_shorter_run_inner
must append "$ROOT/README.md" '````text' '```' '[inner](docs/inner-missing.md)' '````'
run_check "$ROOT"
expect_rc 0 "$rc"
expect_out "1 link(s) checked"
expect_not_out "inner-missing.md"
# And the >= boundary: a LONGER run of the same character is a legal close (CommonMark),
# so the broken link after it must be seen. Pins -ge rather than -eq at the length
# comparison — an -eq mutant leaves the fence open and this variant is the only one
# that notices (the silent-skip direction).
case_ctx="longer same-character run closes the fence"
fixture fence_longer_run_close
must append "$ROOT/README.md" '```text' '````' '' 'Gone: [missing](docs/missing.md).'
run_check "$ROOT"
expect_rc 1 "$rc"
expect_out "docs/missing.md"
case_ctx=""
end

# ==========================================================================================
# 20. a target git lists but the working tree does not have
# ==========================================================================================
# The gate deliberately treats a `--cached` path as a valid link target even when it is not on
# disk (an unstaged `rm` must not make the gate cry "broken" — the header says so, and
# lint-shell.sh takes the same line). But its HEADINGS cannot be read from a file that is not
# there, and an anchor link therefore has to reach a verdict the gate owns, with the path in
# it, rather than a bare `tr: No such file or directory` from the redirect that would open it.
# The same fixture covers the source-side half of that rule: docs/guide.md is still in the
# index, so discovery still lists it, and the census counting one markdown file is what proves
# the scan skipped it rather than dying on it.
begin "an anchor into a tracked-but-deleted file reports the gate's own verdict, not a redirect error"
work_tree tracked_absent
must mkdir -p "$ROOT/docs"
must write "$ROOT/docs/guide.md" '# Guide' '' '## Usage' '' 'Prose.'
must write "$ROOT/README.md" '# Readme' '' 'See the [guide](docs/guide.md#usage).'
must gitc "$ROOT" add -A
must gitc "$ROOT" commit --quiet -m base
must rm "$ROOT/docs/guide.md"
run_check "$ROOT"
expect_rc 1 "$rc"
expect_out "README.md:3"
expect_out "docs/guide.md is not present in the working tree to read headings from"
expect_not_out "No such file or directory"
expect_not_out "could not read headings"
expect_out "across 1 markdown file(s)"
end

# ==========================================================================================

printf '\n%d passed, %d failed\n' "$passed" "$failed"
[ "$failed" = "0" ] || exit 1
