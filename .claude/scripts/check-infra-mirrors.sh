#!/usr/bin/env bash
# Infra-mirror gate: every TypeScript constant declared below as a mirror of a
# Terraform value must still equal that value.
#
# The shape this exists for (#123). `infra/ingestion/lambda.tf` sets the
# ingestion function's `timeout`, and `apps/ingestion/src/cycle-budget.ts`
# restates it as `INGESTION_LAMBDA_TIMEOUT_MS` so that the cycle deadline can be
# derived from it. Each file's comment cites the other by name, and until this
# gate existed that citation was the whole of the enforcement. Raising the
# Terraform timeout without moving the constant fails quietly in the safe
# direction — the deadline is merely more conservative than it needs to be —
# but *lowering* it reintroduces the mid-loop kill #115 was filed to eliminate,
# and reintroduces it invisibly: nothing goes red, the deadline simply stops
# being inside the timeout.
#
# Why a gate rather than deriving one side from the other. Terraform has no way
# to read a TypeScript constant: the bridges are a generated `*.auto.tfvars`
# (which is either committed, and then it is this same mirror with a generator
# in front of it, or regenerated before every plan, which makes every operator's
# plan depend on a pnpm step) or an `external` data source shelling out to node
# at plan time (the "works on one machine" infrastructure that lambda.tf's own
# artefact comment already rejects for the build). Both trade a checked mirror
# for an unchecked build-order dependency, and both move ownership of a number
# whose 40-line rationale lives in the Terraform file. So the mirror stays, and
# this gate is what makes it a mirror rather than a coincidence. Recorded in
# full in the PR for #123.
#
# Scope, stated because the OK line does not say it: this gate checks VALUES
# that must agree — a numeric Terraform attribute against a numeric TypeScript
# constant, with an explicit unit scale between them. It does not check names
# (a table name, a function name, a TTL attribute name), and it knows nothing
# about mirrors it has not been told about. Adding a pair is one line in
# MIRRORS below; a pair nobody adds is not covered, which is why the list sits
# in the file a reader of either mirrored file is pointed at.
#
# Wired into the root `verify` composite (CLAUDE.md: gates join `verify`, never a
# hand-picked subset), so `pnpm verify`, the CI `checks` job and any human
# running the composite all enforce it.
#
# No dependencies: bash (3.2, which macOS ships as /bin/bash) only. No
# terraform, no node, no HCL library — the readers below are deliberately small
# and deliberately brittle, and refuse (exit 2) any shape they do not recognise
# rather than skipping it. A reader that shrugs at a line it cannot parse is a
# gate that reports agreement it never established.
#
# Usage: bash .claude/scripts/check-infra-mirrors.sh [REPO_ROOT]
#        (or `pnpm check:infra-mirrors`)
#        REPO_ROOT defaults to the repo root above this script; the argument
#        exists so the test harness can point the gate at throwaway fixtures.
# Exit:  0 every declared pair agrees, 1 at least one has drifted, 2 the gate
#        could not reach a verdict (bad invocation, a missing file, a value it
#        could not find exactly once, or a malformed record below).
set -uo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd) || exit 2
ROOT=${1:-"$SCRIPT_DIR/../.."}

if [ ! -d "$ROOT" ]; then
  printf 'check-infra-mirrors: not a directory: %s\n' "$ROOT" >&2
  exit 2
fi
ROOT=$(cd "$ROOT" && pwd -P) || exit 2

