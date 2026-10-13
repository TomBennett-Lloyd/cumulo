#!/usr/bin/env bash
# Test harness for check-ledgers.sh, its neighbour in this directory.
#
# The assertion vocabulary is harness-lib.sh next door; the fixtures are real git
# repositories, built the way sweep-report.test.sh builds its own, because the
# subject's whole input is a ledger plus what `git grep` says about a tree, and a
# stub for git is a stub for the thing under test.
#
# What this harness has to be able to fail on:
#
#   - The gate reds when it should. A tracked file, and an untracked one, that the
#     sweep returns and the ledger does not classify (cases 17-18); a listed
#     carrier the sweep stopped returning (21); the owner itself no longer
#     returned (23). Each asserts the exit code AND the substring that names what
#     drifted, so a gate that reds for the wrong reason is a red case.
#   - The gate does not red when it should not. The green fixture (16), an ignored
#     file (19), an excluded path that stopped matching (22), and the shipped
#     default root (25).
#   - Refusals are refusals, not passes: every malformed ledger and every broken
#     sweep is exit 2, and blockers outrank drift (24).
#
# The needle FIXTURE_LEDGER_NEEDLE occurs nowhere else in the repository, so a
# fixture hit is never also a hit on the real tree.
#
# One case (25) deliberately runs the gate with NO argument, against the real repo:
# every other case pins REPO_ROOT to a fixture, so without it the shipped default
# path — and the shipped ledgers' own paths — could be broken and the suite green
# (testing.md rule 7).
#
# Usage: bash .claude/scripts/check-ledgers.test.sh  (or `pnpm test:scripts`)
# Exit:  0 every case PASS, 1 at least one FAIL, 2 the harness itself broke.
set -uo pipefail

SCRIPTS=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd) || exit 2
CHECK="$SCRIPTS/check-ledgers.sh"

# shellcheck source=./harness-lib.sh
. "$SCRIPTS/harness-lib.sh"
harness_init_tmp

NEEDLE="FIXTURE_LEDGER_NEEDLE"
ROOT=""
LEDGER=""

gitc() {
  local dir="$1"
  shift
  git -C "$dir" -c user.email=test@test -c user.name=test -c commit.gpgsign=false "$@"
}

commit_all() {
  must gitc "$ROOT" add -A
  must gitc "$ROOT" commit --quiet -m change
}

# fixture <name> -> ROOT, a fresh repo one commit deep on main, consistent: the ledger lists
# src/carrier.ts and excludes docs/snapshot.md; docs/narration.md carries the needle but is out
# of scope; ignored.txt is gitignored.
fixture() {
  ROOT="$TMP_ROOT/$1"
  LEDGER="$ROOT/.claude/ledgers/fixture-claim.ledger"
  must mkdir -p "$ROOT/.claude/ledgers" "$ROOT/docs" "$ROOT/src"
  must git init --quiet -b main "$ROOT"
  must printf '%s\n' \
    '# A fixture ledger.' \
    'owner: docs/owner.md' \
    'claim: the fixture value' \
    "sweep: $NEEDLE" \
    'scope: :!docs/narration.md' \
    'carrier: src/carrier.ts' \
    'excluded: docs/snapshot.md' \
    >"$LEDGER"
  must printf '%s\n' \
    "The fixture value is $NEEDLE." \
    'Its ledger is .claude/ledgers/fixture-claim.ledger.' \
    >"$ROOT/docs/owner.md"
  must printf '%s\n' "export const carrier = '$NEEDLE';" >"$ROOT/src/carrier.ts"
  must printf '%s\n' "A snapshot of $NEEDLE." >"$ROOT/docs/snapshot.md"
  must printf '%s\n' "Narration quoting $NEEDLE." >"$ROOT/docs/narration.md"
  must printf '%s\n' 'ignored.txt' >"$ROOT/.gitignore"
  commit_all
}

run() { capture bash "$CHECK" "$ROOT"; }

# --- invocation -------------------------------------------------------------------------------

begin "parses under every bash on the box"
expect_parses "$CHECK"
end

