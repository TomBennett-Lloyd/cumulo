#!/usr/bin/env bash
# Test harness for check-aws-test-guard.sh, its neighbour in this directory.
#
# Self-contained on purpose (same shape as check-supply-chain-policy.test.sh next
# door): no test framework, no network, no pnpm, no install. Every fixture is a
# throwaway workspace of two or three package.json files under a single
# `mktemp -d` that a trap deletes on exit — so the shapes this gate exists to
# catch are exercised for real, without this repo ever having to hold a package
# that reaches AWS with no guard on it.
#
# The case that matters most is the transitive one. apps/api, apps/forecast and
# packages/hindcast name no `@aws-sdk/*` dependency at all; they reach the SDK
# only through `@cumulo/storage`, and they are exactly the packages whose tests
# constructed the live clients behind #124. A census that stopped at direct
# dependencies would find the two obvious packages, print OK, and leave those
# three uncovered — green, and wrong. So "a package whose only AWS reach is a
# workspace dependency is still required to carry the guard" gets its own
# fixture, and removing the closure walk from the gate has to make it fail.
#
# One case deliberately runs the gate with NO argument, against the real repo:
# every other case pins REPO_ROOT to a fixture, so without it the shipped default
# path could be broken and the suite would still be green (testing.md rule 7).
# That case is also the only one that asserts the real census — five packages —
# and it is meant to go red the day a sixth package reaches the SDK unguarded.
#
# Usage: bash .claude/scripts/check-aws-test-guard.test.sh  (or `pnpm test:scripts`)
# Exit:  0 every case PASS, 1 at least one FAIL, 2 the harness itself broke.
set -uo pipefail

SCRIPTS=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd) || exit 2
CHECK="$SCRIPTS/check-aws-test-guard.sh"

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
FIXTURE=""

# The gate has to survive the oldest bash it can meet, and the interpreter is not
# a detail: under `set -u`, bash 3.2 (which macOS ships as /bin/bash) aborts where
# 4.4+ shrugs. This gate builds arrays, reads a here-string field by field and
# holds a here-document in a variable, so the cases exercising those run under
# every distinct bash on the box.
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

# A fixture is a workspace root holding apps/ and packages/ directories, built one
# manifest at a time so each case's shape is readable in the case itself rather
# than in a shared builder with flags.
fixture() { # fixture <name> -> creates the workspace root and points FIXTURE at it
  FIXTURE="$TMP_ROOT/$1"
  mkdir -p "$FIXTURE"
}

write_pkg() { # write_pkg <dir under the fixture>; package.json body on stdin
  mkdir -p "$FIXTURE/$1" || return 1
  cat >"$FIXTURE/$1/package.json"
}

# The filename is a parameter because which config file the gate reads is itself
# under test: vitest prefers vitest.config.ts and falls back to vite.config.ts,
# and both halves of that need fixtures.
write_config() { # write_config <dir under the fixture> [filename, default vitest.config.ts]; body on stdin
  mkdir -p "$FIXTURE/$1" || return 1
  cat >"$FIXTURE/$1/${2:-vitest.config.ts}"
}

# The conforming config: what a covered package looks like. The path is a
# reference, not an import, which is why a text token is what the gate looks for.
guarded_config() { # guarded_config <dir under the fixture>
  write_config "$1" <<'EOF'
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['../../packages/store/src/aws-test-guard.setup.ts'],
  },
});
EOF
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
begin "check-aws-test-guard.sh parses (bash -n)"
for interpreter in $BASHES; do
  case_ctx="$interpreter"
  if ! syntax=$("$interpreter" -n "$CHECK" 2>&1); then
    bad "check-aws-test-guard.sh failed -n: $syntax"
  fi
done
case_ctx=""
end

# ==========================================================================================
# 2. the real repo, via the shipped default path (no argument)
# ==========================================================================================
# The production configuration: no REPO_ROOT override, so this is the only case that can
# catch a broken default path — and it is what `pnpm verify` actually runs. The five names
# are asserted individually rather than as a count, because "five packages, one of them the
# wrong five" is the census failure this gate exists to make impossible.
begin "the repo's own workspace passes with no argument, naming all five AWS-touching packages"
for interpreter in $BASHES; do
  case_ctx="$interpreter"
  run_check_with "$interpreter"
  expect_rc 0 "$rc"
  expect_out "check-aws-test-guard: OK"
  expect_out "packages/storage (@cumulo/storage)"
  expect_out "apps/ingestion (@cumulo/ingestion)"
  expect_out "apps/api (@cumulo/api)"
  expect_out "apps/forecast (@cumulo/forecast-service)"
  expect_out "packages/hindcast (@cumulo/hindcast)"
  expect_not_out "unbound variable"
  expect_not_out "ERROR"
