#!/usr/bin/env bash
# Test harness for check-node-types.sh, its neighbour in this directory.
#
# No test framework, no network, no pnpm, no install: the assertion vocabulary is
# harness-lib.sh next door, sourced below and shared with every sibling harness.
# Every fixture is a throwaway workspace — an .nvmrc and two or three package.json
# files under the temp tree `harness_init_tmp` makes and a trap deletes on exit —
# so the shapes this gate exists to catch are exercised for real, without this
# repo ever having to hold a manifest whose types run ahead of its runtime.
#
# The two cases that carry the gate's reason for existing:
#
#   * the DEFECT case — .nvmrc pinning 22 against a range naming 26, which is the
#     #407 state: a package compiling against definitions for APIs the runtime
#     does not have, with nothing red anywhere. It appears twice, once beside an
#     aligned sibling (the repo's actual shape) and once alone, so that removing
#     the major verdict from the gate changes an exit code rather than only a
#     message.
#   * the CAUSE case — a manifest depending on vitest and declaring no
#     @types/node at all. vite and vitest declare @types/node as an optional peer,
#     so that manifest does not opt out; it delegates the choice to pnpm, which is
#     how a major-26 resolution survived aligning every manifest that did declare
#     a range. Its control sits directly beneath it: a manifest depending on
#     neither tool is asked for nothing, because a gate that demands a dependency
#     nobody needs is a gate somebody eventually suppresses.
#
# One case deliberately runs the gate with NO argument, against the real repo:
# every other case pins REPO_ROOT to a fixture, so without it the shipped default
# path could be broken and the suite would still be green (testing.md rule 7).
# That case is also the only one that asserts the real census, and it is meant to
# go red the day a manifest joins or leaves the workspace without this count
# following it.
#
# Usage: bash .claude/scripts/check-node-types.test.sh  (or `pnpm test:scripts`)
# Exit:  0 every case PASS, 1 at least one FAIL, 2 the harness itself broke.
set -uo pipefail

SCRIPTS=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd) || exit 2
CHECK="$SCRIPTS/check-node-types.sh"

# shellcheck source=./harness-lib.sh
. "$SCRIPTS/harness-lib.sh"
harness_init_tmp

FIXTURE=""

# --- fixtures ----------------------------------------------------------------------------

# A fixture is a workspace root holding an .nvmrc and apps/ and packages/
# directories, built one file at a time so each case's shape is readable in the
# case itself rather than in a shared builder with flags.
fixture() { # fixture <name> -> creates the workspace root and points FIXTURE at it
  FIXTURE="$TMP_ROOT/$1"
  mkdir -p "$FIXTURE"
}

write_nvmrc() { # write_nvmrc <content, written verbatim with a trailing newline>
  printf '%s\n' "$1" >"$FIXTURE/.nvmrc"
}

write_pkg() { # write_pkg <dir under the fixture>; package.json body on stdin
  mkdir -p "$FIXTURE/$1" || return 1
  cat >"$FIXTURE/$1/package.json"
}

# The conforming manifest, and the one the aligned cases are built from: a
# devDependency naming a range whose major is the one .nvmrc pins.
typed_pkg() { # typed_pkg <dir under the fixture> <spec>
  write_pkg "$1" <<EOF
{
  "name": "@fixture/$(basename "$1")",
  "devDependencies": { "@types/node": "$2" }
}
EOF
}

run_check_with() { # run_check_with <bash> <args...>
  local interpreter="$1"
  shift
  capture "$interpreter" "$CHECK" "$@"
}

run_check() { # run_check <args...>
  run_check_with bash "$@"
}

# ==========================================================================================
# 1. the gate parses
# ==========================================================================================
begin "check-node-types.sh parses (bash -n)"
expect_parses "$CHECK"
end

# ==========================================================================================
# 2. the real repo, via the shipped default path (no argument)
# ==========================================================================================
# The production configuration: no REPO_ROOT override, so this is the only case that can
# catch a broken default path — and it is what `pnpm verify` actually runs. The manifest
# count is asserted because a census is only as good as its size: a manifest that stopped
# being enumerated, or one that joined without declaring a range, is invisible in an OK line
# that says only "OK". The full success prefix is asserted, never a bare "OK" (#219).
begin "the repo's own workspace passes with no argument, over the whole manifest census"
for interpreter in $BASHES; do
  case_ctx="$interpreter"
  run_check_with "$interpreter"
  expect_rc 0 "$rc"
  expect_stdout "check-node-types: OK — "
  expect_stdout "9 manifests"
  expect_not_out "ERROR"
  expect_not_out "unbound variable"
