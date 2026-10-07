#!/usr/bin/env bash
# OIDC workflow gate (#605): the deploy role's workflow allowlist in
# infra/bootstrap/oidc.tf (`local.deploy_role_workflows`) and .github/workflows
# must agree, and a workflow that can mint an OIDC token is triggered only by
# events no outsider can fire.
#
#   1. A workflow using aws-actions/configure-aws-credentials is allowlisted and
#      declares `id-token: write`.
#   2. Every allowlist entry is a workflow that uses that action.
#   3. A workflow that can mint a token has no trigger outside PERMITTED_TRIGGERS.
#      Events such as issue_comment or workflow_run, and a workflow_call from
#      any caller, run with main's subject (#358, 2026-10-07 infra review,
#      entry 2); a permit list fails closed on events nobody enumerated.
#
# Rule 1 keys on the action rather than on `id-token: write` alone because
# .github/workflows/deploy-pages.yml mints a token for GitHub Pages, not AWS
# (#605 plan comment). Minting and the action are matched on any non-comment
# line, over-approximating; an `on:` shape the parser cannot read is refused.
#
# Usage: bash .claude/scripts/check-oidc-workflows.sh [REPO_ROOT]
# Exit:  0 agree, 1 a violation, 2 no verdict (bad invocation or unreadable input).
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd) || exit 2
ROOT=${1:-"$SCRIPT_DIR/../.."}

refuse() {
  printf 'check-oidc-workflows: %s\n' "$1" >&2
  exit 2
}

[ -d "$ROOT" ] || refuse "not a directory: $ROOT"
ROOT=$(cd "$ROOT" && pwd -P) || exit 2

TRUST_REL=infra/bootstrap/oidc.tf
WORKFLOWS_REL=.github/workflows
PERMITTED_TRIGGERS=" push workflow_dispatch schedule "

[ -f "$ROOT/$TRUST_REL" ] || refuse "missing $TRUST_REL"
[ -d "$ROOT/$WORKFLOWS_REL" ] || refuse "missing $WORKFLOWS_REL/"

# --- the allowlist ------------------------------------------------------------------------