done
case_ctx=""
end

# ==========================================================================================
# 3. (a) an AWS package carrying a conforming config passes
# ==========================================================================================
begin "a package with a direct @aws-sdk dependency and a guarded config passes"
must fixture direct_guarded
must write_pkg packages/store <<'EOF'
{
  "name": "@fixture/store",
  "dependencies": { "@aws-sdk/client-dynamodb": "^3.700.0" }
}
EOF
must guarded_config packages/store
run_check "$FIXTURE"
expect_rc 0 "$rc"
expect_out "check-aws-test-guard: OK"
expect_out "packages/store (@fixture/store) — via @aws-sdk/client-dynamodb"
expect_not_out "ERROR"
end

# ==========================================================================================
# 4. (b) an AWS package with no config at all is named
# ==========================================================================================
begin "a package with a direct @aws-sdk dependency and no vitest.config.ts fails, named"
must fixture direct_unguarded
must write_pkg packages/store <<'EOF'
{
  "name": "@fixture/store",
  "dependencies": { "@aws-sdk/client-dynamodb": "^3.700.0" }
}
EOF
run_check "$FIXTURE"
expect_rc 1 "$rc"
expect_out "1 of 1 AWS-touching package(s) do not load the AWS test guard"
expect_out "packages/store (@fixture/store) has no packages/store/vitest.config.ts"
expect_out "reaches the AWS SDK via @aws-sdk/client-dynamodb"
end

# ==========================================================================================
# 5. (c) THE CLOSURE: reach through a workspace dependency counts
# ==========================================================================================
# The api/forecast/hindcast shape, and the reason this gate is not a grep. `@fixture/app`
# names no AWS package anywhere in its manifest; it gets there through `@fixture/store`,
# whose guard does nothing for a client constructed in the consumer's own test process.
# Delete the closure walk from the gate and this case is the one that stops failing.
begin "a package whose only AWS reach is a workspace dependency is still required to carry the guard"
must fixture transitive_unguarded
must write_pkg packages/store <<'EOF'
{
  "name": "@fixture/store",
  "dependencies": { "@aws-sdk/client-dynamodb": "^3.700.0" }
}
EOF
must guarded_config packages/store
must write_pkg apps/consumer <<'EOF'
{
  "name": "@fixture/consumer",
  "dependencies": { "@fixture/store": "workspace:*" }
}
EOF
for interpreter in $BASHES; do
  case_ctx="$interpreter"
  run_check_with "$interpreter" "$FIXTURE"
  expect_rc 1 "$rc"
  expect_out "apps/consumer (@fixture/consumer) has no apps/consumer/vitest.config.ts"
  expect_out "reaches the AWS SDK via @fixture/store -> @aws-sdk/client-dynamodb"
  # The guarded package it reaches through is not the offender, and saying so would
  # send the reader to fix a file that is already right.
  expect_not_out "packages/store (@fixture/store) has"
  expect_not_out "unbound variable"
done
case_ctx=""
end

# ==========================================================================================
# 6. (d) a package with no AWS reach is not asked for a config
# ==========================================================================================
# Over-reach is how a gate gets itself suppressed. apps/web has no route to the SDK and
# must not be told to load a guard against a dependency it does not have.
begin "a package with no AWS in its closure needs no config"
must fixture no_reach
must write_pkg packages/store <<'EOF'
{
  "name": "@fixture/store",
  "dependencies": { "@aws-sdk/client-dynamodb": "^3.700.0" }
}
EOF
must guarded_config packages/store
must write_pkg apps/plain <<'EOF'
{
  "name": "@fixture/plain",
  "dependencies": { "zod": "^4.4.3" },
  "devDependencies": { "vitest": "^4.1.10" }
}
EOF
run_check "$FIXTURE"
expect_rc 0 "$rc"
expect_out "1 of 2 workspace package(s) reach the AWS SDK"
expect_not_out "apps/plain"
end

# ==========================================================================================
# 7. (e) a config that exists but never names the guard is not coverage
# ==========================================================================================
# The likeliest real shape of this: a package that already had a vitest.config.ts for some
# other reason — jsdom, an alias, a timeout — and grew its AWS reach afterwards.
begin "an AWS package whose vitest.config.ts omits the guard token fails, named"
must fixture token_missing
must write_pkg packages/store <<'EOF'
{
  "name": "@fixture/store",
  "dependencies": { "@aws-sdk/client-dynamodb": "^3.700.0" }
}
EOF
must write_config packages/store <<'EOF'
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    testTimeout: 15_000,
  },
});
EOF
run_check "$FIXTURE"
expect_rc 1 "$rc"
expect_out "packages/store (@fixture/store) has a vitest.config.ts that never mentions 'aws-test-guard.setup'"
expect_out "reaches the AWS SDK via @aws-sdk/client-dynamodb"
end

