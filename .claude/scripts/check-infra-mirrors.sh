#!/usr/bin/env bash
# Infra-mirror gate: every pair declared below — a value in one file against a
# value in another — must still stand in the relation this list declares for it.
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
# Scope, stated because the OK line does not say it: this gate checks DECLARED
# VALUES standing in a DECLARED RELATION. Since #133 that is broader than the
# one pair it shipped for, in three directions — the extraction (a Terraform
# integer, a Terraform double-quoted string, or a variable's validation
# pattern), the addressing (a dotted path into sub-blocks, not only a top-level
# attribute), and the relation itself (equality up to a scale, a strict bound,
# and a floor at a declared factor). So it now checks names as well as numbers:
# the `expiresAt` TTL attribute is three of the records below.
#
# What it deliberately does NOT check is prose. A value restated in a comment,
# a README or a design doc has no line shape a small brittle reader can anchor
# on, and a reader that guessed at free text would be approving agreements it
# never established — so that half is declined here and carried instead by
# `docs/standards/architecture.md` rule 9 (one owner per stated value, plus a
# restatement ledger beside the owner). It also knows nothing about mirrors it
# has not been told about. Adding a pair is one line in MIRRORS below; a pair
# nobody adds is not covered, which is why the list sits in the file a reader of
# either mirrored file is pointed at.
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
# The one residual, unchanged by #133 and owned by #158: the Terraform reader
# recognises LINE SHAPES, not HCL grammar. It descends only on a pure block
# opener, ascends only on a pure `}` line, and acts only at the indentation
# `terraform fmt` gives that depth — which is what keeps `redrive_policy =
# jsonencode({` and a `<<-EOT` description from moving the depth count. But an
# interior line of a heredoc or of a multi-line expression that happens to mimic
# the target attribute at the target depth would still be read as that
# attribute. #158 owns that gap; it is one reader, and it should stay one
# reader, so do not add a second parsing discipline here.
#
# Usage: bash .claude/scripts/check-infra-mirrors.sh [REPO_ROOT]
#        (or `pnpm check:infra-mirrors`)
#        REPO_ROOT defaults to the repo root above this script; the argument
#        exists so the test harness can point the gate at throwaway fixtures.
# Exit:  0 every declared relation holds, 1 at least one has drifted, 2 the gate
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
# One record per declared relation, `|`-delimited. FIELD 1 IS THE MODE TAG, and
# it fixes both what the readers extract and what relation is then asserted; the
# remaining fields are per-mode, and their count is part of the mode. A record
# whose tag is unknown, or whose field count is wrong for its tag, is a refusal
# (exit 2) rather than a skip — a configuration typo has to be loud, because the
# quiet version of it is a pair nobody is checking.
#
#   `eq`       tf-file | address | attr-path | ts-file | constant | ts-per-tf
#              TS integer == TF integer x ts-per-tf. The original relation
#              (#123, #29). ts-per-tf is how many of the constant's units make
#              one Terraform unit, so seconds mirrored as milliseconds is 1000
#              and a same-unit pair is 1 — declared rather than inferred,
#              because "300 vs 300000" is only agreement if somebody says which
#              unit is which.
#
#   `ts-lt`    tf-file | address | attr-path | ts-file | constant | ts-per-tf
#              TS integer STRICTLY LESS THAN TF integer x ts-per-tf. The
#              mechanical form of "sized under the ceiling with room left": the
#              web fan-out rate against the API stage's throttle. Strict on
#              purpose — equality there means the client is provisioned to spend
#              the whole bucket, and if that is ever wanted it is a record edit
#              (`ts-lt` becomes `eq`) and therefore a visible decision.
#
#   `str-eq`   tf-file | address | attr-path | ts-file | constant
#              TF double-quoted string == TS `export const NAME = '<text>';`
#              (single quotes, this repo's prettier style). A backslash or an
#              embedded quote on either side is refused rather than interpreted:
#              this reader does not do escape sequences, and a name that needs
#              one is not a name these two files should be agreeing about by
#              string comparison.
#
#   `regex-eq` tf-file | address | ts-file | constant
#              The address is a `variable.<name>`, and the Terraform side is
#              that variable's `validation.condition`, which must be exactly
#              `can(regex("<pattern>", var.<name>))`. The TypeScript side is
#              `export const NAME = /<pattern>/;` — no flags, no backslashes on
#              either side. The two pattern texts must be equal. No attr-path
#              field: the path is what the mode means.
#
#   `tf-ge`    left-tf-file | left-address | left-attr-path |
#              right-tf-file | right-address | right-attr-path | factor
#              Left TF integer >= factor x right TF integer. Terraform on both
#              sides, and a floor rather than an equality: ADR 0004's rule that
#              the queue's visibility timeout must be at least six times the
#              consumer's function timeout.
#
# Addresses are `<resource_type>.<label>` (matching `resource "<type>" "<label>"
# {`) or `variable.<label>` (matching `variable "<label>" {`).
#
# Attr paths are dot-separated lowercase segments. The last segment is the
# attribute; every earlier one is a sub-block to descend into, so
# `default_route_settings.throttling_rate_limit` is the stage's own throttle and
# not the one inside `dynamic "route_settings" { content { … } }` next to it.
# A bare `timeout` is the top-level case and reads exactly as it always did.
#
# Two relations are declined here, with reasons, so that the next author meets
# the boundary before designing around it:
#
#   * An INEQUALITY against an externally-owned constant. infra/api/lambda.tf's
#     `timeout = 15` is bounded by API Gateway's 30 s integration ceiling — a
#     number AWS owns and no file here declares, so there is nothing for a
#     record to address. Since #165 it is not unenforced: the ceiling is
#     restated in TypeScript as `API_GATEWAY_INTEGRATION_TIMEOUT_MS` and
#     `apps/api/src/request-budget.ts`'s test asserts the mirrored constant is
#     below it. That works precisely because the `eq` record below holds the
#     constant equal to Terraform — the test bites on the deployed value rather
#     than on a number somebody kept in step by hand. The equality half and the
#     inequality half are different claims and should not be confused; both
#     that file's docblock and `infra/api/lambda.tf`'s comment say what this
#     bullet says — the ceiling has no second side here for a record to name —
#     and that is what stays true however many relations this list grows.
#   * A PROSE mirror — a value restated in a comment or a doc. Declined for the
#     reason in this file's header: free text has no line shape an honest
#     brittle reader can anchor on. Architecture rule 9 (one owner per stated
#     value, restatement ledger beside the owner) is what carries it.
MIRRORS=(
  "eq|infra/ingestion/lambda.tf|aws_lambda_function.ingestion|timeout|apps/ingestion/src/cycle-budget.ts|INGESTION_LAMBDA_TIMEOUT_MS|1000"
  "eq|infra/api/lambda.tf|aws_lambda_function.api|timeout|apps/api/src/request-budget.ts|API_LAMBDA_TIMEOUT_MS|1000"
  "ts-lt|infra/api/gateway.tf|aws_apigatewayv2_stage.default|default_route_settings.throttling_rate_limit|apps/web/src/data/http-fleet-data-source.ts|FLEET_FANOUT_LAUNCHES_PER_SECOND|1"
  "str-eq|infra/storage/tables.tf|aws_dynamodb_table.series|ttl.attribute_name|packages/storage/src/ttl.ts|TTL_ATTRIBUTE_NAME"
  "str-eq|infra/storage/tables.tf|aws_dynamodb_table.weather|ttl.attribute_name|packages/storage/src/ttl.ts|TTL_ATTRIBUTE_NAME"
  "str-eq|infra/storage/tables.tf|aws_dynamodb_table.abuse|ttl.attribute_name|packages/storage/src/ttl.ts|TTL_ATTRIBUTE_NAME"
  "regex-eq|infra/storage/variables.tf|variable.environment|packages/storage/src/table-name.ts|ENVIRONMENT_PATTERN"
  "tf-ge|infra/ingestion/transport.tf|aws_sqs_queue.weather_readings|visibility_timeout_seconds|infra/forecast/lambda.tf|aws_lambda_function.forecast|timeout|6"
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

# Prints the value of the attribute at <attr-path> inside the block <address>
# names. Anything other than exactly one such attribute in exactly one such
# block is a non-verdict, reported on stderr with a non-zero return.
#
# The block and the path are delimited by `terraform fmt`'s canonical layout,
# which CI enforces on every push (`terraform fmt -check -recursive infra`), and
# three rules are the whole of the parsing:
#
#   * only a PURE BLOCK OPENER descends — a name, optional quoted labels, `{`,
#     and nothing else on the line. That covers `ttl {`,
#     `default_route_settings {` and `dynamic "route_settings" {`, and excludes
#     `redrive_policy = jsonencode({`, which is an attribute whose value happens
#     to open a brace and must not move the depth count;
#   * only a PURE `}` LINE ascends;
#   * every line the reader acts on — opener, closer, or the target attribute —
#     must sit at the indentation `terraform fmt` gives its depth (2 x depth,
#     and 2 x (depth - 1) for a closer). This is what makes the two rules above
#     survive each other: the `}` closing a `variables = {` body is indented
#     deeper than the block it appears to close, so it is ignored rather than
#     ascending out of a block that never opened.
#
# The target is matched only while the reader is fully on the declared path, at
# the exact depth that path implies — so a `throttling_rate_limit` inside
# `dynamic "route_settings" { content { … } }` is never read as
# `default_route_settings`'s, and a same-named attribute in the next resource
# down is outside the block entirely. Both properties have cases in the harness,
# because both are the difference between "the deployed value" and "a number
# that looked like it".
#
# <kind> selects the shape the value must have, and therefore what is printed:
# `integer` prints the digits; `string` prints the contents of a double-quoted
# literal; `regex-condition` prints the pattern inside
# `can(regex("<pattern>", var.<label>))`.
tf_block_value() { # tf_block_value <file> <address> <attr-path> <kind>
  local file="$1" address="$2" attr_path="$3" kind="$4"
  local block_type=${address%%.*} block_label=${address#*.}
  local header_re block_desc
  if [ "$block_type" = "variable" ]; then
    header_re="^variable[[:space:]]+\"$block_label\"[[:space:]]*\{[[:space:]]*$"
    block_desc="variable \"$block_label\""
  else
    header_re="^resource[[:space:]]+\"$block_type\"[[:space:]]+\"$block_label\"[[:space:]]*\{[[:space:]]*$"
    block_desc="resource \"$block_type\" \"$block_label\""
  fi

  local attr=${attr_path##*.} prefix=""
  if [ "$attr_path" != "$attr" ]; then
    prefix=${attr_path%.*}
  fi

  local open_re='^( *)([a-z][a-z0-9_]*)([[:space:]]+"[^"]*")*[[:space:]]*\{[[:space:]]*$'
  local close_re='^( *)\}[[:space:]]*$'
  local attr_re="^( *)${attr}[[:space:]]*=[[:space:]]*(.*)$"
  local string_re='^"([^"]*)"$'
  local condition_re='^can\(regex\("([^"]*)", var\.'"$block_label"'\)\)$'

  local line indent depth=0 headers=0 matches=0 value="" path=""
  while IFS= read -r line || [ -n "$line" ]; do
    line=${line%$'\r'}
    if [ "$depth" -eq 0 ]; then
      if [[ $line =~ $header_re ]]; then
        depth=1
        path=""
        headers=$((headers + 1))
      fi
      continue
    fi
    if [[ $line =~ $close_re ]]; then
      indent=${#BASH_REMATCH[1]}
      if [ "$indent" -eq $(((depth - 1) * 2)) ]; then
        depth=$((depth - 1))
        if [[ $path == *.* ]]; then path=${path%.*}; else path=""; fi
      fi
      continue
    fi
    if [[ $line =~ $open_re ]]; then
      indent=${#BASH_REMATCH[1]}
      if [ "$indent" -eq $((depth * 2)) ]; then
        path=${path:+$path.}${BASH_REMATCH[2]}
        depth=$((depth + 1))
      fi
      continue
    fi
    if [ "$path" = "$prefix" ] && [[ $line =~ $attr_re ]]; then
      indent=${#BASH_REMATCH[1]}
      if [ "$indent" -eq $((depth * 2)) ]; then
        matches=$((matches + 1))
        value=$(strip_hcl_comment "${BASH_REMATCH[2]}")
      fi
    fi
  done <"$file"

  if [ "$headers" -eq 0 ]; then
    printf 'check-infra-mirrors: %s declares no %s\n' "$file" "$block_desc" >&2
    return 1
  fi
  if [ "$headers" -gt 1 ]; then
    printf 'check-infra-mirrors: %s declares %s %d times\n' "$file" "$block_desc" "$headers" >&2
    return 1
  fi
  if [ "$matches" -eq 0 ]; then
    if [ -z "$prefix" ]; then
      printf "check-infra-mirrors: %s: '%s' declares no top-level '%s' attribute\n" \
        "$file" "$address" "$attr" >&2
    else
      printf "check-infra-mirrors: %s: '%s' declares no '%s' inside '%s'\n" \
        "$file" "$address" "$attr" "$prefix" >&2
    fi
    printf '  Only an attribute reached by descending exactly the named sub-blocks, at\n' >&2
    printf '  the indentation terraform fmt gives that depth, counts; one at another\n' >&2
    printf '  depth or on another path is a different value and is not read as this one.\n' >&2
    return 1
  fi
  if [ "$matches" -gt 1 ]; then
    printf "check-infra-mirrors: %s: '%s' declares '%s' %d times\n" \
      "$file" "$address" "$attr_path" "$matches" >&2
    return 1
  fi

  case $kind in
    integer)
      if ! [[ $value =~ ^[0-9]+$ ]]; then
        printf "check-infra-mirrors: %s: '%s'.%s is not a plain integer: %s\n" \
          "$file" "$address" "$attr_path" "${value:-<empty>}" >&2
        printf '  This relation compares numbers. An attribute that became an expression or\n' >&2
        printf '  a variable reference is a change of shape, and it wants a decision rather\n' >&2
        printf '  than a comparison this gate would have to guess at.\n' >&2
        return 1
      fi
      printf '%s' "$value"
      ;;
    string)
      if ! [[ $value =~ $string_re ]]; then
        printf "check-infra-mirrors: %s: '%s'.%s is not a plain double-quoted string: %s\n" \
          "$file" "$address" "$attr_path" "${value:-<empty>}" >&2
        printf '  This relation compares one written name against another. An interpolated\n' >&2
        printf '  or computed value is not a name two files can be held equal on.\n' >&2
        return 1
      fi
      value=${BASH_REMATCH[1]}
      case $value in
        *\\*)
          printf "check-infra-mirrors: %s: '%s'.%s contains a backslash: %s\n" \
            "$file" "$address" "$attr_path" "$value" >&2
          printf '  This reader does not interpret escape sequences, so it refuses rather\n' >&2
          printf '  than comparing two texts it may be reading differently.\n' >&2
          return 1
          ;;
      esac
      printf '%s' "$value"
      ;;
    regex-condition)
      if ! [[ $value =~ $condition_re ]]; then
        printf "check-infra-mirrors: %s: '%s'.%s is not a can(regex(...)) validation: %s\n" \
          "$file" "$address" "$attr_path" "${value:-<empty>}" >&2
        printf '  This relation compares the pattern text on both sides, so the condition\n' >&2
        printf '  has to be exactly can(regex("<pattern>", var.%s)). A condition that\n' "$block_label" >&2
        printf '  became a different kind of check is a change of claim, not of spelling.\n' >&2
        return 1
      fi
      value=${BASH_REMATCH[1]}
      case $value in
        *\\*)
          printf "check-infra-mirrors: %s: '%s'.%s has a backslash in its pattern: %s\n" \
            "$file" "$address" "$attr_path" "$value" >&2
          printf '  HCL and TypeScript escape a backslash differently, so the two texts\n' >&2
          printf '  would not be comparable as written. Refused rather than normalised.\n' >&2
          return 1
          ;;
      esac
      printf '%s' "$value"
      ;;
    *)
      printf 'check-infra-mirrors: internal error: unknown Terraform value kind %s\n' "$kind" >&2
      return 1
      ;;
  esac
}

