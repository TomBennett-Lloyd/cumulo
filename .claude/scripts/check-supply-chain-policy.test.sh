#!/usr/bin/env bash
# Test harness for check-supply-chain-policy.sh, its neighbour in this directory.
#
# Self-contained on purpose (same shape as check-module-names.test.sh next door):
# no test framework, no network, no pnpm. Every fixture is a throwaway directory
# holding one pnpm-workspace.yaml under a single `mktemp -d` that a trap deletes
# on exit, so the offending shapes are exercised for real without ever putting an
# unexplained supply-chain opt-out in this repo's own manifest.
#
# The acceptance case is a byte-for-byte copy of what pnpm 11.18.0 actually wrote
# during the #92 reproduction — `pnpm add @aws-sdk/util-user-agent-browser@3.972.40`
# against a manifest with no explicit `minimumReleaseAge`, 15 hours after that
# version was published. pnpm appended a `minimumReleaseAgeExclude` block naming
# the package AND a transitive dependency nobody asked for, and exited 0. That
# block, verbatim, is what this gate has to go red on (testing.md rule 4: the
# regression test is the fix's cheapest ratchet).
#
# One case deliberately runs the gate with NO argument, against the real repo:
# every other case pins REPO_ROOT to a fixture, so without it the shipped default
# path could be broken and the suite would still be green (testing.md rule 7).
#
# What this harness cannot cover: that `minimumReleaseAgeStrict: true` really does
# make pnpm fail instead of auto-excluding. That needs a registry round-trip for a
# package published in the last 24 hours, which is neither offline nor repeatable —
# it is verified by hand and written up in the PR for #92. What IS covered here is
# the part that rots silently: the gate that notices if the setting goes away.
#
# Usage: bash .claude/scripts/check-supply-chain-policy.test.sh  (or `pnpm test:scripts`)
# Exit:  0 every case PASS, 1 at least one FAIL, 2 the harness itself broke.
set -uo pipefail

SCRIPTS=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd) || exit 2
CHECK="$SCRIPTS/check-supply-chain-policy.sh"

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

# The gate has to survive the oldest bash it can meet, and the interpreter is not a
# detail: under `set -u`, bash 3.2 (which macOS ships as /bin/bash) aborts where 4.4+
# shrugs. The array-building and `$'\t'` matching in this gate are exactly that kind
# of code, so the cases that exercise them run under every distinct bash on the box.
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

# raw_fixture <name> -> writes stdin verbatim as the fixture's pnpm-workspace.yaml.
# Use it for the cases about the settings themselves, or about shapes the parser refuses.
raw_fixture() {
  DIR="$TMP_ROOT/$1"
  mkdir -p "$DIR" || return 1
  cat >"$DIR/pnpm-workspace.yaml"
}

