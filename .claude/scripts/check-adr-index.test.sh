#!/usr/bin/env bash
# Test harness for check-adr-index.sh, its neighbour in this directory.
#
# Self-contained on purpose (same shape as worktree-lifecycle.test.sh next door): no
# test framework, no network, no pnpm. Every fixture is a throwaway ADR directory under a
# single `mktemp -d` that a trap deletes on exit, so the drift cases — an unindexed ADR, an
# index row pointing at a deleted file — are exercised for real without ever mutating the
# repo's own docs/adr.
#
# One case deliberately runs the gate with NO argument, against the repo's real docs/adr:
# every other case pins ADR_DIR to a fixture, so without it the shipped default path could
# be broken and the suite would still be green (testing.md rule 7).
#
# Usage: bash .claude/scripts/check-adr-index.test.sh   (or `pnpm test:scripts`)
# Exit:  0 every case PASS, 1 at least one FAIL, 2 the harness itself broke.
set -uo pipefail

SCRIPTS=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd) || exit 2
CHECK="$SCRIPTS/check-adr-index.sh"

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

# The gate has to survive the oldest bash it can meet, and the interpreter is not a detail:
# under `set -u`, bash 3.2 (which macOS ships as /bin/bash) aborts on an empty array's `[@]`
# where 4.4+ shrugs. So cases that turn on that difference run under every distinct bash on
# the box, not just whichever one happens to be first on PATH.
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

# fixture <name> -> sets DIR to a fresh, *consistent* ADR directory: two ADRs, a template,
# and a README whose prose links the template (which the index must not have to list).
# Each case then breaks exactly one thing, so a failure names its own cause.
fixture() {
  DIR="$TMP_ROOT/$1"
  must mkdir -p "$DIR"
  must adr "$DIR/0000-template.md" "Template"
  must adr "$DIR/0001-service-boundaries.md" "Service boundaries"
  must adr "$DIR/0002-storage-split.md" "Storage split"
  index "$DIR" \
    '- [0001 — Service boundaries](0001-service-boundaries.md)' \
    '- [0002 — Storage split](0002-storage-split.md)'
}

# The header is the real one's, not a sketch of it: the gate reads `Status:` now, so a
# fixture ADR whose header does not match what `docs/adr/0000-template.md` prescribes would
# make every case a status case by accident.
adr() { # adr <path> <title> [status]   status defaults to the repo's `accepted`
  printf '# %s\n\n- **Status:** %s\n- **Date:** 2026-07-31\n' "$2" "${3:-accepted}" >"$1"
}

adr_without_status() { # adr_without_status <path> <title>
  printf '# %s\n\n- **Date:** 2026-07-31\n' "$2" >"$1"
}