# --- the TypeScript side ----------------------------------------------------------------------

# Three readers, one per shape a mirrored constant can take. All three require
# the declaration to be EXPORTED, on purpose: a mirror is a claim about a
# module's public surface, and a private constant is not one another file — or
# this gate — is entitled to hold Terraform to.
#
# All three accept an optional type annotation and an optional trailing `// …`,
# for the same reason strip_hcl_comment exists on the Terraform side: a comment
# after the value is the most ordinary thing to write next to a mirrored value,
# it changes nothing about the value, and a gate that refused it would refuse
# with a message every clause of which is already true of the line in front of
# the reader.

# Prints the integer initialiser of `export const <name> = <number>;`, with any
# numeric separators removed.
ts_constant_value() { # ts_constant_value <file> <name>
  local file="$1" name="$2"
  local line matches=0 value=""
  local const_re="^export const $name([[:space:]]*:[^=]*)?[[:space:]]*=[[:space:]]*([0-9][0-9_]*)[[:space:]]*;[[:space:]]*(//.*)?$"

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

# Prints the contents of `export const <name> = '<text>';`. Single quotes only:
# that is what prettier writes in this repo, and accepting both would mean
# choosing which quote a text containing the other one belongs to.
ts_string_constant_value() { # ts_string_constant_value <file> <name>
  local file="$1" name="$2"
  local line matches=0 value=""
  local const_re="^export const $name([[:space:]]*:[^=]*)?[[:space:]]*=[[:space:]]*'([^']*)'[[:space:]]*;[[:space:]]*(//.*)?$"

  while IFS= read -r line || [ -n "$line" ]; do
    line=${line%$'\r'}
    if [[ $line =~ $const_re ]]; then
      matches=$((matches + 1))
      value=${BASH_REMATCH[2]}
    fi
  done <"$file"

  if [ "$matches" -eq 0 ]; then
    printf "check-infra-mirrors: %s declares no \"export const %s = '<text>';\"\n" "$file" "$name" >&2
    printf '  The declaration has to be exported, a single-quoted string literal with no\n' >&2
    printf '  embedded quote, and on one line. A name assembled from parts is not a name\n' >&2
    printf '  this gate can hold a Terraform attribute equal to.\n' >&2
    return 1
  fi
  if [ "$matches" -gt 1 ]; then
    printf "check-infra-mirrors: %s declares 'export const %s' %d times\n" \
      "$file" "$name" "$matches" >&2
    return 1
  fi
  case $value in
    *\\*)
      printf 'check-infra-mirrors: %s: %s contains a backslash: %s\n' "$file" "$name" "$value" >&2
      printf '  This reader does not interpret escape sequences, so it refuses rather\n' >&2
      printf '  than comparing two texts it may be reading differently.\n' >&2
      return 1
      ;;
  esac

  printf '%s' "$value"
}