# ==========================================================================================
# THE PAIR LIST — add a mirrored value here, and nowhere else.
# ==========================================================================================
#
# One record per mirrored value, six `|`-delimited fields:
#
#   <tf-file>|<resource-address>|<attribute>|<ts-file>|<constant>|<ts-per-tf>
#
#   tf-file           path from the repo root, e.g. infra/ingestion/lambda.tf
#   resource-address  <type>.<name> as Terraform addresses it, e.g.
#                     aws_lambda_function.ingestion
#   attribute         a top-level attribute of that resource block (an attribute
#                     nested inside a sub-block is deliberately NOT matched —
#                     see tf_attribute_value below)
#   ts-file           path from the repo root
#   constant          the name of an `export const <NAME> = <number>;` in it
#   ts-per-tf         how many of the constant's units are one Terraform unit.
#                     Both sides are integers, and the assertion is exactly
#                     `constant == attribute * ts-per-tf`, so seconds mirrored
#                     as milliseconds is 1000 and a same-unit pair is 1. The
#                     scale is declared rather than inferred because "300 vs
#                     300000" is only agreement if somebody says which unit is
#                     which.
#
# The next pairs are expected from #12's consumer (its function timeout is
# already coupled to `visibility_timeout_seconds` in
# infra/ingestion/transport.tf, which says so in prose) and from #16's archive
# backfill. Both are one line here.
MIRRORS=(
  "infra/ingestion/lambda.tf|aws_lambda_function.ingestion|timeout|apps/ingestion/src/cycle-budget.ts|INGESTION_LAMBDA_TIMEOUT_MS|1000"
)

