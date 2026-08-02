#!/usr/bin/env bash
# Test harness for the workflow lint gate (.claude/scripts/lint-workflows.sh).
#
# The gate's exit codes are a three-way contract — 0 clean, 1 actionlint found
# something, 2 the GATE ITSELF reached no verdict — and the cases below are
# organised around the two ways the middle and the last one get confused.
#
# Reporting "broken gate" for an ordinary working-tree state is the bug
# lint-shell.test.sh pins one directory over: a file in the index but not on
# disk (an unstaged `rm`) is an exit-3 fatal to actionlint, and must be dropped
# during discovery rather than allowed to red `verify` with something
# unactionable.
#
# The opposite confusion is worse and is the reason this gate exists at all.
# Verified against actionlint 1.7.12: a workflow whose `run: |` block holds an
# `if` with no `then` exits 1 with "shellcheck reported issue" when shellcheck
# is on PATH, and exits 0 — indistinguishable from clean — when it is not. So
# the missing-shellcheck case asserts 2, and the broken-shell case asserts 1;
# together they are the pair that dies if the preflight is ever dropped, which
# is exactly what the prescribed mutant (preflight deleted, invocation changed
# to `-shellcheck ""`) does.
#
# Self-contained on the same terms as lint-shell.test.sh: no framework, no
# network, one `mktemp -d` that a trap removes, and every fixture is a throwaway
# git repo the harness cd's into — the gate roots itself with `git rev-parse
# --show-toplevel`, so it can never lint or mutate the repository it ships in.
#
# Usage: bash .claude/scripts/lint-workflows.test.sh   (or `pnpm test:scripts`)
# Exit:  0 every case PASS, 1 at least one FAIL, 2 the harness itself broke.
set -u
export PATH="/opt/homebrew/bin:$PATH"

SCRIPTS=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd) || exit 2

# The gate under test, overridable so the same cases can be run against an older
# revision of the gate as a negative control (testing.md rule 4: a regression
# test is only worth its line count if it has been seen to fail on the pre-fix
# code):
#
#   git show <rev>:.claude/scripts/lint-workflows.sh >/tmp/pre.sh
#   LINT_WORKFLOWS_GATE=/tmp/pre.sh bash .claude/scripts/lint-workflows.test.sh
#
# Unset — how `pnpm test:scripts` runs it — is the shipped gate.
GATE=${LINT_WORKFLOWS_GATE:-$SCRIPTS/lint-workflows.sh}

tmp_raw=$(mktemp -d) || exit 2
cleanup() { rm -rf "$tmp_raw"; }
trap cleanup EXIT INT TERM
# Canonical from the start: macOS hides temp dirs behind /var -> /private/var,
# and the gate reports paths relative to a realpath'd toplevel.
TMP_ROOT=$(cd "$tmp_raw" && pwd -P) || exit 2

passed=0
failed=0
case_name=""
case_failed=0
out=""
rc=0

# --- harness plumbing --------------------------------------------------------------

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

# --- fixtures ----------------------------------------------------------------------

# Identity is passed per-command: the harness must not depend on (or write) any git config.
gitc() {
  local dir="$1"
  shift
  git -C "$dir" -c user.email=test@test -c user.name=test -c commit.gpgsign=false "$@"
}

# The three workflow shapes below each take a full destination path and create
# its parent, so a case can place one at either YAML spelling, or at no path at
# all (the zero-files case), without a fixture flag for every combination.

clean_workflow() { # clean_workflow <path> — valid schema, and shell shellcheck likes
  mkdir -p "$(dirname "$1")" &&
    cat >"$1" <<'EOF'
name: clean
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - name: greet
        run: |
          target="hello"
          printf '%s\n' "$target"
EOF
}

broken_shell_workflow() { # broken_shell_workflow <path> — an `if` with no `then` (SC1049)
  mkdir -p "$(dirname "$1")" &&
    cat >"$1" <<'EOF'
name: broken-shell
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - name: unparseable shell
        run: |
          x=1
          if [ "$x" = y ]
            printf 'never\n'
          fi
EOF
}