# Prints the pattern text of `export const <name> = /<pattern>/;`. No flags: a
# flag changes what the pattern means without changing its text, so a flagged
# literal is not a thing to compare with an HCL `regex()` call by text alone.
ts_regex_constant_value() { # ts_regex_constant_value <file> <name>
  local file="$1" name="$2"
  local line matches=0 value=""
  local const_re="^export const $name([[:space:]]*:[^=]*)?[[:space:]]*=[[:space:]]*/([^/]*)/[[:space:]]*;[[:space:]]*(//.*)?$"

  while IFS= read -r line || [ -n "$line" ]; do
    line=${line%$'\r'}
    if [[ $line =~ $const_re ]]; then
      matches=$((matches + 1))
      value=${BASH_REMATCH[2]}
    fi
  done <"$file"

  if [ "$matches" -eq 0 ]; then
    printf "check-infra-mirrors: %s declares no 'export const %s = /<pattern>/;'\n" "$file" "$name" >&2
    printf '  The declaration has to be exported, a bare regex literal with no flags,\n' >&2
    printf '  and on one line. A pattern built with the RegExp constructor or carrying a\n' >&2
    printf '  flag is not the same claim as the Terraform validation it mirrors.\n' >&2
    return 1
  fi
  if [ "$matches" -gt 1 ]; then
    printf "check-infra-mirrors: %s declares 'export const %s' %d times\n" \
      "$file" "$name" "$matches" >&2
    return 1
  fi
  case $value in
    *\\*)
      printf 'check-infra-mirrors: %s: %s has a backslash in its pattern: %s\n' "$file" "$name" "$value" >&2
      printf '  HCL and TypeScript escape a backslash differently, so the two texts would\n' >&2
      printf '  not be comparable as written. Refused rather than normalised.\n' >&2
      return 1
      ;;
  esac

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

