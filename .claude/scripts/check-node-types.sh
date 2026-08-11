#!/usr/bin/env bash
# @types/node alignment gate: the manifests that declare an `@types/node` range
# must all declare the SAME one, its major must be the Node major `.nvmrc` pins,
# and anything depending on vite or vitest must be among them.
#
# Nothing here obliges a manifest to declare a range. A package that neither
# declares one nor depends on vite or vitest resolves no optional peer and is
# outside every claim this gate makes — the root manifest is the standing
# example, and the third clause above is exactly the rule for who cannot opt out.
#
# The shape this exists for (#407). `@types/node` had drifted to five ranges
# across two majors while `.nvmrc` pinned Node 22, so two packages type-checked
# against library definitions describing APIs the runtime does not have — a
# compile-time promise nothing in the build could keep. Nothing went red. The
# only visible trace was in the lockfile: three resolutions of one package, and a
# peer-resolved `vite`/`vitest` variant for each of them.
#
# RULE-9 FRAMING (docs/standards/architecture.md rule 9): `.nvmrc` OWNS the Node
# major. Every `@types/node` range in the workspace is a restatement of it, and
# this gate is what makes them CHECKED restatements rather than copies that
# happen to agree today. Bump `.nvmrc` and the ranges go red until they follow;
# that redness is the mechanism, not an inconvenience.
#
# WHY A MANIFEST WITH NO `@types/node` AT ALL CAN BE AN OFFENDER. vite and vitest
# each declare an OPTIONAL peer dependency on `@types/node`. A package that
# depends on either and declares no range of its own has not opted out of
# `@types/node` — it has left the choice to pnpm, which resolves that peer to
# whatever is newest and records it in the lockfile where nobody reads it. That
# was `packages/shared`: aligning every manifest that DID declare a range left a
# major-26 resolution alive anyway, resolved on behalf of a manifest that never
# mentioned the package. So a manifest declaring vite or vitest and no
# `@types/node` is named here and exits 1. That shape is the cause of the drift,
# and a gate that catches only the drift is a gate waiting for it to recur.
#
# SCOPE LIMITS, stated because the OK line does not say them:
#
#   * This gate proves the DECLARED ranges — what the manifests ask for. It says
#     nothing about what is installed, what `pnpm-lock.yaml` resolved, or what
#     any particular `node_modules` holds. Aligned manifests over a lockfile
#     still carrying two majors is a state this gate calls OK, because that is a
#     question it does not ask; `pnpm install` and the lockfile diff own that
#     half. The declared-vs-effective distinction is the one #158 names, and it
#     is the usual seam in this family of gates (check-supply-chain-policy.sh
#     carries the same limit against pnpm's effective config).
#   * DEPENDENCY POSITION, the standing question #158 owns. The manifests are
#     read with `node`, exactly as check-aws-test-guard.sh reads them and for its
#     stated reason: a JSON reader written in bash is a reader that is wrong
#     about some manifest nobody has written yet. `.nvmrc` is read in bash as a
#     single trimmed token — that is not a line-shape approximation of a nested
#     grammar, it is the file's entire format, so it needs no reader at all.
#     Whether the check scripts as a family should depend on `node` is #158's to
#     settle; this is the local position, recorded rather than assumed.
#   * Manifests are the root `package.json` plus every `apps/*` and `packages/*`
#     directory holding one — the globs `pnpm-workspace.yaml` declares, restated
#     here because reading them would mean parsing YAML (the same restatement,
#     for the same reason, as check-aws-test-guard.sh).
#   * Both the `@types/node` declaration and the vite/vitest tell are looked for
#     in `dependencies`, `devDependencies`, `optionalDependencies` and
#     `peerDependencies`. The wide field list has a known cost on the tell: a
#     plugin package that PEER-depends on vite — declaring the tool without ever
#     resolving its peers — would be asked here for a range it does not strictly
#     need. No package in this repo has that shape; narrowing the tell is one
#     line in TOOL_FIELDS below plus a harness case.
#
# Wired into the root `verify` composite (CLAUDE.md: gates join `verify`, never a
# hand-picked subset), so `pnpm verify`, the CI `checks` job and any human
# running the composite all enforce it. It reads committed files only — no
# install, no network — so its position within that chain is not load-bearing.
#
# Usage: bash .claude/scripts/check-node-types.sh [REPO_ROOT]
#        (or `pnpm check:node-types`)
#        REPO_ROOT defaults to the repo root above this script; the argument
#        exists so the test harness can point the gate at throwaway fixtures.
# Exit:  0 the ranges agree with each other and with .nvmrc, 1 at least one does
#        not (wrong major, divergent ranges, or a vite/vitest package declaring
#        no range), 2 the gate could not reach a verdict (bad invocation, no
#        node, an unreadable manifest, an .nvmrc or a spec it cannot extract a
#        major from, or a census that came back empty — see the census-death
#        guard below).
set -uo pipefail
# Homebrew's prefix is not on a non-interactive shell's default PATH on this
# machine (same reason lint-shell.sh and run-script-tests.sh do it). Harmless on
# Linux, where the directory does not exist.
export PATH="/opt/homebrew/bin:$PATH"

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd) || exit 2
ROOT=${1:-"$SCRIPT_DIR/../.."}