# ==========================================================================================
# 7b. the config filename is a list, in vitest's own precedence order
# ==========================================================================================
# apps/web's shape: vitest configured in the `test:` block of a vite.config.ts, because the
# suite needs the same `plugins: [react()]` the build uses and a separate vitest.config.ts
# would drop it. Insisting on the vitest.config.ts filename would mean the day such a package
# gains AWS reach, the only way to satisfy this gate is to break its component tests — so the
# fallback is accepted. Drop 'vite.config.ts' from CONFIG_NAMES and this case is the one that
# stops passing.
begin "an AWS package whose only config is a guarded vite.config.ts passes"
must fixture vite_config_guarded
must write_pkg packages/store <<'EOF'
{
  "name": "@fixture/store",
  "dependencies": { "@aws-sdk/client-dynamodb": "^3.700.0" }
}
EOF
must write_config packages/store vite.config.ts <<'EOF'
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  test: {
    setupFiles: ['../../packages/store/src/aws-test-guard.setup.ts'],
  },
});
EOF
run_check "$FIXTURE"
expect_rc 0 "$rc"
expect_out "check-aws-test-guard: OK"
expect_out "packages/store (@fixture/store) — via @aws-sdk/client-dynamodb"
expect_not_out "ERROR"
end

# The other half: accepting the filename must not mean accepting the package. A vite.config.ts
# is coverage only when the token is in it, exactly as for a vitest.config.ts.
begin "an AWS package whose only config is a vite.config.ts omitting the guard token fails, named"
must fixture vite_config_token_missing
must write_pkg packages/store <<'EOF'
{
  "name": "@fixture/store",
  "dependencies": { "@aws-sdk/client-dynamodb": "^3.700.0" }
}
EOF
must write_config packages/store vite.config.ts <<'EOF'
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'node',
  },
});
EOF
run_check "$FIXTURE"
expect_rc 1 "$rc"
expect_out "packages/store (@fixture/store) has a vite.config.ts that never mentions 'aws-test-guard.setup'"
expect_out "reaches the AWS SDK via @aws-sdk/client-dynamodb"
end

# Why the list is ORDERED rather than an any-of. When a package has both files, vitest reads
# vitest.config.ts and never looks at vite.config.ts's test block — so a token sitting in the
# shadowed file is coverage on paper and nothing at runtime. An any-of check would pass this
# fixture, which is the quietest way this widening could have gone wrong.
begin "a token in a vite.config.ts shadowed by a token-less vitest.config.ts is not coverage"
must fixture vite_config_shadowed
must write_pkg packages/store <<'EOF'
{
  "name": "@fixture/store",
  "dependencies": { "@aws-sdk/client-dynamodb": "^3.700.0" }
}
EOF
must write_config packages/store <<'EOF'
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
  },
});
EOF
must write_config packages/store vite.config.ts <<'EOF'
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['../../packages/store/src/aws-test-guard.setup.ts'],
  },
});
EOF
run_check "$FIXTURE"
expect_rc 1 "$rc"
expect_out "packages/store (@fixture/store) has a vitest.config.ts that never mentions 'aws-test-guard.setup'"
end

# ==========================================================================================
# 8. (f) THE CENSUS-DEATH GUARD: a scan that finds no AWS at all is broken, not clean
# ==========================================================================================
# Everything else in this gate reports "no violations" just as happily when the closure walk
# has broken, the dependency fields have been renamed, or the SDK prefix has changed under
# it. Those are the three ways it could stop covering anything without stopping running, and
# they all look like this fixture from the inside (#101: a dead gate is green).
begin "a workspace with no AWS-touching package at all exits 2, not 0"
must fixture no_aws_anywhere
must write_pkg packages/pure <<'EOF'
{
  "name": "@fixture/pure",
  "dependencies": { "zod": "^4.4.3" }
}
EOF
must write_pkg apps/plain <<'EOF'
{
  "name": "@fixture/plain",
  "dependencies": { "@fixture/pure": "workspace:*" }
}
EOF
run_check "$FIXTURE"
expect_rc 2 "$rc"
expect_out "none of the 2 workspace package(s) can reach the AWS SDK"
expect_out "refuses to pass on an empty census"
end

# ==========================================================================================
# 9. an AWS dependency declared as a devDependency counts
# ==========================================================================================
# Test-only AWS packages are the ones most likely to appear in a test process, which is the
# only process this gate is about. aws-sdk-client-mock sits in devDependencies in this repo.
begin "an @aws-sdk devDependency puts a package in the census"
must fixture dev_dependency
must write_pkg packages/toolkit <<'EOF'
{
  "name": "@fixture/toolkit",
  "devDependencies": { "@aws-sdk/client-sqs": "^3.1098.0" }
}
EOF
run_check "$FIXTURE"
expect_rc 1 "$rc"
expect_out "packages/toolkit (@fixture/toolkit) has no packages/toolkit/vitest.config.ts"
end

