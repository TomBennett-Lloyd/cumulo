#!/usr/bin/env bash
# Test harness for the shell lint gate (.claude/scripts/lint-shell.sh).
#
# The gate's exit codes are a three-way contract, and the interesting failure is the
# middle one: 0 clean, 1 shellcheck found something, 2 the GATE ITSELF is broken and
# no verdict was reached. `rm foo.sh` without staging the deletion left a path in the
# index that is not in the working tree, and shellcheck exits 2 on a file it cannot
# open — so an ordinary uncommitted delete used to red `pnpm verify` with "the gate is
# broken", which is both wrong and unactionable. These cases pin the fix.
#
# Since #502 the gate also holds the installed linter to the version declared in the
# pin file next door, and cases 6-9 cover that arm. (A comment may not open with the
# tool's own name — `#` plus it is how a DIRECTIVE is spelled, and a sentence there is
# SC1072/SC1073.) They need no seam in the shipped
# gate, which is the point of resolving the pin beside the script: every fixture
# carries its own .claude/scripts/shellcheck-pin.sh, so a case picks the pin it wants
# by writing that file. `write_pin` below is what every fixture gets by default —
# the version ACTUALLY installed on the machine running the harness, so the cases
# that are not about the pin behave identically wherever they run.
#
# Self-contained on the same terms as worktree-lifecycle.test.sh: no framework beyond
# the shared vocabulary in harness-lib.sh next door, no network, one `mktemp -d` that a
# trap removes, and every fixture is a throwaway git repo, so no case can mutate the
# repository the harness ships in. Case 1 is the one that reads it: the gate is run,
# unmodified and unredirected, over this very repository — analysis only, nothing written.
#
# Usage: bash .claude/scripts/lint-shell.test.sh   (or `pnpm test:scripts`)
# Exit:  0 every case PASS, 1 at least one FAIL, 2 the harness itself broke.
set -uo pipefail
export PATH="/opt/homebrew/bin:$PATH"

SCRIPTS=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd) || exit 2

# shellcheck source=./harness-lib.sh
. "$SCRIPTS/harness-lib.sh"

# The gate under test, overridable so the same cases can be run against an older
# revision of the gate as a negative control (testing.md rule 4: a regression test is
# only worth its line count if it has been seen to fail on the pre-fix code):
#
#   git show <rev>:.claude/scripts/lint-shell.sh >/tmp/pre.sh
#   LINT_SHELL_GATE=/tmp/pre.sh bash .claude/scripts/lint-shell.test.sh
#
# Unset — how `pnpm test:scripts` runs it — is the shipped gate.
GATE=${LINT_SHELL_GATE:-$SCRIPTS/lint-shell.sh}

# Read once, and refused rather than defaulted: every fixture's pin is written from this,
# so a harness that could not read it would silently test a gate pinned to the empty
# string — which is the mismatch arm, wearing every other case's name.
INSTALLED_VERSION=$(shellcheck --version 2>/dev/null | awk '/^version:/ {print $2}')
if [ -z "$INSTALLED_VERSION" ]; then
  printf 'FATAL cannot read an installed shellcheck version — this harness runs the real linter\n' >&2
  exit 2
fi

harness_init_tmp

# --- fixtures ----------------------------------------------------------------------

# Identity is passed per-command: the harness must not depend on (or write) any git config.
gitc() {
  local dir="$1"
  shift
  git -C "$dir" -c user.email=test@test -c user.name=test -c commit.gpgsign=false "$@"
}

clean_script() { # clean_script <path> — a script shellcheck has nothing to say about
  cat >"$1" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'ok\n'
EOF
}

dirty_script() { # dirty_script <path> — one unquoted expansion, i.e. SC2086
  cat >"$1" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
target=$1
cat $target
EOF
}

# write_pin <scripts-dir> <version> — the pin file the gate reads from beside itself.
# Shellcheck-clean on its own terms, because it is discovered and linted like any other
# *.sh in the fixture: the shell directive is what a shebang-less fragment needs, and the
# export is what keeps the assignment off SC2034.
write_pin() {
  cat >"$1/shellcheck-pin.sh" <<EOF
# shellcheck shell=bash
export SHELLCHECK_PIN_VERSION=$2
EOF
}

# fixture <name> -> sets ROOT to a fresh single-commit repo under $TMP_ROOT holding the
# gate under test at its real path and a pin naming the installed shellcheck, plus
# keep.sh and doomed.sh. The gate is COPIED IN rather than run from outside: the gate
# resolves its own repo with `rev-parse --show-toplevel` and its own pin with
# `dirname "${BASH_SOURCE[0]}"`, so a fixture that carries its own copies is both
# realistic and the thing that makes swapping in an older revision a one-line change.
#
# The pin counts toward the census, which is why the per-case counts below are one
# higher than the scripts a reader can see named: it is a *.sh in the tree like any
# other, and a gate that skipped its own configuration file would be lying about scope.
fixture() {
  ROOT="$TMP_ROOT/$1"
  must mkdir -p "$ROOT/.claude/scripts"
  must git init --quiet -b main "$ROOT"
  must cp "$GATE" "$ROOT/.claude/scripts/lint-shell.sh"
  must write_pin "$ROOT/.claude/scripts" "$INSTALLED_VERSION"
  must clean_script "$ROOT/keep.sh"
  must clean_script "$ROOT/doomed.sh"
  must gitc "$ROOT" add -A
  must gitc "$ROOT" commit --quiet -m base
}

