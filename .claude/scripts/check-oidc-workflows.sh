#!/usr/bin/env bash
# OIDC workflow gate (#605): the deploy role's workflow allowlist in
# infra/bootstrap/oidc.tf (`local.deploy_role_workflows`) and .github/workflows
# must agree, and no workflow that can mint an OIDC token may take an event a
# fork author can trigger.
#
#   1. A workflow using aws-actions/configure-aws-credentials is allowlisted and
#      declares `id-token: write`.
#   2. Every allowlist entry is a workflow that uses that action.
#   3. A workflow with `id-token: write` (or `permissions: write-all`) has no
#      pull_request_target, issue_comment, issues or workflow_run trigger — they
#      run in main's context, so their tokens carry the subject the trust policy
#      admits (#358, 2026-10-07 infra review, entry 2).
#
# Rule 1 keys on the action rather than on `id-token: write` alone because
# deploy-pages.yml mints a token for GitHub Pages, not AWS (#605 plan comment).
# Line-based, comment lines skipped; a shape it cannot read is refused (exit 2).
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
FORK_EVENTS=" pull_request_target issue_comment issues workflow_run "

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

# events_of <file> -> prints the workflow's trigger names, one per line; exit 2 if no `on:`.
events_of() {
  awk '
    function emit(text,   word) {
      gsub(/[][{}:,"'\'']/, " ", text)
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
      if (inline != "") { emit(inline); in_on = 0 }
      next
    }
    in_on && /^[^[:space:]]/ { in_on = 0 }
    in_on {
      match($0, /^[[:space:]]*/)
      indent = RLENGTH
      if (key_indent == 0) key_indent = indent
      if (indent != key_indent) next
      item = substr($0, indent + 1)
      sub(/^-[[:space:]]*/, "", item)
      sub(/:.*$/, "", item)
      emit(item)
    }
    END { if (!found) exit 2 }
  ' "$1"
}

USES_AWS='^[[:space:]]*(-[[:space:]]+)?uses:[[:space:]]*["'\'']?aws-actions/configure-aws-credentials@'
MINTS='^[[:space:]]*(id-token:[[:space:]]*["'\'']?write|permissions:[[:space:]]*["'\'']?write-all)'

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
    events=$(events_of "$path") || refuse "$WORKFLOWS_REL/$name has no top-level on: key this gate can read"
    while IFS= read -r event; do
      case "$FORK_EVENTS" in
        *" $event "*) errors+=("$WORKFLOWS_REL/$name can mint an OIDC token and is triggered by $event, which a fork author can fire") ;;
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

printf 'check-oidc-workflows: OK — %d allowlisted workflow(s) in %s, each assuming the role; %d token-minting workflow(s), none fork-triggerable\n' \
  "${#allowlist[@]}" "$TRUST_REL" "$minting"