allowlist=()
in_list=0
found_list=0
line_no=0
while IFS= read -r line || [ -n "$line" ]; do
  line_no=$((line_no + 1))
  if [ "$in_list" -eq 0 ]; then
    if [[ "$line" =~ ^[[:space:]]*deploy_role_workflows[[:space:]]*=[[:space:]]*\[[[:space:]]*$ ]]; then
      in_list=1
      found_list=1
    fi
    continue
  fi
  if [[ "$line" =~ ^[[:space:]]*\][[:space:]]*$ ]]; then
    in_list=0
    continue
  fi
  if [[ "$line" =~ ^[[:space:]]*\"([A-Za-z0-9._-]+\.ya?ml)\",?[[:space:]]*$ ]]; then
    allowlist+=("${BASH_REMATCH[1]}")
    continue
  fi
  refuse "$TRUST_REL:$line_no is not one quoted workflow file name per line: $line"
done <"$ROOT/$TRUST_REL"

[ "$found_list" -eq 1 ] || refuse "$TRUST_REL has no 'deploy_role_workflows = [' block on a line of its own"
[ "$in_list" -eq 0 ] || refuse "$TRUST_REL's deploy_role_workflows list is never closed"
[ ${#allowlist[@]} -gt 0 ] || refuse "$TRUST_REL's deploy_role_workflows list is empty"

# --- the workflows ------------------------------------------------------------------------

# events_of <file> -> prints the workflow's trigger names, one per line.
# Exit 2: no top-level `on:`. Exit 3: an inline flow mapping, or a flow sequence
# that does not close on its own line.
events_of() {
  awk '
    function emit(text,   word) {
      gsub(/[][,"'\'']/, " ", text)
      while (match(text, /[A-Za-z_]+/)) {
        word = substr(text, RSTART, RLENGTH)
        print word
        text = substr(text, RSTART + RLENGTH)
      }
    }
    /^[[:space:]]*#/ || /^[[:space:]]*$/ { next }
    {
      sub(/[[:space:]]+#.*$/, "")
    }
    !in_on && /^("on"|'\''on'\''|on):/ {
      found = 1
      in_on = 1
      inline = $0
      sub(/^[^:]*:[[:space:]]*/, "", inline)
      if (inline != "") {
        if (inline ~ /[{}]/ || gsub(/\[/, "[", inline) != gsub(/\]/, "]", inline)) { refused = 1; exit 3 }
        emit(inline)
        in_on = 0
      }
      next
    }
    in_on && /^[^[:space:]-]/ { in_on = 0 }
    in_on {
      match($0, /^[[:space:]]*/)
      indent = RLENGTH
      if (!have_indent) { key_indent = indent; have_indent = 1 }
      if (indent != key_indent) next
      item = substr($0, indent + 1)
      sub(/^-[[:space:]]*/, "", item)
      sub(/:.*$/, "", item)
      emit(item)
    }
    END {
      if (refused) exit 3
      if (!found) exit 2
    }
  ' "$1"
}

USES_AWS='aws-actions/configure-aws-credentials@'
MINTS='id-token["'\'']?[[:space:]]*:[[:space:]]*["'\'']?write|write-all'

errors=()
minting=0
seen_aws=" "

shopt -s nullglob
workflows=("$ROOT/$WORKFLOWS_REL"/*.yml "$ROOT/$WORKFLOWS_REL"/*.yaml)
shopt -u nullglob

for path in "${workflows[@]}"; do
  name=$(basename "$path")
  body=$(grep -v -E '^[[:space:]]*#' "$path" || true)

  uses_aws=0
  mints=0
  if printf '%s\n' "$body" | grep -q -E "$USES_AWS"; then uses_aws=1; fi
  if printf '%s\n' "$body" | grep -q -E "$MINTS"; then mints=1; fi

  if [ "$uses_aws" -eq 1 ]; then
    seen_aws="$seen_aws$name "
    case " ${allowlist[*]} " in
      *" $name "*) ;;
      *) errors+=("$WORKFLOWS_REL/$name assumes the AWS role but is not in $TRUST_REL's deploy_role_workflows") ;;
    esac
    if [ "$mints" -eq 0 ]; then
      errors+=("$WORKFLOWS_REL/$name uses configure-aws-credentials without declaring id-token: write")
    fi
  fi

  if [ "$mints" -eq 1 ]; then
    minting=$((minting + 1))
    events_rc=0
    events=$(events_of "$path") || events_rc=$?
    case "$events_rc" in
      0) ;;
      2) refuse "$WORKFLOWS_REL/$name has no top-level on: key" ;;
      3) refuse "$WORKFLOWS_REL/$name writes on: as a flow mapping or a multi-line flow sequence; write it in block style" ;;
      *) refuse "$WORKFLOWS_REL/$name: reading its on: block failed" ;;
    esac
    while IFS= read -r event; do
      case "$PERMITTED_TRIGGERS" in
        *" $event "*) ;;
        *) errors+=("$WORKFLOWS_REL/$name can mint an OIDC token and is triggered by $event, which is not in PERMITTED_TRIGGERS ($PERMITTED_TRIGGERS)") ;;
      esac
    done <<<"$events"
  fi
done

for entry in "${allowlist[@]}"; do
  case "$seen_aws" in
    *" $entry "*) ;;
    *) errors+=("$TRUST_REL allowlists $entry, which is not a workflow in $WORKFLOWS_REL/ that uses configure-aws-credentials") ;;
  esac
done

if [ ${#errors[@]} -ne 0 ]; then
  printf '\ncheck-oidc-workflows: %d violation(s)\n' "${#errors[@]}" >&2
  for error in "${errors[@]}"; do
    printf '  ERROR %s\n' "$error" >&2
  done
  exit 1
fi

printf 'check-oidc-workflows: OK — %d allowlisted workflow(s) in %s, each assuming the role; %d token-minting workflow(s), each triggered only by permitted events\n' \
  "${#allowlist[@]}" "$TRUST_REL" "$minting"