# ==========================================================================================
# 10. edges this gate must not follow, and one it must not be able to
# ==========================================================================================
# A registry dependency that happens to share a workspace package's name is not a workspace
# edge: following it would import reach from a package the consumer never links.
begin "a non-workspace version spec is not a workspace edge"
must fixture registry_spec
must write_pkg packages/store <<'EOF'
{
  "name": "@fixture/store",
  "dependencies": { "@aws-sdk/client-dynamodb": "^3.700.0" }
}
EOF
must guarded_config packages/store
must write_pkg apps/consumer <<'EOF'
{
  "name": "@fixture/consumer",
  "dependencies": { "@fixture/store": "^1.2.3" }
}
EOF
run_check "$FIXTURE"
expect_rc 0 "$rc"
expect_out "1 of 2 workspace package(s) reach the AWS SDK"
expect_not_out "apps/consumer"
end

# The backstop for this gate's one restated value — the `apps/*` and `packages/*` globs it
# scans, which pnpm-workspace.yaml owns. A workspace edge pointing somewhere the scan did
# not look means the globs have drifted, and the honest answer is no verdict: silently
# treating the target as AWS-free is how the census would go quietly wrong.
begin "a workspace: edge naming a package the scan never found exits 2, not 0"
must fixture unresolvable_edge
must write_pkg apps/consumer <<'EOF'
{
  "name": "@fixture/consumer",
  "dependencies": { "@fixture/elsewhere": "workspace:*" }
}
EOF
must write_pkg packages/store <<'EOF'
{
  "name": "@fixture/store",
  "dependencies": { "@aws-sdk/client-dynamodb": "^3.700.0" }
}
EOF
must guarded_config packages/store
run_check "$FIXTURE"
expect_rc 2 "$rc"
expect_out "declares a workspace dependency on @fixture/elsewhere"
expect_out "widen this gate's package globs"
end

# A dependency cycle is legal in a pnpm workspace and fatal to a naive walk. This case would
# hang rather than fail, so a timeout is not needed to make the point — but it is the reason
# the walk carries a visited set.
begin "a cycle between workspace packages terminates and still finds the reach"
must fixture cycle
must write_pkg packages/store <<'EOF'
{
  "name": "@fixture/store",
  "dependencies": { "@aws-sdk/client-dynamodb": "^3.700.0", "@fixture/consumer": "workspace:*" }
}
EOF
must guarded_config packages/store
must write_pkg apps/consumer <<'EOF'
{
  "name": "@fixture/consumer",
  "dependencies": { "@fixture/store": "workspace:*" }
}
EOF
run_check "$FIXTURE"
expect_rc 1 "$rc"
expect_out "apps/consumer (@fixture/consumer) has no apps/consumer/vitest.config.ts"
expect_out "reaches the AWS SDK via @fixture/store -> @aws-sdk/client-dynamodb"
end

# ==========================================================================================
# 11. directories that are not packages, and roots that are not workspaces
# ==========================================================================================
begin "a directory under apps/ with no package.json is not a package"
must fixture stray_directory
must write_pkg packages/store <<'EOF'
{
  "name": "@fixture/store",
  "dependencies": { "@aws-sdk/client-dynamodb": "^3.700.0" }
}
EOF
must guarded_config packages/store
must mkdir -p "$FIXTURE/apps/scratch/src"
must touch "$FIXTURE/apps/README.md"
run_check "$FIXTURE"
expect_rc 0 "$rc"
expect_out "1 of 1 workspace package(s) reach the AWS SDK"
end

begin "a root holding no packages at all exits 2, not 0"
must fixture empty_root
run_check "$FIXTURE"
expect_rc 2 "$rc"
expect_out "found no workspace packages under"
end

begin "a nonexistent root exits 2, not 1"
run_check "$TMP_ROOT/does-not-exist"
expect_rc 2 "$rc"
expect_out "not a directory"
end

# A manifest the census cannot read is not a package without AWS reach — it is a package
# nobody can give a verdict on, and skipping it is how one would slip through unguarded.
begin "an unparseable package.json exits 2, not 0"
must fixture broken_manifest
must write_pkg packages/store <<'EOF'
{
  "name": "@fixture/store",
  "dependencies": { "@aws-sdk/client-dynamodb": "^3.700.0" },
}
EOF
run_check "$FIXTURE"
expect_rc 2 "$rc"
expect_out "packages/store/package.json is not readable JSON"
end

# ==========================================================================================

printf '\n%d passed, %d failed\n' "$passed" "$failed"
[ "$failed" = "0" ] || exit 1