# The fixture's OWN copy of the gate is what runs, at its real in-repo path — that is the
# whole point of copying it in (see `fixture`), and it is why this invocation is relative
# while run_gate_on_this_repo's is not.
run_gate() {
  capture -C "$ROOT" bash .claude/scripts/lint-shell.sh
}

run_gate_on_this_repo() { # the shipped configuration: real repository, no fixture
  capture -C "$SCRIPTS" bash "$GATE"
}

# ====================================================================================
# 1. the default target — the configuration that actually ships
# ====================================================================================
# testing.md rule 7, but for a reason `pnpm lint:sh` cannot supply: verify already
# runs this exact command over the real tree, so a shellcheck finding here is caught
# either way. What only this case can catch is green-by-absence at the gate level —
# a discovery regression that finds nothing and exits 0 would pass lint:sh silently,
# and `expect_out "file(s)"` is the assertion that refuses it. (run-script-tests'
# harness reaches the opposite verdict for its own default path — "not simulable,
# cannot be green by absence" — which is true there because that gate's output IS
# the discovery; this gate's clean exit is not.) The census substring is asserted
# without a count on purpose: the number of scripts in this repository is expected to
# change, and pinning it here would make an unrelated new script fail this case.
begin "gate exits 0 over this repository's own shell scripts, with no fixture"
run_gate_on_this_repo
[ "$rc" = 0 ] || bad "gate over this repository exited $rc; output: $out$err"
expect_out "file(s)"
end

# ====================================================================================
# 2. an unstaged deletion is not a broken gate
# ====================================================================================
# rc is the whole assertion: 2 is what the pre-fix gate returned here, and it is the
# code reserved for "the gate could not run", so accepting anything non-zero would let
# the regression back in under a different name.
begin "gate exits 0 when a tracked .sh is deleted but the deletion is unstaged"
fixture unstaged_delete
must rm "$ROOT/doomed.sh"
run_gate
expect_rc 0 "$rc"
# Three files, not four: the gate copy, its pin and keep.sh were linted, doomed.sh was
# dropped. Without the count this case would also pass if the guard had grown into "skip
# everything", which is the failure mode a fix in this area is most likely to cause.
expect_out "over 3 file(s)"
expect_not_out "doomed.sh"
end

# ====================================================================================
# 3. positive control — the deletion path did not turn the gate off
# ====================================================================================
begin "gate still exits 1 for a real violation while an unstaged deletion is present"
fixture unstaged_delete_violation
must dirty_script "$ROOT/keep.sh"
must rm "$ROOT/doomed.sh"
run_gate
expect_rc 1 "$rc"
expect_out "SC2086"
expect_out "keep.sh"
end

# ====================================================================================
# 4. every discovered file reaches shellcheck, not just the first one
# ====================================================================================
# Discovery and analysis are two steps, and this is the case that pins the second: that
# the whole list reaches shellcheck, not just its alphabetical head. Truncating the
# expansion to `"$shell_files"` — element zero, the shape a quoting slip produces — is
# the mutant, and case 3 does already fail under it, but only by accident of sorting:
# its violation sits in keep.sh while the fixture's own gate copy under .claude/ sorts
# ahead of it, so the head happens to be clean. That accident is one renamed fixture
# away from evaporating, and what case 3 reports when it does bite is a bare "expected
# 1, got 0" — the same message a dozen unrelated regressions produce.
#
# So this case says the thing out loud instead of relying on the accident. The
# violation goes in the LATEST-sorting name by construction, and the census is asserted
# next to the verdict: "over 5 file(s)" with z-broken.sh unmentioned is the signature of
# a gate lying about its own scope, and it names the file that never got read.
begin "gate reports a violation in the last-sorting script, not only the first"
fixture all_files_linted
must dirty_script "$ROOT/z-broken.sh"
must gitc "$ROOT" add -A
must gitc "$ROOT" commit --quiet -m broken
run_gate
expect_rc 1 "$rc"
expect_out "over 5 file(s)"
expect_out "z-broken"
end