# armed_fixture <name> -> the same, prefixed with a correctly armed policy header, so
# every case about opt-out entries starts from a manifest whose settings already pass and
# a failure therefore names its own cause.
armed_fixture() {
  DIR="$TMP_ROOT/$1"
  mkdir -p "$DIR" || return 1
  {
    printf 'packages:\n'
    printf "  - 'packages/*'\n"
    printf 'minimumReleaseAge: 1440\n'
    printf 'minimumReleaseAgeStrict: true\n'
    cat
  } >"$DIR/pnpm-workspace.yaml"
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
begin "check-supply-chain-policy.sh parses (bash -n)"
for interpreter in $BASHES; do
  case_ctx="$interpreter"
  if ! syntax=$("$interpreter" -n "$CHECK" 2>&1); then
    bad "check-supply-chain-policy.sh failed -n: $syntax"
  fi
done
case_ctx=""
end

# ==========================================================================================
# 2. the real repo, via the shipped default path (no argument)
# ==========================================================================================
# The production configuration: no REPO_ROOT override, so this is the only case that can
# catch a broken default path — and it is what `pnpm verify` actually runs.
begin "the repo's own pnpm-workspace.yaml passes with no argument"
for interpreter in $BASHES; do
  case_ctx="$interpreter"
  run_check_with "$interpreter"
  expect_rc 0 "$rc"
  expect_out "check-supply-chain-policy: OK"
  expect_out "minimumReleaseAgeStrict=true"
  expect_not_out "unbound variable"
done
case_ctx=""
end

# ==========================================================================================
# 3. ACCEPTANCE: the block pnpm 11.18.0 wrote by itself, verbatim
# ==========================================================================================
# Reproduced for #92: `pnpm add @aws-sdk/util-user-agent-browser@3.972.40` 15h after that
# version was published, against a manifest with no explicit minimumReleaseAge. pnpm printed
# "Added 2 entries to minimumReleaseAgeExclude in pnpm-workspace.yaml", wrote exactly these
# lines, and exited 0. Two entries, no comments — and one of them, @aws-sdk/core, is a
# transitive dependency that appears in the manifest without ever being named by a human.
begin "the exclusions pnpm auto-wrote during the #92 repro are rejected"
must armed_fixture pnpm_autowrite <<'EOF'
minimumReleaseAgeExclude:
  - '@aws-sdk/core@3.977.4'
  - '@aws-sdk/util-user-agent-browser@3.972.40'
EOF
run_check "$DIR"
expect_rc 1 "$rc"
expect_out "2 supply-chain opt-out(s)"
expect_out "minimumReleaseAgeExclude  - '@aws-sdk/core@3.977.4'"
expect_out "minimumReleaseAgeExclude  - '@aws-sdk/util-user-agent-browser@3.972.40'"
expect_out "revert it"
end

# ==========================================================================================
# 4. the same entries, explained, pass
# ==========================================================================================
# The gate asks for a decision to be written down, not for the entry to be impossible. A
# gate with no way to say yes is a gate that gets deleted the first time somebody needs one.
begin "exclusions with a justification comment above each pass"
must armed_fixture justified_excludes <<'EOF'
minimumReleaseAgeExclude:
  # CVE-2026-0001: the patched release is hours old and the vulnerable one is
  # actively exploited, so waiting out the quarantine is the riskier option.
  - '@aws-sdk/core@3.977.4'
  # Pulled in by the line above; same reasoning, same publish batch.
  - '@aws-sdk/util-user-agent-browser@3.972.40'
EOF
run_check "$DIR"
expect_rc 0 "$rc"
expect_out "2 opt-out entr"
expect_not_out "ERROR"
end

# ==========================================================================================
# 5. one comment does not cover the whole block
# ==========================================================================================
# The shape an auto-write produces on a manifest that already had a justified entry: the new
# line is appended under an explanation that was written about something else.
begin "a comment above the first entry does not justify the second"
must armed_fixture partial_justification <<'EOF'
minimumReleaseAgeExclude:
  # Deliberate: see PR #1.
  - 'left-pad@1.3.0'
  - 'right-pad@2.0.0'
EOF
run_check "$DIR"
expect_rc 1 "$rc"
expect_out "1 supply-chain opt-out(s)"
expect_out "- 'right-pad@2.0.0'"
expect_not_out "left-pad"
end

# ==========================================================================================
# 6. a blank line breaks the association
# ==========================================================================================
begin "a comment separated from its entry by a blank line does not justify it"
must armed_fixture detached_comment <<'EOF'
minimumReleaseAgeExclude:
  # This paragraph is about the block, not about what follows it.

  - 'left-pad@1.3.0'
EOF
run_check "$DIR"
expect_rc 1 "$rc"
expect_out "- 'left-pad@1.3.0'"
end

# ==========================================================================================
# 7. an empty comment explains nothing
# ==========================================================================================
begin "a bare '#' does not count as a justification"
must armed_fixture empty_comment <<'EOF'
minimumReleaseAgeExclude:
  #
  - 'left-pad@1.3.0'
EOF
run_check "$DIR"
expect_rc 1 "$rc"
expect_out "- 'left-pad@1.3.0'"
end

# ==========================================================================================
# 8. allowBuilds is guarded on the same terms
# ==========================================================================================
# pnpm auto-populates allowBuilds on the same "pnpm decided, nobody wrote it down" pattern,
# and an install script is a larger opt-out than a fresh version: it runs arbitrary code.
begin "allowBuilds entries are guarded too"
must armed_fixture allow_builds_bare <<'EOF'
allowBuilds:
  esbuild: false
  sharp: true
EOF
run_check "$DIR"
expect_rc 1 "$rc"
expect_out "2 supply-chain opt-out(s)"
expect_out "allowBuilds  esbuild: false"
expect_out "allowBuilds  sharp: true"
end

begin "justified allowBuilds entries pass"
must armed_fixture allow_builds_justified <<'EOF'
allowBuilds:
  # Nothing for the script to do: the platform binary is installed as a package.
  esbuild: false
EOF
run_check "$DIR"
expect_rc 0 "$rc"
expect_not_out "ERROR"
end

# ==========================================================================================
# 9. blocks that are not opt-outs are left alone
# ==========================================================================================
# Over-reach is how a gate gets itself suppressed: `packages` is workspace layout, and
# demanding a comment per glob would make the gate absurd on its first run.
begin "packages entries need no justification"
must raw_fixture unguarded_blocks <<'EOF'
packages:
  - 'apps/*'
  - 'packages/*'
minimumReleaseAge: 1440
minimumReleaseAgeStrict: true
catalog:
  react: ^19.0.0
EOF
run_check "$DIR"
expect_rc 0 "$rc"
expect_out "0 opt-out entr"
expect_not_out "ERROR"
end

# ==========================================================================================
# 10. a guarded block ends at the next top-level key
# ==========================================================================================
# If the block never closed, the unguarded entries after it would be reported as offenders,
# and the gate would be unusable on any manifest that puts an opt-out anywhere but last.
begin "entries after a guarded block ends are not guarded"
must raw_fixture block_ends <<'EOF'
minimumReleaseAge: 1440
minimumReleaseAgeStrict: true
allowBuilds:
  # Explained.
  esbuild: false
packages:
  - 'apps/*'
  - 'packages/*'
EOF
run_check "$DIR"
expect_rc 0 "$rc"
expect_out "1 opt-out entr"
expect_not_out "ERROR"
end

# ==========================================================================================
# 11. a nested value is part of its entry, not a new one
# ==========================================================================================
begin "lines indented deeper than the entry level are continuations, not entries"
must armed_fixture nested_value <<'EOF'
minimumReleaseAgeExclude:
  # One entry, spelled across two lines.
  - >-
    left-pad@1.3.0
EOF
run_check "$DIR"
expect_rc 0 "$rc"
expect_out "1 opt-out entr"
expect_not_out "ERROR"
end

# ==========================================================================================
# 12. THE CENSUS: the settings must be present, or the gate is proving nothing
# ==========================================================================================
# This is the case that stops the gate going green by absence. A manifest with no policy at
# all — which is exactly the state that produced #92 — has no unjustified entries in it
# either, so an entries-only gate would call it clean.
begin "a manifest with no policy settings fails, despite having no bad entries"
must raw_fixture no_policy <<'EOF'
packages:
  - 'packages/*'
EOF
run_check "$DIR"
expect_rc 1 "$rc"
expect_out "does not arm the quarantine"
expect_out "minimumReleaseAge is not set"
expect_out "minimumReleaseAgeStrict is 'unset'"
end

begin "minimumReleaseAge set but strict left off fails"
must raw_fixture loose_mode <<'EOF'
minimumReleaseAge: 1440
minimumReleaseAgeStrict: false
EOF
run_check "$DIR"
expect_rc 1 "$rc"
expect_out "minimumReleaseAgeStrict is 'false'"
expect_not_out "minimumReleaseAge is not set"
end

begin "minimumReleaseAge of 0 fails — that disables the quarantine"
must raw_fixture zero_age <<'EOF'
minimumReleaseAge: 0
minimumReleaseAgeStrict: true
EOF
run_check "$DIR"
expect_rc 1 "$rc"
expect_out "it must be a positive number of minutes"
end

begin "a non-numeric minimumReleaseAge fails"
must raw_fixture non_numeric_age <<'EOF'
minimumReleaseAge: soon
minimumReleaseAgeStrict: true
EOF
run_check "$DIR"
expect_rc 1 "$rc"
expect_out "minimumReleaseAge is 'soon'"
end

# ==========================================================================================
# 13. inline comments on the settings are values' business, not the gate's
# ==========================================================================================
begin "an inline trailing comment does not corrupt a setting's value"
must raw_fixture inline_comments <<'EOF'
minimumReleaseAge: 1440 # one day, pnpm's own default
minimumReleaseAgeStrict: true # fail the install rather than auto-excluding
EOF
run_check "$DIR"
expect_rc 0 "$rc"
expect_out "minimumReleaseAge=1440"
expect_out "minimumReleaseAgeStrict=true"
end

# ==========================================================================================
# 14. shapes the parser refuses rather than skips
# ==========================================================================================
# A parser that shrugs at a line it cannot read is a gate that passes the entry it could not
# see, so every unrecognised shape is exit 2 — no verdict — and never exit 0.
begin "an unparseable top-level line exits 2, not 0"
must raw_fixture unparseable <<'EOF'
minimumReleaseAge: 1440
minimumReleaseAgeStrict: true
---
EOF
run_check "$DIR"
expect_rc 2 "$rc"
expect_out "is not a top-level key and not a comment"
end

begin "tab indentation exits 2"
must raw_fixture tab_indent <<'EOF'
minimumReleaseAge: 1440
minimumReleaseAgeStrict: true
minimumReleaseAgeExclude:
	- 'left-pad@1.3.0'
EOF
for interpreter in $BASHES; do
  case_ctx="$interpreter"
  run_check_with "$interpreter" "$DIR"
  expect_rc 2 "$rc"
  expect_out "indented with a tab"
  expect_not_out "unbound variable"
done
case_ctx=""
end

# A guarded key in YAML flow style has no indented lines to walk, so a reader built
# around block style sees an empty block and reports zero opt-outs — exit 0, on the
# one key the gate exists for. pnpm patches the existing YAML document rather than
# rewriting it, so a manifest already in flow style keeps it and every entry pnpm
# appends lands unread. These three cases exit 0 against the pre-fix script (#92
# review cycle 1) and are the reason the refusal exists.
begin "an inline flow sequence on a guarded key exits 2, not 0"
must raw_fixture flow_sequence <<'EOF'
packages:
  - 'packages/*'
minimumReleaseAge: 1440
minimumReleaseAgeStrict: true
minimumReleaseAgeExclude: ['left-pad@1.3.0', 'right-pad@2.0.0']
EOF
run_check "$DIR"
expect_rc 2 "$rc"
expect_out "writes minimumReleaseAgeExclude as an inline collection"
expect_out "Rewrite the block in indented (block) style"
expect_not_out "all justified"
end

begin "an inline flow mapping on a guarded key exits 2, not 0"
must raw_fixture flow_mapping <<'EOF'
packages:
  - 'packages/*'
minimumReleaseAge: 1440
minimumReleaseAgeStrict: true
allowBuilds: {esbuild: true, sharp: true}
EOF
run_check "$DIR"
expect_rc 2 "$rc"
expect_out "writes allowBuilds as an inline collection"
expect_not_out "all justified"
end

# An empty flow collection is harmless in itself. It is refused anyway, so the rule
# stays one sentence — a guarded key's entries live on indented lines beneath it —
# rather than one sentence plus an exception nobody remembers.
begin "an empty inline collection is refused too, deliberately"
must raw_fixture flow_empty <<'EOF'
minimumReleaseAge: 1440
minimumReleaseAgeStrict: true
minimumReleaseAgeExclude: []
EOF
run_check "$DIR"
expect_rc 2 "$rc"
expect_out "inline collection"
end

# The mirror of the three above: an unguarded key is allowed to hold whatever it
# likes, and a guarded key with nothing after the colon is the normal shape. A
# refusal that fired on either would make the gate unusable.
begin "an inline collection on an unguarded key is fine"
must raw_fixture flow_unguarded <<'EOF'
packages: ['apps/*', 'packages/*']
minimumReleaseAge: 1440
minimumReleaseAgeStrict: true
EOF
run_check "$DIR"
expect_rc 0 "$rc"
expect_out "0 opt-out entr"
end

begin "a dedent inside a guarded block exits 2"
must armed_fixture dedent <<'EOF'
minimumReleaseAgeExclude:
    # Explained.
    - 'left-pad@1.3.0'
  - 'right-pad@2.0.0'
EOF
run_check "$DIR"
expect_rc 2 "$rc"
expect_out "dedents inside minimumReleaseAgeExclude"
end

# ==========================================================================================
# 15. file-level input the gate cannot give a verdict on
# ==========================================================================================
begin "a root with no pnpm-workspace.yaml exits 2, not 0"
DIR="$TMP_ROOT/no_manifest"
must mkdir -p "$DIR"
run_check "$DIR"
expect_rc 2 "$rc"
expect_out "no pnpm-workspace.yaml under"
end

begin "a nonexistent root exits 2, not 1"
run_check "$TMP_ROOT/does-not-exist"
expect_rc 2 "$rc"
expect_out "not a directory"
end

# ==========================================================================================
# 16. line endings and a missing final newline
# ==========================================================================================
# The last line of a file pnpm has just appended to is the one most likely to be an
# unjustified entry, so "the reader dropped it" is not an acceptable way to be green.
begin "a final line with no trailing newline is still checked"
DIR="$TMP_ROOT/no_final_newline"
must mkdir -p "$DIR"
must printf 'minimumReleaseAge: 1440\nminimumReleaseAgeStrict: true\nminimumReleaseAgeExclude:\n  - %s' \
  "'left-pad@1.3.0'" >"$DIR/pnpm-workspace.yaml"
run_check "$DIR"
expect_rc 1 "$rc"
expect_out "- 'left-pad@1.3.0'"
end

begin "CRLF line endings do not break the settings check"
DIR="$TMP_ROOT/crlf"
must mkdir -p "$DIR"
must printf 'minimumReleaseAge: 1440\r\nminimumReleaseAgeStrict: true\r\n' >"$DIR/pnpm-workspace.yaml"
run_check "$DIR"
expect_rc 0 "$rc"
expect_out "minimumReleaseAgeStrict=true"
end

# ==========================================================================================

printf '\n%d passed, %d failed\n' "$passed" "$failed"
[ "$failed" = "0" ] || exit 1