PATH_FIELD_RE='^[A-Za-z0-9._/-]+$'
ADDRESS_FIELD_RE='^[a-z][a-z0-9_]*\.[A-Za-z_][A-Za-z0-9_-]*$'
VARIABLE_ADDRESS_FIELD_RE='^variable\.[A-Za-z_][A-Za-z0-9_-]*$'
ATTR_PATH_FIELD_RE='^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$'
CONSTANT_FIELD_RE='^[A-Za-z_][A-Za-z0-9_]*$'
FACTOR_FIELD_RE='^[1-9][0-9]*$'

validate_field() { # validate_field <record-number> <label> <value> <extended-regex>
  local number="$1" label="$2" value="$3" pattern="$4"
  if [[ $value =~ $pattern ]]; then
    return 0
  fi
  blockers+=("MIRRORS[$number]: $label is not a well-formed $label: '${value:-<empty>}'")
  return 1
}

# --- the relations ------------------------------------------------------------------------------
#
# One function per mode tag. Each reads both sides, appends to `blockers` if it
# could not, and otherwise appends to `offenders` or `agreements` — so the
# difference between the modes is entirely here, and the pass below is only
# dispatch.

require_files() { # require_files <record-number> <repo-relative path>... -> 1 if any is missing
  local number="$1" rel
  shift
  for rel in "$@"; do
    if [ ! -f "$ROOT/$rel" ]; then
      blockers+=("no such file: $rel (declared by MIRRORS[$number])")
      return 1
    fi
  done
  return 0
}