done
case_ctx=""
end

# ==========================================================================================
# 3. an aligned workspace passes, and the vite/vitest tell does not fire on it
# ==========================================================================================
# The repo's own shape in miniature: every manifest declares the same range, and the one
# that also depends on vitest is not named — it has already answered the question the tell
# asks. This is also the case that runs the all-clear path under every bash on the box:
# under `set -u`, bash 3.2 aborts where 4.4 shrugs, and the verdict section reads three
# arrays that are all empty here.
begin "an aligned workspace passes, naming the range, the count and the .nvmrc major"
must fixture aligned
must write_nvmrc 22
must typed_pkg packages/store '^22.20.1'
must write_pkg apps/consumer <<'EOF'
{
  "name": "@fixture/consumer",
  "devDependencies": { "@types/node": "^22.20.1", "vitest": "^4.1.10" }
}
EOF
for interpreter in $BASHES; do
  case_ctx="$interpreter"
  run_check_with "$interpreter" "$FIXTURE"
  expect_rc 0 "$rc"
  expect_stdout "check-node-types: OK — ^22.20.1, 2 manifests, .nvmrc major 22"
  expect_not_out "ERROR"
  expect_not_out "unbound variable"
done
case_ctx=""
end

# ==========================================================================================
# 4. THE DEFECT: a range whose major is not the one .nvmrc pins
# ==========================================================================================
# #407's state, and the reason this gate exists. Types ahead of the runtime is the dangerous
# direction — the compiler promises APIs that are simply absent at run time — and it is
# silent in every other check the repo runs.
begin "a range naming a major other than the .nvmrc major fails, offender named"
must fixture major_ahead
must write_nvmrc 22
must typed_pkg packages/store '^22.20.1'
must typed_pkg apps/consumer '^26.2.0'
for interpreter in $BASHES; do
  case_ctx="$interpreter"
  run_check_with "$interpreter" "$FIXTURE"
  expect_rc 1 "$rc"
  expect_stderr "1 @types/node range(s) name a major other than the .nvmrc major (22)"
  expect_stderr "apps/consumer/package.json → ^26.2.0 (major 26"
  # The aligned sibling is not the offender, and saying so would send the reader to fix a
  # file that is already right.
  expect_not_stderr "ERROR packages/store/package.json → ^22.20.1 (major"
  expect_not_out "unbound variable"
done
case_ctx=""
end

# The same defect with nothing else wrong: one manifest, so the ranges cannot diverge from
# each other and the major verdict is the ONLY thing standing between this fixture and a
# pass. That makes it the case that turns a neutralised major verdict into an exit-code
# change rather than a missing sentence — the mutation control the PR pastes.
begin "a lone manifest whose only fault is its major still fails"
must fixture major_ahead_alone
must write_nvmrc 22
must typed_pkg packages/store '^26.2.0'
run_check "$FIXTURE"
expect_rc 1 "$rc"
expect_stderr "1 @types/node range(s) name a major other than the .nvmrc major (22)"
expect_stderr "packages/store/package.json → ^26.2.0"
expect_not_out "different @types/node ranges"
expect_not_stdout "check-node-types: OK"
end

# ==========================================================================================
# 5. divergent ranges inside the correct major
# ==========================================================================================
# The other half of the #407 state: five ranges, two of them agreeing with .nvmrc about the
# major and disagreeing with each other about everything else. pnpm resolves several copies
# and hands vite and vitest a peer variant for each, so which definitions a package compiles
# against depends on which manifest it sits next to. Both offenders are named, because "one
# of these is wrong" is not an actionable message when either could be the one to move.
begin "divergent ranges within the .nvmrc major fail, both offenders named"
must fixture divergent
must write_nvmrc 22
must typed_pkg packages/store '^22.20.1'
must typed_pkg apps/consumer '^22.10.2'
run_check "$FIXTURE"
expect_rc 1 "$rc"
expect_stderr "2 different @types/node ranges across 2 manifest(s)"
expect_stderr "packages/store/package.json → ^22.20.1"
expect_stderr "apps/consumer/package.json → ^22.10.2"
# Both majors are 22, so the major verdict has nothing to say here.
expect_not_out "name a major other than"
end

