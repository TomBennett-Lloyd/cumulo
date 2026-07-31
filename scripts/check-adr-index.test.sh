#!/usr/bin/env bash
# Test harness for scripts/check-adr-index.sh.
#
# Self-contained on purpose (same shape as .claude/scripts/worktree-lifecycle.test.sh): no
# test framework, no network, no pnpm. Every fixture is a throwaway ADR directory under a
# single `mktemp -d` that a trap deletes on exit, so the drift cases — an unindexed ADR, an
# index row pointing at a deleted file — are exercised for real without ever mutating the
# repo's own docs/adr.
#
# One case deliberately runs the gate with NO argument, against the repo's real docs/adr:
# every other case pins ADR_DIR to a fixture, so without it the shipped default path could
# be broken and the suite would still be green (testing.md rule 7).
#
# Usage: bash scripts/check-adr-index.test.sh   (or `pnpm test:scripts`)
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
out=""
rc=0

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

bad() {
  printf '  ! %s\n' "$1" >&2
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

adr() { # adr <path> <title>
  printf '# %s\n\nStatus: Accepted\n' "$2" >"$1"
}

# index <dir> <row...> -> a README with prose above the index, matching the real one: the
# template link and a standards link live outside the "## Index" section and must be ignored.
index() {
  local dir="$1"
  shift
  {
    printf '# Architecture Decision Records\n\n'
    printf 'Format: copy `0000-template.md` -> `NNNN-short-title.md`. See\n'
    printf '[architecture.md](../standards/architecture.md) for when to write one.\n\n'
    printf '## Index\n\n'
    local row
    for row in "$@"; do printf '%s\n' "$row"; done
  } >"$dir/README.md"
}

run_check() { # run_check <args...>
  out=$(bash "$CHECK" "$@" 2>&1)
  rc=$?
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
# 9. duplicates in the index
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
# 10. two files claiming the same ADR number
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
# 11. the template is exempt, and only the template
# ==========================================================================================
begin "0000-template.md needs no index row"
fixture template
run_check "$DIR"
expect_rc 0 "$rc"
expect_not_out "0000-template.md"
end

# ==========================================================================================
# 12. a missing README
# ==========================================================================================
begin "a missing README.md fails the gate"
fixture no_readme
must rm "$DIR/README.md"
run_check "$DIR"
expect_rc 1 "$rc"
expect_out "no index file at"
end

# ==========================================================================================
# 13. a README with no index section
# ==========================================================================================
begin "a README without an '## Index' section fails the gate"
fixture no_section
must printf '# Architecture Decision Records\n\nProse only.\n' >"$DIR/README.md"
run_check "$DIR"
expect_rc 1 "$rc"
expect_out "has no '## Index' section"
end

# ==========================================================================================
# 14. an empty index section
# ==========================================================================================
begin "an empty '## Index' section fails the gate"
fixture empty_section
index "$DIR"
run_check "$DIR"
expect_rc 1 "$rc"
expect_out "lists no ADRs"
end

# ==========================================================================================
# 15. no ADR files at all — the wrong-directory case
# ==========================================================================================
# Green-by-absence is the failure mode a docs gate is most likely to die of: point it at a
# directory that has been moved or renamed and "nothing to check" must not read as "fine".
begin "a directory with no ADR files fails instead of passing vacuously"
fixture empty_dir
must rm "$DIR/0001-service-boundaries.md" "$DIR/0002-storage-split.md"
index "$DIR"
run_check "$DIR"
expect_rc 1 "$rc"
expect_out "no ADR files (NNNN-*.md, excluding 0000-template.md) found"
end

# ==========================================================================================
# 16. a directory that is not there at all
# ==========================================================================================
begin "a nonexistent ADR directory exits 2, not 1"
run_check "$TMP_ROOT/does-not-exist"
expect_rc 2 "$rc"
expect_out "not a directory"
end

# ==========================================================================================

printf '\n%d passed, %d failed\n' "$passed" "$failed"
[ "$failed" = "0" ] || exit 1