if [ ! -d "$ROOT" ]; then
  printf 'check-node-types: not a directory: %s\n' "$ROOT" >&2
  exit 2
fi
ROOT=$(cd "$ROOT" && pwd -P) || exit 2

# --- the major .nvmrc owns -----------------------------------------------------------------

NVMRC="$ROOT/.nvmrc"

if [ ! -f "$NVMRC" ]; then
  printf 'check-node-types: no .nvmrc under %s — refusing to report a pass\n' "$ROOT" >&2
  printf '  .nvmrc owns the Node major that every @types/node range restates. Without\n' >&2
  printf '  it there is nothing to check those ranges against, and ranges agreeing with\n' >&2
  printf '  each other is not the same claim as ranges agreeing with the runtime.\n' >&2
  exit 2
fi

nvmrc_raw=$(cat "$NVMRC") || exit 2
# The whole format is one version token, so the only normalisation is stripping
# surrounding whitespace and a CRLF's carriage return. Anything left over —
# a second line, a `lts/*` alias, an empty file — falls through to the refusal
# below rather than being guessed at.
nvmrc_token=$(printf '%s' "$nvmrc_raw" | tr -d '\r' | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')

NVMRC_RE='^v?([0-9]+)(\.[0-9]+){0,2}$'
NVMRC_MAJOR=''
if [[ $nvmrc_token =~ $NVMRC_RE ]]; then
  NVMRC_MAJOR="${BASH_REMATCH[1]}"
fi

if [ -z "$NVMRC_MAJOR" ]; then
  printf 'check-node-types: cannot read a Node major out of .nvmrc: %s\n' "'$nvmrc_token'" >&2
  printf '\n  Recognised forms are a bare major, or a version with a leading v:\n' >&2
  printf '    22    22.11    v22.11.0\n' >&2
  printf '  An alias (lts/jod, lts/*, node) names a major that changes under the repo\n' >&2
  printf '  without the file changing, so there is no fixed major here to check the\n' >&2
  printf '  @types/node ranges against. Refusing rather than guessing: a gate that\n' >&2
  printf '  guesses the thing it is checking against reports agreements it never had.\n' >&2
  exit 2
fi

# --- the manifests -------------------------------------------------------------------------

if ! command -v node >/dev/null 2>&1; then
  printf 'check-node-types: node is not on PATH — refusing to report a pass\n' >&2
  printf '  The census reads package.json files, and a missing interpreter is\n' >&2
  printf '  indistinguishable from a clean run if the gate skips. Node >=22 is\n' >&2
  printf '  already required to build this repo (see engines in package.json).\n' >&2
  exit 2
fi

# The census runs in node because the inputs are JSON (see the dependency-position
# note in the header). It emits TAB-separated records, in manifest order:
#
#     D <manifest path> <dependency field> <spec>   one @types/node declaration
#     X <manifest path> <tool names>                declares vite/vitest, declares no @types/node
#
# Read into a variable with `read -d ''` rather than `$(cat <<'NODE' … )`: bash
# parses backticks inside a command substitution even when the here-document
# delimiter is quoted, and this program is one template literal away from that
# trap at any edit. `read` hits end-of-input without a NUL and returns 1 having
# assigned the whole thing, which is why the `|| true` is there and not a mistake.
CENSUS_PROGRAM=''
IFS= read -r -d '' CENSUS_PROGRAM <<'NODE' || true
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const root = process.argv[1];
const GROUPS = ['apps', 'packages'];
const TYPES_PACKAGE = '@types/node';
const TYPES_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
// TOOL_FIELDS: the fields the vite/vitest tell is looked for in. Narrowing this
// is the one-line change the header's fourth scope limit describes.
const TOOL_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
const TOOL_PACKAGES = ['vite', 'vitest'];
const SEPARATORS = /[\t\n\r]/;

const refuse = (message) => {
  process.stderr.write(`check-node-types: ${message}\n`);
  process.exit(2);
};

const readManifest = (rel) => {
  let text;
  try {
    text = fs.readFileSync(path.join(root, rel), 'utf8');
  } catch (error) {
    // No manifest, or the "directory" turned out not to be one: not a package,
    // and not this gate's business. Anything else is a real read failure.
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return undefined;
    return refuse(`cannot read ${rel}: ${error.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    return refuse(`${rel} is not readable JSON: ${error.message}`);
  }
};

const blockOf = (manifest, rel, field) => {
  const block = manifest[field];
  if (block === undefined || block === null) return undefined;
  if (typeof block !== 'object' || Array.isArray(block)) {
    return refuse(`${rel} has a "${field}" that is not an object`);
  }
  return block;
};

const manifestPaths = ['package.json'];
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
  for (const entry of names) manifestPaths.push(`${group}/${entry}/package.json`);
}

const records = [];
for (const rel of manifestPaths) {
  const manifest = readManifest(rel);
  if (manifest === undefined) continue;
  if (SEPARATORS.test(rel)) {
    refuse(`${rel} contains whitespace this gate uses as a field separator`);
  }

  const declarations = [];
  for (const field of TYPES_FIELDS) {
    const block = blockOf(manifest, rel, field);
    if (block === undefined) continue;
    const spec = block[TYPES_PACKAGE];
    if (spec === undefined) continue;
    if (typeof spec !== 'string' || spec.length === 0 || SEPARATORS.test(spec)) {
      refuse(
        `${rel} declares ${TYPES_PACKAGE} in "${field}" as something that is not a ` +
          `version spec: ${JSON.stringify(spec)}`,
      );
    }
    declarations.push([field, spec]);
  }

  const tools = [];
  for (const field of TOOL_FIELDS) {
    const block = blockOf(manifest, rel, field);
    if (block === undefined) continue;
    for (const tool of TOOL_PACKAGES) {
      if (block[tool] !== undefined && !tools.includes(tool)) tools.push(tool);
    }
  }

  for (const [field, spec] of declarations) records.push(['D', rel, field, spec].join('\t'));
  // The tell only matters where there is no declaration to check: a package that
  // depends on vite AND declares a range is already covered by the two verdicts
  // above it, and naming it twice would send a reader to a file that is right.
  if (declarations.length === 0 && tools.length > 0) {
    records.push(['X', rel, tools.join(' and ')].join('\t'));
  }
}

process.stdout.write(records.length > 0 ? `${records.join('\n')}\n` : '');
NODE

census=$(node -e "$CENSUS_PROGRAM" "$ROOT")
census_rc=$?
if [ "$census_rc" -ne 0 ]; then
  printf 'check-node-types: the manifest census did not complete (node exited %d)\n' "$census_rc" >&2
  printf '  Its own error is above. No census, no verdict.\n' >&2
  exit 2
fi

# A spec this gate can extract a major from: an optional `~`/`^`, then a major,
# then up to two more numeric-or-`x` parts. Everything else — `*`, `>=22`,
# `catalog:`, a dist-tag, a two-sided range — is refused rather than guessed at,
# because every one of them can name several majors and the gate's whole claim is
# about which major is named.
SPEC_RE='^[~^]?[0-9]+(\.([0-9]+|x)){0,2}$'

# declaring_manifests counts the manifests that DECLARE a range — not the
# manifests scanned. The two differ by every workspace package that neither
# declares @types/node nor pulls in vite or vitest, which this gate has nothing
# to say about; the OK line names the count for what it is so that nobody reads
# it as a workspace census. Census death is the guard's job below, not this
# number's.
declaration_count=0
declaring_manifests=0
last_manifest=''
distinct_specs=''
distinct_count=0
all_declarations=()
mismatched=()
tool_offenders=()

# A here-string built from the captured output rather than a pipe: a `while` on
# the right of a pipe runs in a subshell, and the arrays it fills would be gone
# by the time the verdict below reads them. `detail` is the dependency field on a
# D record and the tool names on an X record.
while IFS=$'\t' read -r kind rel detail spec; do
  [ -n "$kind" ] || continue
  case "$kind" in
    D)
      if [ "$rel" != "$last_manifest" ]; then
        declaring_manifests=$((declaring_manifests + 1))
        last_manifest="$rel"
      fi
      declaration_count=$((declaration_count + 1))

      if [[ ! $spec =~ $SPEC_RE ]]; then
        printf 'check-node-types: cannot read a Node major out of %s in %s ("%s")\n' \
          "'$spec'" "$rel" "$detail" >&2
        printf '\n  Recognised specs are an optional ~ or ^, a major, and up to two more\n' >&2
        printf '  numeric or x parts: 22  ^22.20.1  ~22.20  22.x\n' >&2
        printf '  A spec that can satisfy more than one major cannot be checked against\n' >&2
        printf '  the one .nvmrc pins, and a gate that guessed would be approving an\n' >&2
        printf '  agreement it never established.\n' >&2
        exit 2
      fi

      spec_major=${spec#[~^]}
      spec_major=${spec_major%%.*}
      if [ "$spec_major" != "$NVMRC_MAJOR" ]; then
        mismatched+=("$rel → $spec (major $spec_major, in $detail)")
      fi

      case " $distinct_specs " in
        *" $spec "*) ;;
        *)
          distinct_specs="${distinct_specs:+$distinct_specs }$spec"
          distinct_count=$((distinct_count + 1))
          ;;
      esac
      all_declarations+=("$rel → $spec (in $detail)")
      ;;
    X)
      tool_offenders+=("$rel declares $detail and no @types/node")
      ;;
    *)
      printf 'check-node-types: unreadable census record, starting %s\n' "$kind" >&2
      exit 2
      ;;
  esac
done <<EOF
$census
EOF

# --- the verdict ---------------------------------------------------------------------------

# The census-death guard (#101: a dead gate is green). Everything below reports
# "no violations" just as happily when the manifest enumeration has broken, the
# dependency fields have been renamed, or the package has stopped being spelled
# @types/node — the three ways this gate could stop covering anything without
# stopping running. Every workspace package here declares a range today, so an
# empty scan is a broken scan, not a clean repo.
#
# UNLESS the scan already explains its own emptiness. A workspace where nothing
# declares a range and something depends on vite or vitest is not a mystery about
# a broken scan — it is precisely the shape the third verdict below exists for,
# fully diagnosed, with the offenders already collected. Refusing there would
# answer the reader's real defect with "delete the gate", which is both wrong and
# the most expensive kind of wrong: it argues for removing the check at the one
# moment it has something true to say. So the guard fires only when the scan
# found NEITHER a declaration nor a reason one should exist.
if [ "$declaration_count" -eq 0 ] && [ ${#tool_offenders[@]} -eq 0 ]; then
  printf 'check-node-types: no manifest under %s declares @types/node\n' "$ROOT" >&2
  printf '\n  This gate refuses to pass on an empty census. A workspace that genuinely\n' >&2
  printf '  has no TypeScript and no vite/vitest does not need it — delete the gate and\n' >&2
  printf '  say so in the PR. Short of that, the likelier readings are that the apps/\n' >&2
  printf '  and packages/ enumeration stopped matching the workspace globs, or that the\n' >&2
  printf '  dependency fields it reads were renamed under it.\n' >&2
  exit 2
fi

failed=0

if [ ${#mismatched[@]} -ne 0 ]; then
  printf '\ncheck-node-types: %d @types/node range(s) name a major other than the .nvmrc major (%s)\n' \
    "${#mismatched[@]}" "$NVMRC_MAJOR" >&2
  for offender in "${mismatched[@]}"; do
    printf '  ERROR %s\n' "$offender" >&2
  done
  printf '\nTypes ahead of the runtime are the dangerous direction: the compiler promises\n' >&2
  printf 'APIs that are simply absent at run time, and nothing in the build says so.\n' >&2
  printf '.nvmrc owns the major (currently %s); the ranges restate it. Move the ranges to\n' \
    "$NVMRC_MAJOR" >&2
  printf 'match it, or move .nvmrc deliberately and bring every range with it.\n' >&2
  failed=1
fi

if [ "$distinct_count" -gt 1 ]; then
  printf '\ncheck-node-types: %d different @types/node ranges across %d manifest(s)\n' \
    "$distinct_count" "$declaring_manifests" >&2
  for entry in "${all_declarations[@]}"; do
    printf '  ERROR %s\n' "$entry" >&2
  done
  printf '\nOne workspace, one range. Divergent ranges within a single major still make\n' >&2
  printf 'pnpm resolve several copies and give vite and vitest several peer variants to\n' >&2
  printf 'carry, so which definitions a package compiles against depends on which\n' >&2
  printf 'manifest it happens to sit next to. Pick one string and use it verbatim.\n' >&2
  failed=1
fi

if [ ${#tool_offenders[@]} -ne 0 ]; then
  printf '\ncheck-node-types: %d manifest(s) depend on vite or vitest without declaring @types/node\n' \
    "${#tool_offenders[@]}" >&2
  for offender in "${tool_offenders[@]}"; do
    printf '  ERROR %s\n' "$offender" >&2
  done
  printf '\nThat is not opting out of @types/node — vite and vitest declare it as an\n' >&2
  printf 'optional peer dependency, so pnpm resolves one anyway, unconstrained, and\n' >&2
  printf 'records it in the lockfile. It is how this drift started (#407). Declare the\n' >&2
  printf 'same range the other manifests use.\n' >&2
  failed=1
fi

if [ "$failed" -ne 0 ]; then
  exit 1
fi

printf 'check-node-types: OK — %s in %d manifest(s) declaring it, .nvmrc major %s\n' \
  "$distinct_specs" "$declaring_manifests" "$NVMRC_MAJOR"