begin "--help exits 0 and prints the usage line"
capture bash "$CHECK" --help
expect_rc 0
expect_stdout "Usage: bash .claude/scripts/check-ledgers.sh"
end

begin "a root that is not a git repository is refused (exit 2)"
must mkdir -p "$TMP_ROOT/plain"
capture bash "$CHECK" "$TMP_ROOT/plain"
expect_rc 2
expect_stderr "not the top of a git repository"
end

# --- refusals ---------------------------------------------------------------------------------

begin "a missing .claude/ledgers directory is refused, not passed (exit 2)"
fixture c4
must rm -rf "$ROOT/.claude/ledgers"
run
expect_rc 2
expect_stderr "no .claude/ledgers directory"
end

begin "an empty .claude/ledgers directory is refused — green by absence is not green (exit 2)"
fixture c5
must rm "$LEDGER"
run
expect_rc 2
expect_stderr ".claude/ledgers is empty"
end

begin "a file not named <id>.ledger with id in [a-z0-9-] is refused (exit 2)"
for bad_name in Bad_Name.ledger notes.txt; do
  case_ctx="$bad_name"
  fixture "c6-$bad_name"
  must cp "$LEDGER" "$ROOT/.claude/ledgers/$bad_name"
  run
  expect_rc 2
  expect_stderr "$bad_name"
  expect_stderr "not a regular file named <id>.ledger"
done
case_ctx=""
end

begin "an unknown key is refused by file and line (exit 2)"
fixture c7
must printf '%s\n' 'carriers: src/carrier.ts' >>"$LEDGER"
line_no=$(wc -l <"$LEDGER" | tr -d ' ')
run
expect_rc 2
expect_stderr "fixture-claim.ledger:$line_no:"
expect_stderr "unknown key 'carriers'"
end

begin "a missing owner, claim or sweep line is refused (exit 2)"
for key in owner claim sweep; do
  case_ctx="no $key"
  fixture "c8-$key"
  must perl -pi -e "s/^$key: .*\n//" "$LEDGER"
  fixture_lacks "$LEDGER" "$key:"
  run
  expect_rc 2
  expect_stderr "needs exactly one $key: line"
done
case_ctx=""
end

begin "a second sweep: line is refused (exit 2)"
fixture c9
must printf '%s\n' 'sweep: something_else' >>"$LEDGER"
run
expect_rc 2
expect_stderr "needs exactly one sweep: line, found 2"
end

begin "a ledger with no carrier: line is refused (exit 2)"
fixture c10
must perl -pi -e 's/^carrier: .*\n//' "$LEDGER"
fixture_lacks "$LEDGER" "carrier:"
run
expect_rc 2
expect_stderr "needs at least one carrier: line"
end

begin "a path outside the alphabet is refused (exit 2)"
fixture c11
must perl -pi -e 's/^carrier: src\/carrier\.ts/carrier: src\/car rier.ts/' "$LEDGER"
fixture_has "$LEDGER" "carrier: src/car rier.ts"
run
expect_rc 2
expect_stderr "outside the alphabet"
end

begin "a path listed as both carrier and excluded is refused (exit 2)"
fixture c12
must printf '%s\n' 'excluded: src/carrier.ts' >>"$LEDGER"
run
expect_rc 2
expect_stderr "is listed as both carrier: and excluded:"
end

begin "an owner that does not exist in the tree is refused (exit 2)"
fixture c13
must perl -pi -e 's/^owner: .*/owner: docs\/missing.md/' "$LEDGER"
fixture_has "$LEDGER" "owner: docs/missing.md"
run
expect_rc 2
expect_stderr "owner does not exist in the tree"
end

begin "an owner that does not name its ledger file by repo-relative path is refused (exit 2)"
fixture c14
must perl -pi -e 's/\.claude\/ledgers\/fixture-claim\.ledger/the ledger/' "$ROOT/docs/owner.md"
fixture_lacks "$ROOT/docs/owner.md" ".claude/ledgers/fixture-claim.ledger"
run
expect_rc 2
expect_stderr "does not name .claude/ledgers/fixture-claim.ledger by path"
end