check_numeric_relation() { # <n> <mode> <tf-file> <address> <attr-path> <ts-file> <constant> <scale>
  local number="$1" mode="$2" tf_file="$3" address="$4" attr_path="$5"
  local ts_file="$6" constant="$7" scale="$8"
  local tf_value ts_value expected actual

  require_files "$number" "$tf_file" "$ts_file" || return 0
  if ! tf_value=$(tf_block_value "$ROOT/$tf_file" "$address" "$attr_path" integer); then
    blockers+=("could not read $address.$attr_path from $tf_file (error above)")
    return 0
  fi
  if ! ts_value=$(ts_constant_value "$ROOT/$ts_file" "$constant"); then
    blockers+=("could not read $constant from $ts_file (error above)")
    return 0
  fi

  expected=$((10#$tf_value * scale))
  actual=$((10#$ts_value))

  if [ "$mode" = "eq" ]; then
    if [ "$actual" -ne "$expected" ]; then
      offenders+=("ERROR $tf_file  $address.$attr_path = $tf_value")
      offenders+=("      $ts_file  $constant = $actual, but $tf_value * $scale = $expected")
    else
      agreements+=("$address.$attr_path = $tf_value  ==  $constant = $actual  (x$scale)")
    fi
    return 0
  fi

  # ts-lt. Strict: `actual == expected` is the client provisioned to spend the
  # whole ceiling, which is the thing the record says it must not be.
  if [ "$actual" -lt "$expected" ]; then
    agreements+=("$address.$attr_path = $tf_value  >  $constant = $actual  (strictly under, x$scale)")
  else
    offenders+=("ERROR $tf_file  $address.$attr_path = $tf_value")
    offenders+=("      $ts_file  $constant = $actual, which is not strictly under $tf_value * $scale = $expected")
  fi
}

check_string_relation() { # <n> <tf-file> <address> <attr-path> <ts-file> <constant>
  local number="$1" tf_file="$2" address="$3" attr_path="$4" ts_file="$5" constant="$6"
  local tf_text ts_text

  require_files "$number" "$tf_file" "$ts_file" || return 0
  if ! tf_text=$(tf_block_value "$ROOT/$tf_file" "$address" "$attr_path" string); then
    blockers+=("could not read $address.$attr_path from $tf_file (error above)")
    return 0
  fi
  if ! ts_text=$(ts_string_constant_value "$ROOT/$ts_file" "$constant"); then
    blockers+=("could not read $constant from $ts_file (error above)")
    return 0
  fi

  if [ "$tf_text" = "$ts_text" ]; then
    agreements+=("$address.$attr_path = \"$tf_text\"  ==  $constant = '$ts_text'  (same name)")
  else
    offenders+=("ERROR $tf_file  $address.$attr_path = \"$tf_text\"")
    offenders+=("      $ts_file  $constant = '$ts_text', which is a different name")
  fi
}

check_regex_relation() { # <n> <tf-file> <address> <ts-file> <constant>
  local number="$1" tf_file="$2" address="$3" ts_file="$4" constant="$5"
  local tf_pattern ts_pattern

  require_files "$number" "$tf_file" "$ts_file" || return 0
  if ! tf_pattern=$(tf_block_value "$ROOT/$tf_file" "$address" validation.condition regex-condition); then
    blockers+=("could not read $address's validation.condition from $tf_file (error above)")
    return 0
  fi
  if ! ts_pattern=$(ts_regex_constant_value "$ROOT/$ts_file" "$constant"); then
    blockers+=("could not read $constant from $ts_file (error above)")
    return 0
  fi

  if [ "$tf_pattern" = "$ts_pattern" ]; then
    agreements+=("$address validation.condition = /$tf_pattern/  ==  $constant = /$ts_pattern/  (same pattern)")
  else
    offenders+=("ERROR $tf_file  $address validation.condition = /$tf_pattern/")
    offenders+=("      $ts_file  $constant = /$ts_pattern/, which is a different pattern")
  fi
}

check_terraform_floor() { # <n> <l-file> <l-address> <l-attr-path> <r-file> <r-address> <r-attr-path> <factor>
  local number="$1" left_file="$2" left_address="$3" left_attr="$4"
  local right_file="$5" right_address="$6" right_attr="$7" factor="$8"
  local left right floor

  require_files "$number" "$left_file" "$right_file" || return 0
  if ! left=$(tf_block_value "$ROOT/$left_file" "$left_address" "$left_attr" integer); then
    blockers+=("could not read $left_address.$left_attr from $left_file (error above)")
    return 0
  fi
  if ! right=$(tf_block_value "$ROOT/$right_file" "$right_address" "$right_attr" integer); then
    blockers+=("could not read $right_address.$right_attr from $right_file (error above)")
    return 0
  fi

  floor=$((10#$right * factor))

  if [ "$((10#$left))" -ge "$floor" ]; then
    agreements+=("$left_address.$left_attr = $left  >=  $factor x $right_address.$right_attr = $right  (floor $floor)")
  else
    offenders+=("ERROR $left_file  $left_address.$left_attr = $left")
    offenders+=("      $right_file  $right_address.$right_attr = $right, and $factor x $right = $floor is the floor this must not go under")
  fi
}

# --- the pass -----------------------------------------------------------------------------------

index=0
for record in "${MIRRORS[@]}"; do
  index=$((index + 1))

  IFS='|' read -r mode f1 f2 f3 f4 f5 f6 f7 <<<"$record"

  case $mode in
    eq | ts-lt) arity=6 ;;
    str-eq) arity=5 ;;
    regex-eq) arity=4 ;;
    tf-ge) arity=7 ;;
    *)
      blockers+=("MIRRORS[$index]: unknown mode '${mode:-<empty>}' — the modes are eq, ts-lt, str-eq, regex-eq and tf-ge")
      continue
      ;;
  esac

  # The arity is counted from the record's SEPARATORS, never inferred from what
  # the fields hold. A record with one field too many but that field left empty
  # (`…|VALUE|`) reads back as an empty string, which is exactly what a field
  # the record never had reads back as — so "is there anything beyond the last
  # field?" answers no and lets the typo through, which is the quiet version of
  # the loud refusal this check exists to be. The separator count is the arity
  # whatever the fields contain, so every wrong count refuses, trailing empties
  # included. (An empty field at the RIGHT count is caught next, by the
  # alphabets below: no field's pattern matches the empty string.)
  separators=${record//[^|]/}
  if [ "${#separators}" -ne "$arity" ]; then
    blockers+=("MIRRORS[$index]: mode '$mode' takes exactly $arity fields after the tag, not ${#separators}: $record")
    continue
  fi

  ok=1
  case $mode in
    eq | ts-lt)
      validate_field "$index" "tf-file" "$f1" "$PATH_FIELD_RE" || ok=0
      validate_field "$index" "address" "$f2" "$ADDRESS_FIELD_RE" || ok=0
      validate_field "$index" "attr-path" "$f3" "$ATTR_PATH_FIELD_RE" || ok=0
      validate_field "$index" "ts-file" "$f4" "$PATH_FIELD_RE" || ok=0
      validate_field "$index" "constant" "$f5" "$CONSTANT_FIELD_RE" || ok=0
      validate_field "$index" "ts-per-tf" "$f6" "$FACTOR_FIELD_RE" || ok=0
      [ "$ok" -eq 1 ] || continue
      check_numeric_relation "$index" "$mode" "$f1" "$f2" "$f3" "$f4" "$f5" "$f6"
      ;;
    str-eq)
      validate_field "$index" "tf-file" "$f1" "$PATH_FIELD_RE" || ok=0
      validate_field "$index" "address" "$f2" "$ADDRESS_FIELD_RE" || ok=0
      validate_field "$index" "attr-path" "$f3" "$ATTR_PATH_FIELD_RE" || ok=0
      validate_field "$index" "ts-file" "$f4" "$PATH_FIELD_RE" || ok=0
      validate_field "$index" "constant" "$f5" "$CONSTANT_FIELD_RE" || ok=0
      [ "$ok" -eq 1 ] || continue
      check_string_relation "$index" "$f1" "$f2" "$f3" "$f4" "$f5"
      ;;
    regex-eq)
      validate_field "$index" "tf-file" "$f1" "$PATH_FIELD_RE" || ok=0
      validate_field "$index" "variable-address" "$f2" "$VARIABLE_ADDRESS_FIELD_RE" || ok=0
      validate_field "$index" "ts-file" "$f3" "$PATH_FIELD_RE" || ok=0
      validate_field "$index" "constant" "$f4" "$CONSTANT_FIELD_RE" || ok=0
      [ "$ok" -eq 1 ] || continue
      check_regex_relation "$index" "$f1" "$f2" "$f3" "$f4"
      ;;
    tf-ge)
      validate_field "$index" "left-tf-file" "$f1" "$PATH_FIELD_RE" || ok=0
      validate_field "$index" "left-address" "$f2" "$ADDRESS_FIELD_RE" || ok=0
      validate_field "$index" "left-attr-path" "$f3" "$ATTR_PATH_FIELD_RE" || ok=0
      validate_field "$index" "right-tf-file" "$f4" "$PATH_FIELD_RE" || ok=0
      validate_field "$index" "right-address" "$f5" "$ADDRESS_FIELD_RE" || ok=0
      validate_field "$index" "right-attr-path" "$f6" "$ATTR_PATH_FIELD_RE" || ok=0
      validate_field "$index" "factor" "$f7" "$FACTOR_FIELD_RE" || ok=0
      [ "$ok" -eq 1 ] || continue
      check_terraform_floor "$index" "$f1" "$f2" "$f3" "$f4" "$f5" "$f6" "$f7"
      ;;
  esac
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
  printf '\ncheck-infra-mirrors: declared mirror relation(s) no longer hold\n' >&2
  for offender in "${offenders[@]}"; do
    printf '  %s\n' "$offender" >&2
  done
  printf '\nThese are one decision written in two places on purpose, and each file cites\n' >&2
  printf 'the other. Move both or neither: the second copy is what the code or the next\n' >&2
  printf 'stack sizes itself against, so a one-sided change leaves something budgeting\n' >&2
  printf 'for a limit that is no longer the limit — which is #115 all over again, and\n' >&2
  printf 'silent.\n' >&2
  exit 1
fi

# `${a[@]+…}`: bash 3.2 under `set -u` aborts on an empty array's `[@]`. Every
# record reaching here landed in exactly one of the three arrays, so this one
# cannot be empty — but the guard is the repo's convention for the expansion,
# not an argument about this call site (see check-adr-index.sh).
for agreement in ${agreements[@]+"${agreements[@]}"}; do
  printf '  %s\n' "$agreement"
done
printf 'check-infra-mirrors: OK — %d declared mirror relation(s) hold\n' "${#agreements[@]}"