# index <dir> <row...> -> a README with prose above the index, matching the real one: the
# template link and a standards link live outside the "## Index" section and must be ignored.
index() {
  local dir="$1"
  shift
  {
    # A quoted heredoc, not printf: this prose is literal, and it carries
    # backticks and brackets that a single-quoted printf argument makes look
    # like a command substitution somebody forgot to double-quote (SC2016).
    # <<'EOF' says "no expansion here" in the syntax itself, so the reader and
    # the shell linter agree with each other for free.
    cat <<'EOF'
# Architecture Decision Records

Format: copy `0000-template.md` -> `NNNN-short-title.md`. See
[architecture.md](../standards/architecture.md) for when to write one.

## Index

EOF
    local row
    for row in "$@"; do printf '%s\n' "$row"; done
  } >"$dir/README.md"
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
begin "check-adr-index.sh parses (bash -n)"
if ! syntax=$(bash -n "$CHECK" 2>&1); then
  bad "check-adr-index.sh failed bash -n: $syntax"
fi
end

# ==========================================================================================
# 2. the real repo, via the shipped default path (no argument)
# ==========================================================================================
# The production configuration: no ADR_DIR override, so this is the only case that can catch
# a broken default path — and it is what `pnpm verify` actually runs.
begin "the repo's own docs/adr passes with no argument"
run_check
expect_rc 0 "$rc"
expect_out "check-adr-index: OK"
end

# ==========================================================================================
# 3. a consistent fixture passes, and out-of-section links are ignored
# ==========================================================================================
begin "a consistent index passes; prose links outside the section are not index rows"
fixture consistent
run_check "$DIR"
expect_rc 0 "$rc"
expect_out "OK — 2 ADRs"
# ../standards/architecture.md does not exist under the fixture dir, and the template is
# unindexed: both are fine, because neither is an index row.
expect_not_out "ERROR"
end

# ==========================================================================================
# 4. ACCEPTANCE (a): an ADR file that nothing indexes
# ==========================================================================================
begin "an unindexed ADR file fails the gate"
fixture unindexed
must adr "$DIR/9999-test.md" "Test"
run_check "$DIR"
expect_rc 1 "$rc"
expect_out "ADR file 9999-test.md is not listed in the index"
# The other direction must stay quiet: this fixture has no dangling row.
expect_not_out "does not exist"
end

# ==========================================================================================
# 5. ACCEPTANCE (b): an index row pointing at a file that is not there
# ==========================================================================================
begin "an index row linking a nonexistent file fails the gate"
fixture dangling
index "$DIR" \
  '- [0001 — Service boundaries](0001-service-boundaries.md)' \
  '- [0002 — Storage split](0002-storage-split.md)' \
  '- [0003 — PV model runtime](0003-pv-model-runtime.md)'
run_check "$DIR"
expect_rc 1 "$rc"
expect_out "index row 0003 links to a file that does not exist: 0003-pv-model-runtime.md"
end

# ==========================================================================================
# 6. a renamed file: both directions fire at once
# ==========================================================================================
# The realistic drift — `git mv` on an ADR — is not one direction or the other, it is both,
# and the report has to name the new file as well as the stale row.
begin "a renamed ADR file reports the stale row and the unindexed file"
fixture renamed
must mv "$DIR/0002-storage-split.md" "$DIR/0002-storage-boundaries.md"
run_check "$DIR"
expect_rc 1 "$rc"
expect_out "index row 0002 links to a file that does not exist: 0002-storage-split.md"
expect_out "ADR file 0002-storage-boundaries.md is not listed in the index"
end

# ==========================================================================================
# 7. a row whose number contradicts the file it links
# ==========================================================================================
begin "an index row numbered differently from its target file fails the gate"
fixture misnumbered
index "$DIR" \
  '- [0001 — Service boundaries](0001-service-boundaries.md)' \
  '- [0003 — Storage split](0002-storage-split.md)'
run_check "$DIR"
expect_rc 1 "$rc"
expect_out "index row 0003 links to 0002-storage-split.md, which is not numbered 0003"
# The file is linked, so it is not missing from the index — reporting it as unindexed as
# well would be noise. One fault, one error.
expect_not_out "is not listed in the index"
end

# ==========================================================================================
# 8. an unreadable row is an error, never a skip
# ==========================================================================================
# A bullet the parser cannot read must fail loudly: treating it as "not a row" would make
# every unindexed-file check downstream of it pass for the wrong reason.
begin "a malformed index row fails instead of being skipped"
fixture malformed
index "$DIR" \
  '- [0001 — Service boundaries](0001-service-boundaries.md)' \
  '- 0002 Storage split'
run_check "$DIR"
expect_rc 1 "$rc"
expect_out "index row is not in the '- [NNNN — Title](NNNN-slug.md)' form: - 0002 Storage split"
expect_out "ADR file 0002-storage-split.md is not listed in the index"
end

# ==========================================================================================
# 9. an indented row is still a row
# ==========================================================================================
# Markdown lets a list item carry leading whitespace, and editors and formatters add it. A
# gate that only recognised a column-1 hyphen would file such a row under "prose" and drop
# it — the same green-by-skipping failure as case 8, reached by a whitespace character.
begin "an indented index row is checked, not read as prose"
fixture indented_row
index "$DIR" \
  '- [0001 — Service boundaries](0001-service-boundaries.md)' \
  '- [0002 — Storage split](0002-storage-split.md)' \
  '  - [0009 — Gone](0009-gone.md)' \
  '  - 0010 no link at all'
run_check "$DIR"
expect_rc 1 "$rc"
expect_out "index row 0009 links to a file that does not exist: 0009-gone.md"
expect_out "index row is not in the"
expect_out "- 0010 no link at all"
end

# ==========================================================================================
# 10. '*' and '+' bullet markers are rows too
# ==========================================================================================
begin "'*' and '+' bullet markers are index rows like '-'"
fixture other_markers
index "$DIR" \
  '* [0001 — Service boundaries](0001-service-boundaries.md)' \
  '+ [0002 — Storage split](0002-storage-split.md)' \
  '* [0009 — Gone](0009-gone.md)'
run_check "$DIR"
expect_rc 1 "$rc"
expect_out "index row 0009 links to a file that does not exist: 0009-gone.md"
# The other two rows are accepted as rows, not merely noticed: if they were skipped, both
# ADR files would be reported unindexed.
expect_not_out "is not listed in the index"
end

# ==========================================================================================
# 11. duplicates in the index
# ==========================================================================================
begin "a duplicated index row fails the gate"
fixture dupe_row
index "$DIR" \
  '- [0001 — Service boundaries](0001-service-boundaries.md)' \
  '- [0002 — Storage split](0002-storage-split.md)' \
  '- [0002 — Storage split](0002-storage-split.md)'
run_check "$DIR"
expect_rc 1 "$rc"
expect_out "index lists 0002-storage-split.md more than once"
expect_out "index uses ADR number 0002 more than once"
end

# ==========================================================================================
# 12. two files claiming the same ADR number
# ==========================================================================================
# ADR numbers are the identity of a decision; two files under 0002 means one of them is
# unreachable by number no matter what the index says.
begin "two ADR files sharing a number fail the gate"
fixture dupe_number
must adr "$DIR/0002-storage-choices.md" "Storage choices"
run_check "$DIR"
expect_rc 1 "$rc"
expect_out "two ADR files share number 0002"
end

# ==========================================================================================
# 13. the template is exempt, and only the template
# ==========================================================================================
begin "0000-template.md needs no index row"
fixture template
run_check "$DIR"
expect_rc 0 "$rc"
expect_not_out "0000-template.md"
end

# ==========================================================================================
# 14. a missing README
# ==========================================================================================
begin "a missing README.md fails the gate"
fixture no_readme
must rm "$DIR/README.md"
run_check "$DIR"
expect_rc 1 "$rc"
expect_out "no index file at"
end

# ==========================================================================================
# 15. a README with no index section
# ==========================================================================================
begin "a README without an '## Index' section fails the gate"
fixture no_section
must printf '# Architecture Decision Records\n\nProse only.\n' >"$DIR/README.md"
run_check "$DIR"
expect_rc 1 "$rc"
expect_out "has no '## Index' section"
end

# ==========================================================================================
# 16. an empty index section
# ==========================================================================================
begin "an empty '## Index' section fails the gate"
fixture empty_section
index "$DIR"
run_check "$DIR"
expect_rc 1 "$rc"
expect_out "lists no ADRs"
end

# ==========================================================================================
# 17. no ADR files at all — the wrong-directory case
# ==========================================================================================
# Green-by-absence is the failure mode a docs gate is most likely to die of: point it at a
# directory that has been moved or renamed and "nothing to check" must not read as "fine".
begin "a directory with no ADR files fails instead of passing vacuously"
fixture empty_dir
# The template goes too. Leave it behind and the NNNN-*.md glob still matches something, so
# the empty-glob path — the only path this guard exists for — is never taken, and the case
# proves nothing about the scenario it is named after.
must rm "$DIR/0000-template.md" "$DIR/0001-service-boundaries.md" "$DIR/0002-storage-split.md"
index "$DIR"
for interpreter in $BASHES; do
  case_ctx="$interpreter"
  run_check_with "$interpreter" "$DIR"
  expect_rc 1 "$rc"
  expect_out "no ADR files (NNNN-*.md, excluding 0000-template.md) found"
  # Not an academic assertion: on bash 3.2 the array expansion aborted the script here,
  # before the guard above could report anything.
  expect_not_out "unbound variable"
done
case_ctx=""
end

# ==========================================================================================
# 18. a directory that is not there at all
# ==========================================================================================
begin "a nonexistent ADR directory exits 2, not 1"
run_check "$TMP_ROOT/does-not-exist"
expect_rc 2 "$rc"
expect_out "not a directory"
end

# ==========================================================================================
# 19. the extended grammar's valid forms
# ==========================================================================================
# One case for everything the grammar is supposed to accept, because the risk with a
# loosened row regex and a new per-file check is not that they reject too little — cases
# 20-24 cover that — but that a stricter reading of them makes the legal forms unusable.
begin "an annotated row, an unannotated row and the full Status vocabulary all pass"
fixture annotated
must adr "$DIR/0001-service-boundaries.md" "Service boundaries" "superseded by 0002"
must adr "$DIR/0002-storage-split.md" "Storage split" "proposed"
index "$DIR" \
  '- [0001 — Service boundaries](0001-service-boundaries.md) — superseded by 0002' \
  '- [0002 — Storage split](0002-storage-split.md)'
run_check "$DIR"
expect_rc 0 "$rc"
expect_out "OK — 2 ADRs"
expect_not_out "ERROR"
end

# ==========================================================================================
# 20. a malformed annotation is still a malformed row
# ==========================================================================================
# The point of an *optional, structured* suffix is that the trailing anchor still bites. If
# the grammar had been loosened to `.*$` instead, both variants below would sail through and
# the row's shape would stop being checked at all.
begin "a malformed row annotation fails instead of being waved through"
fixture bad_annotation
case_ctx="no em-dash separator"
index "$DIR" \
  '- [0001 — Service boundaries](0001-service-boundaries.md)' \
  '- [0002 — Storage split](0002-storage-split.md) superseded by 0001'
run_check "$DIR"
expect_rc 1 "$rc"
expect_out "index row is not in the"
# Unreadable rows credit nothing: the target must still be reported unindexed (case 8).
expect_out "ADR file 0002-storage-split.md is not listed in the index"
case_ctx="separator with nothing after it"
index "$DIR" \
  '- [0001 — Service boundaries](0001-service-boundaries.md)' \
  '- [0002 — Storage split](0002-storage-split.md) — '
run_check "$DIR"
expect_rc 1 "$rc"
expect_out "index row is not in the"
expect_out "ADR file 0002-storage-split.md is not listed in the index"
case_ctx=""
end

# ==========================================================================================
# 21. an ADR carrying no Status at all
# ==========================================================================================
begin "an ADR file with no Status line fails the gate"
fixture no_status
must adr_without_status "$DIR/0002-storage-split.md" "Storage split"
run_check "$DIR"
expect_rc 1 "$rc"
expect_out "ADR file 0002-storage-split.md has no 'Status:' line with a value"
# The file is indexed and the index is intact: this is the only fault in the fixture.
expect_not_out "is not listed in the index"
end

# ==========================================================================================
# 22. a Status outside the template's vocabulary
# ==========================================================================================
# Both variants matter. A word nobody defined ("draft") is the obvious one; a capitalised
# spelling of a word that *is* defined is the one that erodes the vocabulary quietly, since
# each variant reads fine on its own and only the set stops being machine-readable.
begin "an ADR Status outside the template's vocabulary fails the gate"
fixture unknown_status
case_ctx="undefined word"
must adr "$DIR/0002-storage-split.md" "Storage split" "draft"
run_check "$DIR"
expect_rc 1 "$rc"
expect_out "ADR file 0002-storage-split.md has Status 'draft'"
case_ctx="wrong case"
must adr "$DIR/0002-storage-split.md" "Storage split" "Accepted"
run_check "$DIR"
expect_rc 1 "$rc"
expect_out "ADR file 0002-storage-split.md has Status 'Accepted'"
case_ctx=""
end

# ==========================================================================================
# 23. a Status superseded by an ADR that is not there
# ==========================================================================================
begin "a Status naming a nonexistent superseding ADR fails the gate"
fixture status_supersession
case_ctx="number nobody has written yet"
must adr "$DIR/0002-storage-split.md" "Storage split" "superseded by 0009"
run_check "$DIR"
expect_rc 1 "$rc"
expect_out "the Status of 0002-storage-split.md says 'superseded by 0009', but no ADR 0009 exists"
case_ctx="the template's own number"
# 0000-template.md is a form, not a decision. It is on disk, so a resolver that only globbed
# for NNNN-*.md would accept this — and an ADR "superseded by the template" means nothing.
must adr "$DIR/0002-storage-split.md" "Storage split" "superseded by 0000"
run_check "$DIR"
expect_rc 1 "$rc"
expect_out "says 'superseded by 0000', but no ADR 0000 exists"
case_ctx=""
end

# ==========================================================================================
# 24. an index annotation superseded by an ADR that is not there
# ==========================================================================================
# The row-level twin of case 23: the annotation is free text to the row grammar, so without
# this cross-check the index could announce a replacement decision that was never written.
begin "an index annotation naming a nonexistent superseding ADR fails the gate"
fixture annotation_supersession
index "$DIR" \
  '- [0001 — Service boundaries](0001-service-boundaries.md) — superseded by 0009' \
  '- [0002 — Storage split](0002-storage-split.md)'
run_check "$DIR"
expect_rc 1 "$rc"
expect_out "the annotation on index row 0001 says 'superseded by 0009', but no ADR 0009 exists"
# The row itself is well-formed and its target exists — only the pointer is wrong.
expect_not_out "index row is not in the"
expect_not_out "is not listed in the index"
end

# ==========================================================================================

printf '\n%d passed, %d failed\n' "$passed" "$failed"
[ "$failed" = "0" ] || exit 1