begin "an invalid pattern is a broken check, not a clean tree (exit 2)"
fixture c15
must perl -pi -e 's/^sweep: .*/sweep: (/' "$LEDGER"
fixture_has "$LEDGER" "sweep: ("
run
expect_rc 2
expect_stderr "the sweep did not run cleanly"
end

# --- verdicts ---------------------------------------------------------------------------------

begin "green: owner, carrier and excluded all returned; the ledger's own sweep: line is not an unlisted hit; the OK line names counts, not the pattern (exit 0)"
fixture c16
run
expect_rc 0
expect_stdout "check-ledgers: OK — 1 ledger(s)"
expect_stdout "1 carrier(s) returned, 0 unlisted hit(s)"
expect_not_stdout "$NEEDLE"
expect_not_stderr "unlisted hit"
end

begin "red: a tracked file the sweep returns and the ledger does not classify (exit 1)"
fixture c17
must printf '%s\n' "A new carrier: $NEEDLE." >"$ROOT/docs/new-carrier.md"
commit_all
run
expect_rc 1
expect_stderr "fixture-claim"
expect_stderr "docs/new-carrier.md"
expect_stderr "unlisted hit"
end

begin "red: an untracked file the sweep returns counts too (exit 1)"
fixture c18
must printf '%s\n' "A new carrier: $NEEDLE." >"$ROOT/docs/new-carrier.md"
run
expect_rc 1
expect_stderr "fixture-claim"
expect_stderr "docs/new-carrier.md"
expect_stderr "unlisted hit"
end

begin "an ignored file is not swept (exit 0)"
fixture c19
must printf '%s\n' "$NEEDLE" >"$ROOT/ignored.txt"
run
expect_rc 0
expect_stdout "check-ledgers: OK"
end

begin "scope: is honoured — removing it surfaces the narration hit (exit 1)"
fixture c20
must perl -pi -e 's/^scope: .*\n//' "$LEDGER"
fixture_lacks "$LEDGER" "scope:"
run
expect_rc 1
expect_stderr "docs/narration.md"
end

begin "red: a listed carrier the sweep no longer returns (exit 1)"
fixture c21
must perl -pi -e "s/$NEEDLE/gone/" "$ROOT/src/carrier.ts"
fixture_lacks "$ROOT/src/carrier.ts" "$NEEDLE"
run
expect_rc 1
expect_stderr "carrier not returned"
expect_stderr "src/carrier.ts"
end

begin "an excluded path the sweep no longer returns still passes (exit 0)"
fixture c22
must perl -pi -e "s/$NEEDLE/gone/" "$ROOT/docs/snapshot.md"
fixture_lacks "$ROOT/docs/snapshot.md" "$NEEDLE"
run
expect_rc 0
expect_stdout "check-ledgers: OK"
end

begin "red: the owner itself is no longer returned (exit 1)"
fixture c23
must perl -pi -e "s/$NEEDLE/gone/" "$ROOT/docs/owner.md"
fixture_lacks "$ROOT/docs/owner.md" "$NEEDLE"
fixture_has "$ROOT/docs/owner.md" ".claude/ledgers/fixture-claim.ledger"
run
expect_rc 1
expect_stderr "owner not returned"
expect_stderr "docs/owner.md"
end

begin "blockers outrank drift — a malformed second ledger beside a drifted first one exits 2"
fixture c24
must printf '%s\n' "A new carrier: $NEEDLE." >"$ROOT/docs/new-carrier.md"
must printf '%s\n' 'owner: docs/owner.md' 'claim: a second value' 'sweep: (' 'carrier: src/carrier.ts' >"$ROOT/.claude/ledgers/zzz-second.ledger"
must printf '%s\n' '.claude/ledgers/zzz-second.ledger' >>"$ROOT/docs/owner.md"
run
expect_rc 2
expect_stderr "BLOCKED zzz-second"
expect_not_stderr "ERROR"
end

begin "the shipped default root: no argument runs against this repository and passes (exit 0)"
capture bash "$CHECK"
expect_rc 0
expect_stdout "check-ledgers: OK"
end

finish