bad_needs_workflow() { # bad_needs_workflow <path> — schema error no shell linter can see
  mkdir -p "$(dirname "$1")" &&
    cat >"$1" <<'EOF'
name: bad-needs
on: push
jobs:
  build:
    needs: nonexistent
    runs-on: ubuntu-latest
    steps:
      - name: greet
        run: printf 'hello\n'
EOF
}

# fixture <name> -> sets ROOT to a fresh, EMPTY git repo under $TMP_ROOT. Empty
# because unlike lint-shell.test.sh's fixtures this one need not carry a copy of
# the gate: the gate lints .github/workflows only, so it is run from outside and
# discovers nothing it did not itself put there. That keeps every census count
# below equal to the number of workflows the case deliberately wrote.
fixture() {
  ROOT="$TMP_ROOT/$1"
  must mkdir -p "$ROOT"
  must git init --quiet -b main "$ROOT"
}

run_gate() { # run_gate [VAR=value …] — run the gate in $ROOT, with optional overrides
  out=$(cd "$ROOT" && env "$@" bash "$GATE" 2>&1)
  rc=$?
}

run_gate_on_this_repo() { # the shipped configuration: real repository, no overrides
  out=$(cd "$SCRIPTS" && bash "$GATE" 2>&1)
  rc=$?
}

# ====================================================================================
# 1. the default target — the configuration that actually ships
# ====================================================================================
# testing.md rule 7: every case below reaches its target by pointing the gate at a
# throwaway repo, and two of them neuter a binary lookup. Without this case the suite
# would prove the gate works everywhere except where it runs.
begin "gate exits 0 over this repository's own workflows, with no overrides"
run_gate_on_this_repo
expect_rc 0 "$rc"
expect_out "file(s)"
end

# ====================================================================================
# 2. tracked files are discovered
# ====================================================================================
begin "gate exits 0 for a committed clean workflow (--cached discovery)"
fixture committed_clean
must clean_workflow "$ROOT/.github/workflows/ci.yml"
must gitc "$ROOT" add -A
must gitc "$ROOT" commit --quiet -m base
run_gate
expect_rc 0 "$rc"
expect_out "over 1 file(s)"
end

# ====================================================================================
# 3. untracked files are discovered, and their shell is actually analysed
# ====================================================================================
# The issue's named gap in one case: a workflow written but not yet staged is
# precisely the one you want read before it runs with OIDC credentials, and the
# finding has to come from shellcheck — actionlint alone parses `run:` blocks as
# opaque strings.
begin "gate exits 1 for broken shell in an untracked workflow (--others + shellcheck)"
fixture untracked_broken_shell
must broken_shell_workflow "$ROOT/.github/workflows/ci.yml"
run_gate
expect_rc 1 "$rc"
expect_out "shellcheck reported issue"
end

# ====================================================================================
# 4. the half of the gate that is not shellcheck
# ====================================================================================
begin "gate exits 1 for a needs: reference to a job that does not exist"
fixture bad_needs
must bad_needs_workflow "$ROOT/.github/workflows/ci.yml"
must gitc "$ROOT" add -A
must gitc "$ROOT" commit --quiet -m base
run_gate
expect_rc 1 "$rc"
expect_out "job-needs"
end

# ====================================================================================
# 5. an unstaged deletion is not a broken gate
# ====================================================================================
# rc is the whole assertion: 2 is the code reserved for "the gate could not run", and
# an ordinary `rm` you have not staged yet must not be able to raise it. The count is
# asserted alongside because this case would also pass if the drop had grown into
# "skip everything", which is the failure mode a fix in this area is likeliest to cause.
begin "gate exits 0 when a tracked workflow is deleted but the deletion is unstaged"
fixture unstaged_delete
must clean_workflow "$ROOT/.github/workflows/keep.yml"
must clean_workflow "$ROOT/.github/workflows/doomed.yml"
must gitc "$ROOT" add -A
must gitc "$ROOT" commit --quiet -m base
must rm "$ROOT/.github/workflows/doomed.yml"
run_gate
expect_rc 0 "$rc"
expect_out "over 1 file(s)"
expect_not_out "doomed.yml"
end

# ====================================================================================
# 6. finding nothing is a broken filter, not a pass
# ====================================================================================
begin "gate exits 2 in a repository with no workflow files at all"
fixture no_workflows
run_gate
expect_rc 2 "$rc"
expect_out "found no workflow"
end

