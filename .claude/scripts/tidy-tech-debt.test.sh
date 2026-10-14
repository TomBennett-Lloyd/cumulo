#!/usr/bin/env bash
# Test harness for tidy-tech-debt.sh, its neighbour in this directory (#634).
#
# `gh` is a stub on PATH answering from per-case fixture files and logging every call, and the
# ledger gate is a stub beside a copy of the script under test, so no case reaches GitHub and
# every case can assert what was asked.
#
# Usage: bash .claude/scripts/tidy-tech-debt.test.sh  (or `pnpm test:scripts`)
# Exit:  0 every case PASS, 1 at least one FAIL, 2 the harness itself broke.
set -uo pipefail

SCRIPTS=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd) || exit 2
TIDY="$SCRIPTS/tidy-tech-debt.sh"

# shellcheck source=./harness-lib.sh
. "$SCRIPTS/harness-lib.sh"
harness_init_tmp

must mkdir -p "$TMP_ROOT/bin"
cat >"$TMP_ROOT/bin/gh" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$STUB_LOG"
case "$1 $2" in
  "issue view")
    [ -f "$STUB_FIXTURES/state.$3" ] || { printf 'no such issue\n' >&2; exit 1; }
    cat "$STUB_FIXTURES/state.$3"
    ;;
  "issue list")
    case " $* " in
      *" --state closed "*) cat "$STUB_FIXTURES/closed.txt" ;;
      *" --state open "*) cat "$STUB_FIXTURES/open.txt" ;;
    esac
    ;;
  *) exit 99 ;;
esac
STUB
must chmod +x "$TMP_ROOT/bin/gh"
export PATH="$TMP_ROOT/bin:$PATH"

row() { # row <issue> — one redirect-table row
  printf '| Captured title %s | [#%s](https://github.com/o/r/issues/%s) |\n' "$1" "$1" "$1"
}

entry() { # entry <date> <title> <source> [omit-key]
  printf '## %s — %s\n\n' "$1" "$2"
  [ "${4-}" = "Where" ] || printf -- '- Where: a/b.ts\n'
  [ "${4-}" = "What" ] || printf -- '- What: a thing\n'
  [ "${4-}" = "Source" ] || printf -- '- Source: %s\n' "$3"
  printf '\n'
}

# new_case <name> <ledger-rc> -> ROOT, FIX, STUB_LOG, STUB_FIXTURES, with the tidy script and a
# stub ledger gate copied in.
new_case() {
  ROOT="$TMP_ROOT/$1"
  FIX="$ROOT/fixtures"
  export STUB_LOG="$ROOT/gh.log"
  export STUB_FIXTURES="$FIX"
  must mkdir -p "$ROOT/.claude/scripts" "$ROOT/docs" "$FIX"
  must cp "$TIDY" "$ROOT/.claude/scripts/tidy-tech-debt.sh"
  printf '#!/usr/bin/env bash\nprintf "ledger stub report\\n"\nexit %s\n' "$2" >"$ROOT/.claude/scripts/check-ledgers.sh"
  : >"$STUB_LOG"
  : >"$FIX/closed.txt"
  : >"$FIX/open.txt"
}

state() { printf '%s\n' "$2" >"$FIX/state.$1"; }

run() {
  capture bash "$ROOT/.claude/scripts/tidy-tech-debt.sh" "$ROOT"
}

head_of() {
  printf '# Tech-debt log\n\n## Captured-entry redirects\n\n| Captured entry | Now owned by |\n| --- | --- |\n'
}

# --- redirect rows ---------------------------------------------------------------------------

begin "a redirect row whose issue is closed is deleted; one whose issue is open is kept"
new_case rows 0
{
  head_of
  row 11
  row 12
  printf '\n'
} >"$ROOT/docs/tech-debt.md"
state 11 CLOSED
state 12 OPEN
run
expect_rc 0
expect_stdout "deleted redirect row"
if grep -q 'issues/11)' "$ROOT/docs/tech-debt.md"; then bad "closed row survived"; fi
grep -q 'issues/12)' "$ROOT/docs/tech-debt.md" || bad "open row was deleted"
end

begin "each issue number is asked for once per run, however many rows cite it"
new_case once 0
{
  head_of
  row 21
  row 21
  printf '\n'
} >"$ROOT/docs/tech-debt.md"
state 21 OPEN
run
expect_rc 0
[ "$(grep -c '^issue view 21 ' "$STUB_LOG")" = "1" ] || bad "expected one state query for #21; got: $(cat "$STUB_LOG")"
end

# --- entries ---------------------------------------------------------------------------------

begin "a closed entry that a closed issue quotes moves intact to Retired in the stated form"
new_case retire 0
{
  head_of
  printf '\n---\n\n'
  entry 2026-09-01 'The parser trusts its input' '#31 review pass 1'
  entry 2026-09-02 'A live finding' '#32 review pass 1'
} >"$ROOT/docs/tech-debt.md"
state 31 CLOSED
state 32 CLOSED
printf 'Fixes The parser trusts its input\n' >"$FIX/closed.txt"
run
expect_rc 0
expect_stdout "retired entry"
if grep -q '^## 2026-09-01' "$ROOT/docs/tech-debt.md"; then bad "retired entry still has its heading in place"; fi
grep -q '^## 2026-09-02 — A live finding$' "$ROOT/docs/tech-debt.md" || bad "an entry no closed issue quotes was moved"
grep -qE '^## Retired$' "$ROOT/docs/tech-debt.md" || bad "no Retired heading"
grep -qE '^- [0-9]{4}-[0-9]{2}-[0-9]{2} · 2026-09-01 — The parser trusts its input · #31$' "$ROOT/docs/tech-debt.md" ||
  bad "Retired line not in the stated form: $(tail -n3 "$ROOT/docs/tech-debt.md")"
