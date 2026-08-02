#!/usr/bin/env bash
# AWS test-guard census: every workspace package that can reach the AWS SDK must
# load the test guard from its own vitest config.
#
# What the guard is, and why coverage needs a gate at all (#128). The AWS SDK
# resolves credentials and endpoints lazily, on the first `send` — so a unit test
# whose mock slips, or whose endpoint override is cleared at the wrong moment,
# silently promotes itself into a live call against whatever identity the machine
# happens to be logged in as. #124 shipped exactly that by accident: a real
# PutItem and a real SendMessage from what everybody believed was a unit test.
# The fix is a vitest `setupFiles` module (packages/storage/src/aws-test-guard.setup.ts)
# that pins credentials to recognisable sentinels and aims the endpoint at a
# loopback port nothing listens on, so an unmocked call dies offline and loud.
#
# That fix is per-package configuration, which means its coverage is exactly as
# good as somebody's memory. A package added next month, or an existing package
# that grows its first `@aws-sdk/*` reach, is unguarded and nothing says so — the
# suites stay green either way, which is the #101 shape: a gate that has stopped
# covering something looks identical to a gate with nothing to cover. So the
# census is computed rather than listed, from the dependency graph, on every
# `verify`.
#
# The load-bearing part is the TRANSITIVE closure. Only two packages name an
# `@aws-sdk/*` dependency directly (packages/storage, apps/ingestion); apps/api,
# apps/forecast and packages/hindcast reach the SDK solely through
# `@cumulo/storage`, and all three construct a real client at module scope that
# their own tests import. A census that read direct dependencies only would find
# two packages, report OK, and leave the three that actually caused #124's
# incident uncovered.
#
# SCOPE LIMITS, stated because the OK line does not say them:
#
#   * This gate proves a package's vitest.config.ts REFERENCES the guard — the
#     token `aws-test-guard.setup` appears in its text. It does not prove the
#     reference resolves, that vitest loads it, or that the guard's contents
#     still neutralise anything. That half is owned by the per-package guard
#     tests (packages/storage/src/aws-test-guard.test.ts and its siblings), which
#     probe a real client and assert the sentinel credentials and the refused
#     connection. Two halves, deliberately: this one cannot be satisfied by a
#     test that was never written, and that one cannot be satisfied by a package
#     nobody remembered to wire up.
#   * Packages are enumerated as the directories under `apps/` and `packages/`
#     holding a package.json — the globs pnpm-workspace.yaml declares, restated
#     here because reading them would mean parsing YAML. Restated, not derived,
#     so it can drift; the backstop is the refusal below on a `workspace:` edge
#     pointing at a package this scan did not find, which is what a drifted glob
#     looks like from the inside.
#   * Dependency edges come from `dependencies` and `devDependencies`. A package
#     reaching the SDK only through `peerDependencies` or `optionalDependencies`
#     would not be seen; no package in this repo does, and widening the fields is
#     a one-word change here plus a harness case.
#
# Wired into the root `verify` composite (CLAUDE.md: gates join `verify`, never a
# hand-picked subset), so `pnpm verify`, the CI `checks` job and any human
# running the composite all enforce it.
#
# Usage: bash .claude/scripts/check-aws-test-guard.sh [REPO_ROOT]
#        (or `pnpm check:aws-test-guard`)
#        REPO_ROOT defaults to the repo root above this script; the argument
#        exists so the test harness can point the gate at throwaway fixtures.
# Exit:  0 every AWS-touching package carries the guard, 1 at least one does not,
#        2 the gate could not reach a verdict (bad invocation, no node, a
#        manifest it could not read, an edge it could not follow, or a census
#        that came back empty — see the census-death guard at the bottom).
set -uo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd) || exit 2
ROOT=${1:-"$SCRIPT_DIR/../.."}

if [ ! -d "$ROOT" ]; then
  printf 'check-aws-test-guard: not a directory: %s\n' "$ROOT" >&2
  exit 2
fi
ROOT=$(cd "$ROOT" && pwd -P) || exit 2

# The token a covered package's vitest config must contain. It is the setup
# module's basename without an extension, so both the in-package path
# (`./src/aws-test-guard.setup.ts`) and the cross-package one
# (`../../packages/storage/src/aws-test-guard.setup.ts`) match it, and a rename
# of the setup file goes red here rather than passing on the old spelling.
GUARD_TOKEN='aws-test-guard.setup'
CONFIG_NAME='vitest.config.ts'

if ! command -v node >/dev/null 2>&1; then
  printf 'check-aws-test-guard: node is not on PATH — refusing to report a pass\n' >&2
  printf '  The census reads package.json files, and a missing interpreter is\n' >&2
  printf '  indistinguishable from a clean run if the gate skips. Node >=22 is\n' >&2
  printf '  already required to build this repo (see engines in package.json).\n' >&2
  exit 2