# ====================================================================================
# 5. a discovery that PARTLY worked is refused, not linted as if it were the whole
# ====================================================================================
# The nastier sibling of the empty list case 1 guards. `git ls-files` that fails
# partway — a broken index, an unreadable directory under a worktree — still prints
# everything it reached and exits non-zero, and read out of a process substitution
# that status is invisible to the parent shell. The subset would then be linted and
# announced as the repository: a clean census, with the unread file nowhere in it.
#
# Unlike run-script-tests' unreadable-directory case, this condition cannot be built
# out of filesystem permissions — `git ls-files` reads the index, not the tree — so
# the producer is injected instead, which is what LINT_SHELL_GIT_CMD exists for. The
# stub lists ONLY the clean keep.sh: under a gate that ignores the status, that is a
# green run with a census line, which is precisely the lie being refused. Hence
# `expect_not_out "file(s)"` next to the rc — a refused listing must never reach the
# census, because the census is the sentence that claims coverage.
begin "gate exits 2 when git ls-files fails partway, and prints no census"
fixture partial_discovery
cat >"$ROOT/fakegit" <<'EOF'
#!/usr/bin/env bash
# Discovery fails after emitting part of its listing; everything else is real git.
if [ "${1:-}" = "ls-files" ]; then
  printf 'keep.sh\0'
  exit 1
fi
exec git "$@"
EOF
must chmod +x "$ROOT/fakegit"
capture -C "$ROOT" env LINT_SHELL_GIT_CMD="$ROOT/fakegit" bash .claude/scripts/lint-shell.sh
expect_rc 2 "$rc"
expect_stderr "file discovery failed"
expect_not_out "file(s)"
end

# ====================================================================================
# 6. the pinned version is enforced, not suggested
# ====================================================================================
# The whole of #502 in one case. `verify` promises that green locally predicts green in
# CI, and for two PRs it did not: the gate analysed with whichever shellcheck the machine
# had. The fix is refusal, and refusal is what has to be asserted — a warn-only version
# check would have printed on both of those runs and changed neither outcome, and it
# would pass a case that only looked for the words.
#
# So the assertions are rc 2 AND the absent census, in the same shape case 5 uses and for
# the same reason: the census is the sentence that claims coverage, and a run that
# refused to lint must not print it. rc 2 rather than 1 is deliberate and is asserted as
# such — 1 is "shellcheck found something", and nothing was analysed here at all.
begin "gate exits 2, with no census, when the installed shellcheck is not the pinned one"
fixture pin_mismatch
must write_pin "$ROOT/.claude/scripts" 0.0.0-not-a-release
run_gate
expect_rc 2 "$rc"
expect_stderr "pinned to 0.0.0-not-a-release"
# The refusal has to be actionable or it is a wall: the installer is the way out, and a
# message that omits it sends the reader to a version their package manager may not have.
expect_stderr "install-shellcheck.sh"
expect_not_out "file(s)"
end

# ====================================================================================
# 7. positive control — the version check is not simply always-refuse
# ====================================================================================
# testing.md rule 7's shape: case 6 turns the pin to something no release ever carried,
# so this case runs the configuration that ships — a pin naming exactly what is
# installed — and proves the gate still reaches a verdict. Without it, a version check
# that had degenerated into an unconditional refusal would pass case 6 and look fixed.
# The version is asserted inside the census line, so a gate that printed a verdict
# without the analyser it claimed would still fail here.
begin "gate runs to a verdict when the pin names the installed shellcheck"
fixture pin_match
run_gate
expect_rc 0 "$rc"
expect_stdout "shellcheck ($INSTALLED_VERSION, pinned) over"
end

# ====================================================================================
# 8. a pin that cannot be read is a broken gate, not a floating one
# ====================================================================================
# The failure the whole design turns on. With the pin absent, the tempting behaviour is
# to fall back to "lint with whatever is installed" — which is precisely the pre-#502
# gate, restored silently by a missing file. It refuses instead, so the only way back to
# an unpinned run is a visible deletion that reds the build.
begin "gate exits 2, with no census, when the pin file is missing"
fixture pin_absent
must rm "$ROOT/.claude/scripts/shellcheck-pin.sh"
run_gate
expect_rc 2 "$rc"
expect_stderr "cannot read the shellcheck pin"
expect_not_out "file(s)"
end

# ====================================================================================
# 9. a pin that parses but declares nothing is refused too
# ====================================================================================
# Case 8's quieter sibling: a pin file that exists and sources cleanly, but sets no
# version — a bad edit, a rename, a truncated file. Left unchecked the comparison runs
# against the empty string, which refuses every version on earth while blaming the
# developer's install rather than the pin. The refusal names the pin instead.
begin "gate exits 2 when the pin file declares no version"
fixture pin_declares_nothing
must printf '# shellcheck shell=bash\nexport SHELLCHECK_PIN_NOTHING=1\n' \
  >"$ROOT/.claude/scripts/shellcheck-pin.sh"
run_gate
expect_rc 2 "$rc"
expect_stderr "declares no SHELLCHECK_PIN_VERSION"
expect_not_out "file(s)"
end

# ====================================================================================

finish