end

begin "an entry an open issue still quotes, or whose Source is still open, stays in place"
new_case keep 0
{
  head_of
  printf '\n'
  entry 2026-09-01 'Quoted by an open issue' '#41 review'
  entry 2026-09-02 'Campaign still running' 'PR #42 (#43), pass 1'
} >"$ROOT/docs/tech-debt.md"
state 41 CLOSED
state 42 MERGED
state 43 OPEN
printf 'Quoted by an open issue\nCampaign still running\n' >"$FIX/closed.txt"
printf 'Quoted by an open issue\n' >"$FIX/open.txt"
cp "$ROOT/docs/tech-debt.md" "$ROOT/before.md"
run
expect_rc 0
cmp -s "$ROOT/before.md" "$ROOT/docs/tech-debt.md" || bad "file changed: $(diff "$ROOT/before.md" "$ROOT/docs/tech-debt.md")"
end

begin "a second run adds to an existing Retired block rather than starting another"
new_case again 0
{
  head_of
  printf '\n'
  entry 2026-09-01 'Second casualty' '#51 review'
  printf '## Retired\n\n- 2026-10-01 · 2026-08-01 — First casualty · #50\n'
} >"$ROOT/docs/tech-debt.md"
state 51 CLOSED
printf 'Second casualty\n' >"$FIX/closed.txt"
run
expect_rc 0
[ "$(grep -c '^## Retired$' "$ROOT/docs/tech-debt.md")" = "1" ] || bad "Retired heading duplicated"
grep -q 'First casualty · #50$' "$ROOT/docs/tech-debt.md" || bad "earlier Retired line lost"
grep -q 'Second casualty · #51$' "$ROOT/docs/tech-debt.md" || bad "new Retired line missing"
end

# --- reported, never edited --------------------------------------------------------------------

begin "ledger drift is printed verbatim and reported, and the file is not edited"
new_case drift 1
{
  head_of
  printf '\n'
  entry 2026-09-01 'An entry' '#61 review'
} >"$ROOT/docs/tech-debt.md"
state 61 OPEN
cp "$ROOT/docs/tech-debt.md" "$ROOT/before.md"
run
expect_rc 1
expect_stdout "ledger stub report"
expect_stdout "needs a human"
cmp -s "$ROOT/before.md" "$ROOT/docs/tech-debt.md" || bad "file changed on drift"
end

begin "a ledger blocker stops the run with exit 2 before anything is asked of gh"
new_case blocker 2
{
  head_of
  row 71
} >"$ROOT/docs/tech-debt.md"
state 71 CLOSED
cp "$ROOT/docs/tech-debt.md" "$ROOT/before.md"
run
expect_rc 2
cmp -s "$ROOT/before.md" "$ROOT/docs/tech-debt.md" || bad "file changed on a blocker"
[ ! -s "$STUB_LOG" ] || bad "gh was called after a ledger blocker: $(cat "$STUB_LOG")"
end

begin "a malformed entry is reported by line and title and left untouched, even when its Source is closed"
new_case malformed 0
{
  head_of
  printf '\n'
  entry 2026-09-01 'No what line' '#81 review' What
} >"$ROOT/docs/tech-debt.md"
state 81 CLOSED
printf 'No what line\n' >"$FIX/closed.txt"
cp "$ROOT/docs/tech-debt.md" "$ROOT/before.md"
run
expect_rc 1
expect_stdout "MALFORMED"
expect_stdout "No what line"
expect_stdout "lacks: What"
cmp -s "$ROOT/before.md" "$ROOT/docs/tech-debt.md" || bad "malformed entry was rewritten"
end

begin "gh failing is a blocker: exit 2 and no edit"
new_case ghfail 0
{
  head_of
  row 91
} >"$ROOT/docs/tech-debt.md"
cp "$ROOT/docs/tech-debt.md" "$ROOT/before.md"
run
expect_rc 2
expect_stderr "gh could not read #91"
cmp -s "$ROOT/before.md" "$ROOT/docs/tech-debt.md" || bad "file changed when gh failed"
end

begin "an unchanged file produces no diff and exit 0"
new_case clean 0
{
  head_of
  row 101
  printf '\n'
  entry 2026-09-01 'Healthy' '#102 review'
} >"$ROOT/docs/tech-debt.md"
state 101 OPEN
state 102 OPEN
cp "$ROOT/docs/tech-debt.md" "$ROOT/before.md"
run
expect_rc 0
expect_stdout "nothing needs a human"
cmp -s "$ROOT/before.md" "$ROOT/docs/tech-debt.md" || bad "clean file changed"
end

finish