fi

# The census runs in node because the inputs are JSON, and a JSON reader written
# in bash is a reader that is wrong about some manifest nobody has written yet.
# It emits one TAB-separated record per workspace package:
#
#     P <dir> <name> <reach>
#
# where <reach> is empty for a package with no route to the AWS SDK, and
# otherwise the arrow-joined chain of dependency names that gets there — which is
# what makes the failure output actionable rather than an accusation.
#
# Read into a variable with `read -d ''` rather than `$(cat <<'NODE' … )`: the
# program below is full of JavaScript template literals, and bash parses the
# backticks inside a command substitution even when the here-document delimiter
# is quoted. `read` hits end-of-input without a NUL and returns 1 having assigned
# the whole thing, which is why the `|| true` is there and not a mistake.
CENSUS_PROGRAM=''
IFS= read -r -d '' CENSUS_PROGRAM <<'NODE' || true
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const root = process.argv[1];
const GROUPS = ['apps', 'packages'];
const DEP_FIELDS = ['dependencies', 'devDependencies'];
const AWS_PREFIX = '@aws-sdk/';
const SEPARATORS = /[\t\n\r]/;

const refuse = (message) => {
  process.stderr.write(`check-aws-test-guard: ${message}\n`);
  process.exit(2);
};

const readManifest = (dir) => {
  let text;
  try {
    text = fs.readFileSync(path.join(root, dir, 'package.json'), 'utf8');
  } catch (error) {
    // No manifest, or the "directory" turned out not to be one: not a package,
    // and not this gate's business. Anything else is a real read failure.
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return undefined;
    return refuse(`cannot read ${dir}/package.json: ${error.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    return refuse(`${dir}/package.json is not readable JSON: ${error.message}`);
  }
};

const depsOf = (manifest, dir) => {
  const deps = new Map();
  for (const field of DEP_FIELDS) {
    const block = manifest[field];
    if (block === undefined || block === null) continue;
    if (typeof block !== 'object' || Array.isArray(block)) {
      refuse(`${dir}/package.json has a "${field}" that is not an object`);
    }
    for (const [name, spec] of Object.entries(block)) {
      deps.set(name, typeof spec === 'string' ? spec : '');
    }
  }
  return deps;
};

const packages = [];
for (const group of GROUPS) {
  let entries;
  try {
    entries = fs.readdirSync(path.join(root, group), { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') continue;
    refuse(`cannot list ${group}/: ${error.message}`);
  }
  const names = entries
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .map((entry) => entry.name)
    .sort();
  for (const entry of names) {
    const dir = `${group}/${entry}`;
    const manifest = readManifest(dir);
    if (manifest === undefined) continue;
    const name =
      typeof manifest.name === 'string' && manifest.name.length > 0 ? manifest.name : dir;
    if (SEPARATORS.test(name) || SEPARATORS.test(dir)) {
      refuse(`${dir} or its package name contains whitespace this gate uses as a field separator`);
    }
    packages.push({ dir, name, deps: depsOf(manifest, dir) });
  }
}

const byName = new Map();
for (const pkg of packages) {
  const clash = byName.get(pkg.name);
  if (clash !== undefined) {
    refuse(`${clash.dir} and ${pkg.dir} both declare the package name ${pkg.name}`);
  }
  byName.set(pkg.name, pkg);
}

// Breadth-first over workspace edges, returning the first route to the SDK it
// finds — the shortest one, so the failure message names the nearest link a
// reader can act on. Without this walk the census sees only the two packages
// that depend on @aws-sdk/* by name and misses every package that reaches the
// SDK through @cumulo/storage, which is most of them.
const reachOf = (start) => {
  const seen = new Set([start.dir]);
  const queue = [[start, []]];
  while (queue.length > 0) {
    const [pkg, trail] = queue.shift();
    for (const [dep, spec] of pkg.deps) {
      if (dep.startsWith(AWS_PREFIX)) return [...trail, dep].join(' -> ');
      if (!spec.startsWith('workspace:')) continue;
      const target = byName.get(dep);
      if (target === undefined) {
        refuse(
          `${pkg.dir} declares a workspace dependency on ${dep}, which is not one of the ` +
            `${packages.length} package(s) this scan found under ` +
            `${GROUPS.map((group) => `${group}/*`).join(' and ')}. The edge cannot be followed, ` +
            `so no honest verdict is available for ${start.dir}: widen this gate's package ` +
            `globs to match pnpm-workspace.yaml.`,
        );
      }
      if (seen.has(target.dir)) continue;
      seen.add(target.dir);
      queue.push([target, [...trail, dep]]);
    }
  }
  return '';
};