# ==========================================================================================
# 6. THE CAUSE: vite/vitest with no @types/node declared at all
# ==========================================================================================
# packages/shared's shape before #407. It declared vitest and no @types/node, so it never
# appeared in any range census — and vitest's optional peer dependency on @types/node meant
# pnpm resolved one for it anyway, unconstrained, keeping a major-26 copy alive in the
# lockfile after every manifest that DID declare a range had been aligned. A gate that
# checked only declared ranges would call this fixture clean, which is precisely how the
# drift it catches got started.
begin "a manifest depending on vitest with no @types/node fails, named with the tool"
must fixture tool_without_types
must write_nvmrc 22
must typed_pkg packages/store '^22.20.1'
must write_pkg packages/tested <<'EOF'
{
  "name": "@fixture/tested",
  "devDependencies": { "vitest": "^4.1.10" }
}
EOF
for interpreter in $BASHES; do
  case_ctx="$interpreter"
  run_check_with "$interpreter" "$FIXTURE"
  expect_rc 1 "$rc"
  expect_stderr "1 manifest(s) depend on vite or vitest without declaring @types/node"
  expect_stderr "packages/tested/package.json declares vitest and no @types/node"
  # Nothing else is wrong with this fixture: the one declared range agrees with .nvmrc and
  # with itself, so neither other verdict may fire.
  expect_not_out "name a major other than"
  expect_not_out "different @types/node ranges"
  expect_not_out "unbound variable"
done
case_ctx=""
end

# The control on that verdict, and the line it must not cross. A manifest that depends on
# neither vite nor vitest resolves nobody's optional peer, so it has no @types/node question
# to answer — and demanding a dependency a package does not need is how a gate teaches
# people to paste config, and then to suppress it.
begin "a manifest depending on neither tool needs no @types/node"
must fixture no_tool_no_types
must write_nvmrc 22
must typed_pkg packages/store '^22.20.1'
must write_pkg apps/consumer <<'EOF'
{
  "name": "@fixture/consumer",
  "dependencies": { "zod": "^4.4.3" }
}
EOF
run_check "$FIXTURE"
expect_rc 0 "$rc"
expect_stdout "check-node-types: OK — ^22.20.1, 1 manifests, .nvmrc major 22"
expect_not_out "apps/consumer"
end

# The tell reads every dependency field, not just devDependencies — vitest in `dependencies`
# resolves the same optional peer.
begin "the vite/vitest tell reads dependencies too, and names vite"
must fixture tool_in_dependencies
must write_nvmrc 22
must typed_pkg packages/store '^22.20.1'
must write_pkg apps/consumer <<'EOF'
{
  "name": "@fixture/consumer",
  "dependencies": { "vite": "^8.1.5" }
}
EOF
run_check "$FIXTURE"
expect_rc 1 "$rc"
expect_stderr "apps/consumer/package.json declares vite and no @types/node"
end

# ==========================================================================================
# 7. the .nvmrc side: the major has an owner, and an owner that cannot be read is a refusal
# ==========================================================================================
# An alias names a major that changes under the repo without the file changing, so there is
# no fixed major to check the ranges against. Exit 2, not 1: the ranges are not accused of
# anything, the gate simply has nothing to compare them with.
begin "an .nvmrc naming an alias exits 2, not 0"
must fixture nvmrc_alias
must write_nvmrc 'lts/jod'
must typed_pkg packages/store '^22.20.1'
run_check "$FIXTURE"
expect_rc 2 "$rc"
expect_stderr "cannot read a Node major out of .nvmrc: 'lts/jod'"
expect_not_stdout "check-node-types: OK"
end

begin "an empty .nvmrc exits 2, not 0"
must fixture nvmrc_empty
must write_nvmrc ''
must typed_pkg packages/store '^22.20.1'
run_check "$FIXTURE"
expect_rc 2 "$rc"
expect_stderr "cannot read a Node major out of .nvmrc"
end

begin "a workspace with no .nvmrc exits 2, not 0"
must fixture nvmrc_missing
must typed_pkg packages/store '^22.20.1'
run_check "$FIXTURE"
expect_rc 2 "$rc"
expect_stderr "no .nvmrc under"
expect_not_stdout "check-node-types: OK"
end

# The forms .nvmrc is actually written in. `22` is what this repo holds; `v22.11.0` is what
# `nvm use` writes back, and reading only the major out of it is the whole point — a patch
# version in .nvmrc says nothing about which @types/node patch is right.
begin "a full v-prefixed .nvmrc version is read for its major and passes"
must fixture nvmrc_full_version
must write_nvmrc 'v22.11.0'
must typed_pkg packages/store '^22.20.1'
run_check "$FIXTURE"
expect_rc 0 "$rc"
expect_stdout "check-node-types: OK — ^22.20.1, 1 manifests, .nvmrc major 22"
end