# Green-by-absence, the failure mode a list-driven gate dies of: an empty list
# checks nothing and says so in the same words it would use for success.
if [ ${#MIRRORS[@]} -eq 0 ]; then
  printf 'check-infra-mirrors: the MIRRORS list is empty — nothing was checked\n' >&2
  printf '  A gate with no pairs is green by absence, not green. Either add the pair\n' >&2
  printf "  back or delete the gate and its entry in the 'verify' script.\n" >&2
  exit 2
fi

# --- shared text helpers -------------------------------------------------------------------

trim() { # trim <string> -> the string with leading and trailing whitespace removed
  local s=$1
  s=${s#"${s%%[![:space:]]*}"}
  s=${s%"${s##*[![:space:]]}"}
  printf '%s' "$s"
}

# Drops a trailing `# …` or `// …` comment from an HCL value. Anchored on
# whitespace before the marker, so a marker inside a quoted value is left alone
# — the numeric values this gate reads have none either way, but a reader that
# is right only for the input it has seen is the wrong kind of small.
strip_hcl_comment() { # strip_hcl_comment <value> -> the value without its comment
  local s=$1
  s=${s%%[[:space:]]#*}
  s=${s%%[[:space:]]//*}
  trim "$s"
}

# --- the Terraform side ----------------------------------------------------------------------

# Prints the value of <attr> declared directly inside `resource "<type>" "<name>"`.
# Anything other than exactly one such attribute in exactly one such block is a
# non-verdict, reported on stderr with a non-zero return.
#
# The block is delimited by `terraform fmt`'s canonical layout, which CI enforces
# on every push (`terraform fmt -check -recursive infra`): a top-level block's
# closing brace is a `}` alone at column 0, and its own attributes are indented
# exactly two spaces. That is what scopes the search to this resource — a
# same-named attribute in the next resource down is outside the block — and what
# keeps a nested block's attribute (indented four) from being read as the
# resource's own. Both properties have cases in the harness, because both are
# the difference between "the deployed value" and "a number that looked like it".
tf_attribute_value() { # tf_attribute_value <file> <type> <name> <attr>
  local file="$1" type="$2" name="$3" attr="$4"
  local line depth=0 headers=0 matches=0 value=""
  local header_re="^resource[[:space:]]+\"$type\"[[:space:]]+\"$name\"[[:space:]]*\{[[:space:]]*$"
  local close_re='^\}[[:space:]]*$'
  local attr_re="^  ${attr}[[:space:]]*=[[:space:]]*(.*)$"

  while IFS= read -r line || [ -n "$line" ]; do
    line=${line%$'\r'}
    if [ "$depth" -eq 0 ]; then
      if [[ $line =~ $header_re ]]; then
        depth=1
        headers=$((headers + 1))
      fi
      continue
    fi
    if [[ $line =~ $close_re ]]; then
      depth=0
      continue
    fi
    if [[ $line =~ $attr_re ]]; then
      matches=$((matches + 1))
      value=$(strip_hcl_comment "${BASH_REMATCH[1]}")
    fi
  done <"$file"

  if [ "$headers" -eq 0 ]; then
    printf 'check-infra-mirrors: %s declares no resource "%s" "%s"\n' "$file" "$type" "$name" >&2
    return 1
  fi
  if [ "$headers" -gt 1 ]; then
    printf 'check-infra-mirrors: %s declares resource "%s" "%s" %d times\n' \
      "$file" "$type" "$name" "$headers" >&2
    return 1
  fi
  if [ "$matches" -eq 0 ]; then
    printf "check-infra-mirrors: %s: '%s.%s' declares no top-level '%s' attribute\n" \
      "$file" "$type" "$name" "$attr" >&2
    printf '  Only attributes indented exactly two spaces inside the block count; one\n' >&2
    printf '  nested in a sub-block is a different value and is not read as this one.\n' >&2
    return 1
  fi
  if [ "$matches" -gt 1 ]; then
    printf "check-infra-mirrors: %s: '%s.%s' declares '%s' %d times\n" \
      "$file" "$type" "$name" "$attr" "$matches" >&2
    return 1
  fi
  if ! [[ $value =~ ^[0-9]+$ ]]; then
    printf "check-infra-mirrors: %s: '%s.%s'.%s is not a plain integer: %s\n" \
      "$file" "$type" "$name" "$attr" "${value:-<empty>}" >&2
    printf '  This gate compares numbers. An attribute that became an expression or a\n' >&2
    printf '  variable reference is a change of shape, and it wants a decision rather\n' >&2
    printf '  than a comparison this gate would have to guess at.\n' >&2
    return 1
  fi

  printf '%s' "$value"
}

# --- the TypeScript side ----------------------------------------------------------------------

# Prints the integer initialiser of `export const <name> = <number>;`, with any
# numeric separators removed. Exported on purpose: a mirror is a claim about a
# module's public surface, and a private constant is not one another file — or
# this gate — is entitled to hold Terraform to.
ts_constant_value() { # ts_constant_value <file> <name>
  local file="$1" name="$2"
  local line matches=0 value=""
  local const_re="^export const $name([[:space:]]*:[^=]*)?[[:space:]]*=[[:space:]]*([0-9][0-9_]*)[[:space:]]*;[[:space:]]*$"

  while IFS= read -r line || [ -n "$line" ]; do
    line=${line%$'\r'}
    if [[ $line =~ $const_re ]]; then
      matches=$((matches + 1))
      value=${BASH_REMATCH[2]//_/}
    fi
  done <"$file"

  if [ "$matches" -eq 0 ]; then
    printf "check-infra-mirrors: %s declares no 'export const %s = <integer>;'\n" "$file" "$name" >&2
    printf '  The declaration has to be exported, a plain integer literal, and on one\n' >&2
    printf '  line. A constant that became an expression is no longer a mirror of a\n' >&2
    printf '  Terraform value, and this gate refuses rather than guessing.\n' >&2
    return 1
  fi
  if [ "$matches" -gt 1 ]; then
    printf "check-infra-mirrors: %s declares 'export const %s' %d times\n" \
      "$file" "$name" "$matches" >&2
    return 1
  fi

  printf '%s' "$value"
}

# --- record validation ------------------------------------------------------------------------
#
# The field values are interpolated into the regexes above, so their alphabets
# are checked before they get there: a record is configuration, and a
# configuration typo must be a loud refusal rather than a pattern that quietly
# matches something else.

blockers=()
offenders=()
agreements=()

validate_field() { # validate_field <record-number> <label> <value> <extended-regex>
  local number="$1" label="$2" value="$3" pattern="$4"
  if [[ $value =~ $pattern ]]; then
    return 0
  fi
  blockers+=("MIRRORS[$number]: $label is not a well-formed $label: '${value:-<empty>}'")
  return 1
}

# --- the pass -----------------------------------------------------------------------------------

index=0
for record in "${MIRRORS[@]}"; do
  index=$((index + 1))

  IFS='|' read -r tf_file address attribute ts_file constant scale extra <<<"$record"
  if [ -n "${extra:-}" ] || [ -z "${scale:-}" ]; then
    blockers+=("MIRRORS[$index] is not six |-delimited fields: $record")
    continue
  fi

  ok=1
  validate_field "$index" "tf-file" "$tf_file" '^[A-Za-z0-9._/-]+$' || ok=0
  validate_field "$index" "resource-address" "$address" '^[a-z][a-z0-9_]*\.[A-Za-z_][A-Za-z0-9_-]*$' || ok=0
  validate_field "$index" "attribute" "$attribute" '^[a-z][a-z0-9_]*$' || ok=0
  validate_field "$index" "ts-file" "$ts_file" '^[A-Za-z0-9._/-]+$' || ok=0
  validate_field "$index" "constant" "$constant" '^[A-Za-z_][A-Za-z0-9_]*$' || ok=0
  validate_field "$index" "ts-per-tf" "$scale" '^[1-9][0-9]*$' || ok=0
  [ "$ok" -eq 1 ] || continue

  resource_type=${address%%.*}
  resource_name=${address#*.}

  if [ ! -f "$ROOT/$tf_file" ]; then
    blockers+=("no such file: $tf_file (declared by MIRRORS[$index])")
    continue
  fi
  if [ ! -f "$ROOT/$ts_file" ]; then
    blockers+=("no such file: $ts_file (declared by MIRRORS[$index])")
    continue
  fi

  if ! tf_value=$(tf_attribute_value "$ROOT/$tf_file" "$resource_type" "$resource_name" "$attribute"); then
    blockers+=("could not read $address.$attribute from $tf_file (error above)")
    continue
  fi
  if ! ts_value=$(ts_constant_value "$ROOT/$ts_file" "$constant"); then
    blockers+=("could not read $constant from $ts_file (error above)")
    continue
  fi

  expected=$((10#$tf_value * scale))
  actual=$((10#$ts_value))

  if [ "$actual" -ne "$expected" ]; then
    offenders+=("ERROR $tf_file  $address.$attribute = $tf_value")
    offenders+=("      $ts_file  $constant = $actual, but $tf_value * $scale = $expected")
  else
    agreements+=("$address.$attribute = $tf_value  ==  $constant = $actual  (x$scale)")
  fi
done

# --- the verdict ---------------------------------------------------------------------------------
#
# Blockers outrank drift: "I could not read one of these files" is not a verdict
# about whether they agree, and reporting it as one (either way) is the failure
# this gate exists to prevent one level up.

if [ ${#blockers[@]} -ne 0 ]; then
  printf '\ncheck-infra-mirrors: %d declared mirror(s) could not be checked\n' "${#blockers[@]}" >&2
  for blocker in "${blockers[@]}"; do
    printf '  BLOCKED %s\n' "$blocker" >&2
  done
  printf '\nA pair this gate cannot read is not a pair it has approved. Fix the record in\n' >&2
  printf '.claude/scripts/check-infra-mirrors.sh, or restore the declaration it names.\n' >&2
  exit 2
fi

if [ ${#offenders[@]} -ne 0 ]; then
  printf '\ncheck-infra-mirrors: mirrored value(s) out of step with Terraform\n' >&2
  for offender in "${offenders[@]}"; do
    printf '  %s\n' "$offender" >&2
  done
  printf '\nThese are one value written in two places on purpose, and each file cites the\n' >&2
  printf 'other. Move both or neither: the constant is what the code sizes itself\n' >&2
  printf 'against, so a Terraform-only change leaves the code budgeting for a limit\n' >&2
  printf 'that is no longer the limit — which is #115 all over again, and silent.\n' >&2
  exit 1
fi

# `${a[@]+…}`: bash 3.2 under `set -u` aborts on an empty array's `[@]`. Every
# record reaching here landed in exactly one of the three arrays, so this one
# cannot be empty — but the guard is the repo's convention for the expansion,
# not an argument about this call site (see check-adr-index.sh).
for agreement in ${agreements[@]+"${agreements[@]}"}; do
  printf '  %s\n' "$agreement"
done
printf 'check-infra-mirrors: OK — %d mirrored value(s) agree with Terraform\n' "${#agreements[@]}"