const records = packages.map((pkg) => ['P', pkg.dir, pkg.name, reachOf(pkg)].join('\t'));
process.stdout.write(records.length > 0 ? `${records.join('\n')}\n` : '');
NODE

census=$(node -e "$CENSUS_PROGRAM" "$ROOT")
census_rc=$?
if [ "$census_rc" -ne 0 ]; then
  printf 'check-aws-test-guard: the workspace census did not complete (node exited %d)\n' \
    "$census_rc" >&2
  printf '  Its own error is above. No census, no verdict.\n' >&2
  exit 2
fi

package_count=0
covered=()
offenders=()

# A here-string built from the captured output rather than a pipe: a `while` on
# the right of a pipe runs in a subshell, and the arrays it fills would be gone
# by the time the verdict below reads them.
while IFS=$'\t' read -r kind dir name reach; do
  [ -n "$kind" ] || continue
  if [ "$kind" != 'P' ]; then
    printf 'check-aws-test-guard: unreadable census record, starting %s\n' "$kind" >&2
    exit 2
  fi
  package_count=$((package_count + 1))
  # No route to the SDK: the guard is not required, and requiring it anyway is
  # how a gate teaches people to paste config they do not need.
  [ -n "$reach" ] || continue

  config="$dir/$CONFIG_NAME"
  if [ ! -f "$ROOT/$config" ]; then
    offenders+=("$dir ($name) has no $config"$'\n'"        reaches the AWS SDK via $reach")
  elif ! grep -qF -- "$GUARD_TOKEN" "$ROOT/$config"; then
    offenders+=("$dir ($name) has a $CONFIG_NAME that never mentions '$GUARD_TOKEN'"$'\n'"        reaches the AWS SDK via $reach")
  else
    covered+=("$dir ($name) — via $reach")
  fi
done <<EOF
$census
EOF

# --- the verdict --------------------------------------------------------------------------

if [ "$package_count" -eq 0 ]; then
  printf 'check-aws-test-guard: found no workspace packages under %s\n' "$ROOT" >&2
  printf '  Every package.json this gate reads lives under apps/ or packages/. Finding\n' >&2
  printf '  none means the scan is pointed somewhere wrong, not that the repo is clean.\n' >&2
  exit 2
fi

aws_count=$((${#covered[@]} + ${#offenders[@]}))

# The census-death guard (#101: a dead gate is green). Everything above this line
# reports "no violations" just as happily when the closure walk has been broken,
# the dependency fields renamed, or the SDK prefix changed under it — the three
# ways this gate could stop covering anything without stopping running. This repo
# has five AWS-touching packages; zero is not a clean bill of health, it is a
# scan that found nothing, and the two are only distinguishable here.
if [ "$aws_count" -eq 0 ]; then
  printf 'check-aws-test-guard: none of the %d workspace package(s) can reach the AWS SDK\n' \
    "$package_count" >&2
  printf '\n  This gate refuses to pass on an empty census. A repo with genuinely no AWS\n' >&2
  printf '  dependency does not need it — delete the gate and say so in the PR. Short of\n' >&2
  printf '  that, the likelier readings are that the dependency-graph walk broke, that\n' >&2
  printf '  @aws-sdk/* stopped being how the SDK is named, or that the packages moved\n' >&2
  printf '  out from under apps/ and packages/.\n' >&2
  exit 2
fi

if [ ${#offenders[@]} -ne 0 ]; then
  printf '\ncheck-aws-test-guard: %d of %d AWS-touching package(s) do not load the AWS test guard\n' \
    "${#offenders[@]}" "$aws_count" >&2
  for offender in "${offenders[@]}"; do
    printf '  ERROR %s\n' "$offender" >&2
  done
  printf '\nA test in these packages can reach real AWS on whatever credentials the machine\n' >&2
  printf 'is carrying — the #124 failure, which cost a live PutItem and a live SendMessage.\n' >&2
  printf 'Give each one a %s whose test.setupFiles names the guard:\n\n' "$CONFIG_NAME" >&2
  printf "    setupFiles: ['../../packages/storage/src/%s.ts'],\n\n" "$GUARD_TOKEN" >&2
  printf 'adjusting the relative path, and add the package its own guard test — this gate\n' >&2
  printf 'checks that the config points at the guard, not that the guard still works.\n' >&2
  exit 1
fi

printf 'check-aws-test-guard: OK — %d of %d workspace package(s) reach the AWS SDK, each loading the guard from its own %s\n' \
  "$aws_count" "$package_count" "$CONFIG_NAME"
for entry in "${covered[@]}"; do
  printf '  %s\n' "$entry"
done