# ====================================================================================
# 7. missing actionlint
# ====================================================================================
begin "gate exits 2 with install instructions when actionlint is not on PATH"
fixture missing_actionlint
must clean_workflow "$ROOT/.github/workflows/ci.yml"
run_gate LINT_WORKFLOWS_ACTIONLINT=/nonexistent-actionlint
expect_rc 2 "$rc"
expect_out "brew install actionlint"
end

# ====================================================================================
# 8. missing shellcheck — the silent-degradation guard
# ====================================================================================
# Deliberately the case-3 fixture: with the preflight removed, actionlint returns 0
# over this very file (verified, 1.7.12). Asserting 2 here and 1 in case 3 is what
# makes "shellcheck vanished" impossible to mistake for "the workflows are clean".
begin "gate exits 2 rather than passing silently when shellcheck is not on PATH"
fixture missing_shellcheck
must broken_shell_workflow "$ROOT/.github/workflows/ci.yml"
run_gate LINT_WORKFLOWS_SHELLCHECK=/nonexistent-shellcheck
expect_rc 2 "$rc"
expect_out "lint:workflows: shellcheck is not installed"
expect_out "refusing to report a pass"
end

# ====================================================================================
# 9. actionlint's non-verdict exit codes are not findings
# ====================================================================================
# An unreadable input is actionlint's exit 3. Mapping it to 1 would report "your
# workflow is wrong" about a file nobody could read; mapping it to 0 would be the
# silent pass again. Permissions are restored inside the case so the trap's `rm -rf`
# never has to care.
begin "gate exits 2 when actionlint cannot read a file (rc 3 is not a verdict)"
fixture unreadable_workflow
must clean_workflow "$ROOT/.github/workflows/ci.yml"
must gitc "$ROOT" add -A
must gitc "$ROOT" commit --quiet -m base
must chmod 000 "$ROOT/.github/workflows/ci.yml"
run_gate
must chmod 644 "$ROOT/.github/workflows/ci.yml"
expect_rc 2 "$rc"
expect_out "could not reach a verdict"
end

# ====================================================================================
# 10. the .yaml half of the discovery pathspec
# ====================================================================================
# GitHub accepts both spellings and the gate lists both, but every workflow in this
# repository is `.yml`, so the `.yaml` arm is exercised by no real file — delete it
# and every other case here still passes. The schema error rather than the broken
# shell is deliberate: this case must have exactly one reason to fail, and that reason
# is "the pathspec stopped covering .yaml".
begin "gate discovers a .yaml-spelled workflow, not only .yml"
fixture yaml_spelling
must bad_needs_workflow "$ROOT/.github/workflows/x.yaml"
run_gate
expect_rc 1 "$rc"
expect_out "over 1 file(s)"
expect_out "x.yaml"
end

# ====================================================================================
# 11. every discovered file reaches actionlint, not just the first one
# ====================================================================================
# Discovery and analysis are two steps, and until this case only the first was pinned:
# every case above hands the linter exactly one file, so a gate that expanded its list
# as `"$workflow_files"` — element zero, the shape a quoting slip produces — passed all
# ten while checking one file in six and still printing the full census count. The
# finding is deliberately in the LATER-sorting name: git lists paths sorted, so a
# truncation keeps the alphabetical head, and putting the clean file first is what makes
# the count and the verdict disagree. Asserting the census alongside rc is the point —
# "over 2 file(s)" with rc 0 is the exact signature of a gate lying about its own scope.
begin "gate reports a finding in the second of two workflows, not only the first"
fixture all_files_linted
must clean_workflow "$ROOT/.github/workflows/a-clean.yml"
must broken_shell_workflow "$ROOT/.github/workflows/z-broken.yml"
must gitc "$ROOT" add -A
must gitc "$ROOT" commit --quiet -m base
run_gate
expect_rc 1 "$rc"
expect_out "over 2 file(s)"
expect_out "z-broken"
end

# ====================================================================================

printf '\n%d passed, %d failed\n' "$passed" "$failed"
[ "$failed" = "0" ] || exit 1