# ==========================================================================================
# 8. the spec side: extractable, or refused
# ==========================================================================================
# A range that can satisfy more than one major cannot be checked against the one .nvmrc
# pins. Exit 2 naming the manifest — the honest refusal — never a guess at which major was
# meant, because a gate that guesses reports agreements it never established.
begin "a spec no major can be extracted from exits 2, naming the manifest"
must fixture spec_unextractable
must write_nvmrc 22
must typed_pkg packages/store '>=22'
run_check "$FIXTURE"
expect_rc 2 "$rc"
expect_stderr "cannot read a Node major out of '>=22' in packages/store/package.json"
expect_not_stdout "check-node-types: OK"
end

# The wildcard-patch form is extractable and legitimate — `22.x` names exactly one major.
# Drop the `x` arm from the spec pattern and this case is the one that stops passing.
begin "a wildcard-patch spec is extractable and passes"
must fixture spec_wildcard
must write_nvmrc 22
must typed_pkg packages/store '22.x'
must typed_pkg apps/consumer '22.x'
run_check "$FIXTURE"
expect_rc 0 "$rc"
expect_stdout "check-node-types: OK — 22.x, 2 manifests, .nvmrc major 22"
end

# ==========================================================================================
# 9. THE CENSUS-DEATH GUARD: a scan that finds no declaration at all is broken, not clean
# ==========================================================================================
# Every verdict above reports "no violations" just as happily when the manifest enumeration
# has broken, the dependency fields have been renamed, or the package has stopped being
# spelled @types/node. Those are the ways this gate could stop covering anything without
# stopping running, and they all look like this fixture from the inside (#101: a dead gate
# is green).
begin "a workspace where nothing declares @types/node exits 2, not 0"
must fixture no_declarations
must write_nvmrc 22
must write_pkg packages/store <<'EOF'
{
  "name": "@fixture/store",
  "dependencies": { "zod": "^4.4.3" }
}
EOF
run_check "$FIXTURE"
expect_rc 2 "$rc"
expect_stderr "no manifest under"
expect_stderr "refuses to pass on an empty census"
end

begin "a root holding no manifests at all exits 2, not 0"
must fixture empty_root
must write_nvmrc 22
run_check "$FIXTURE"
expect_rc 2 "$rc"
expect_stderr "refuses to pass on an empty census"
end

# ==========================================================================================
# 10. invocations and inputs the gate cannot give a verdict on
# ==========================================================================================
begin "a nonexistent root exits 2, not 1"
run_check "$TMP_ROOT/does-not-exist"
expect_rc 2 "$rc"
expect_stderr "not a directory"
end

# A manifest the census cannot read is not a manifest without a range — it is one nobody can
# give a verdict on, and skipping it is how a drifted range would slip through.
begin "an unparseable package.json exits 2, not 0"
must fixture broken_manifest
must write_nvmrc 22
must typed_pkg packages/store '^22.20.1'
must write_pkg apps/consumer <<'EOF'
{
  "name": "@fixture/consumer",
  "devDependencies": { "@types/node": "^22.20.1" },
}
EOF
run_check "$FIXTURE"
expect_rc 2 "$rc"
expect_stderr "apps/consumer/package.json is not readable JSON"
end

# The root manifest is part of the census, not just apps/ and packages/ — it is a manifest
# that can declare a range like any other, and one that drifted there would be invisible to
# a scan that only walked the two group directories.
begin "the root package.json is in the census"
must fixture root_manifest
must write_nvmrc 22
must typed_pkg packages/store '^22.20.1'
must write_pkg . <<'EOF'
{
  "name": "@fixture/root",
  "private": true,
  "devDependencies": { "@types/node": "^26.2.0" }
}
EOF
run_check "$FIXTURE"
expect_rc 1 "$rc"
expect_stderr "package.json → ^26.2.0 (major 26"
end

# A directory under apps/ that holds no package.json is not a package, and must not turn the
# census into a refusal.
begin "a directory under apps/ with no package.json is not a manifest"
must fixture stray_directory
must write_nvmrc 22
must typed_pkg packages/store '^22.20.1'
must mkdir -p "$FIXTURE/apps/scratch/src"
must touch "$FIXTURE/apps/README.md"
run_check "$FIXTURE"
expect_rc 0 "$rc"
expect_stdout "check-node-types: OK — ^22.20.1, 1 manifests, .nvmrc major 22"
end

# ==========================================================================================

finish
