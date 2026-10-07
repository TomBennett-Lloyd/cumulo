#!/usr/bin/env bash
# Test harness for check-oidc-workflows.sh. Every red case is a negative control for one
# rule or one refusal (testing.md rule 4), built in a throwaway fixture; one case runs the
# gate with no argument against the real repo (testing.md rule 7).
#
# Usage: bash .claude/scripts/check-oidc-workflows.test.sh   (or `pnpm test:scripts`)
# Exit:  0 every case PASS, 1 at least one FAIL, 2 the harness itself broke.
set -uo pipefail

SCRIPTS=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd) || exit 2
CHECK="$SCRIPTS/check-oidc-workflows.sh"

# shellcheck source=./harness-lib.sh
. "$SCRIPTS/harness-lib.sh"
harness_init_tmp

# --- fixtures ----------------------------------------------------------------------------

# fixture <name> -> DIR, a clean tree: deploy.yml assumes the role and is allowlisted;
# pages.yml mints a token without AWS (deploy-pages.yml's shape); ci.yml mints nothing.
fixture() {
  DIR="$TMP_ROOT/$1"
  must mkdir -p "$DIR/infra/bootstrap" "$DIR/.github/workflows"
  allowlist "deploy.yml"
  aws_workflow deploy.yml "  push:
    branches: [main]
  workflow_dispatch:"
  cat >"$DIR/.github/workflows/pages.yml" <<'EOF'
on:
  push:
    branches: [main]
permissions:
  pages: write
  id-token: write
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/deploy-pages@v4
EOF
  cat >"$DIR/.github/workflows/ci.yml" <<'EOF'
on:
  pull_request:
  issue_comment:
permissions:
  contents: read
jobs:
  checks:
    runs-on: ubuntu-latest
    steps:
      - run: echo ok
EOF
}

allowlist() { # allowlist <file>... -> writes oidc.tf with exactly these entries
  {
    printf 'locals {\n  deploy_role_workflows = [\n'
    for entry in "$@"; do printf '    "%s",\n' "$entry"; done
    printf '  ]\n}\n'
  } >"$DIR/infra/bootstrap/oidc.tf"
}

aws_workflow() { # aws_workflow <file> <indented on: block body>
  cat >"$DIR/.github/workflows/$1" <<EOF
on:
$2
permissions:
  id-token: write
  contents: read
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: aws-actions/configure-aws-credentials@v6
EOF
}

run_check() {
  capture bash "$CHECK" "$@"
}

# ==========================================================================================
begin "check-oidc-workflows.sh parses (bash -n)"
expect_parses "$CHECK"
end

begin "the repo's own workflows and oidc.tf agree, via the default path"
for interpreter in $BASHES; do
  case_ctx="$interpreter"
  capture "$interpreter" "$CHECK"
  expect_rc 0 "$rc"
  expect_out "check-oidc-workflows: OK"
  expect_not_out "unbound variable"
done
case_ctx=""
end

begin "a clean fixture passes, and a non-AWS token minter needs no allowlist entry"
fixture clean
run_check "$DIR"
expect_rc 0 "$rc"
expect_out "OK — 1 allowlisted workflow(s)"
expect_out "2 token-minting workflow(s)"
end

# --- rule 1 --------------------------------------------------------------------------------
begin "rule 1: a workflow assuming the role but absent from the allowlist fails"
fixture unlisted
aws_workflow extra.yml "  push:"
run_check "$DIR"
expect_rc 1 "$rc"
expect_out "ERROR .github/workflows/extra.yml assumes the AWS role but is not in"
end

begin "rule 1: an allowlisted workflow without id-token: write fails"
fixture no_mint
must sed -i.bak '/id-token: write/d' "$DIR/.github/workflows/deploy.yml"
run_check "$DIR"
expect_rc 1 "$rc"
expect_out "deploy.yml uses configure-aws-credentials without declaring id-token: write"
end

begin "rule 1: a commented-out credentials step does not count as assuming the role"
fixture commented
must sed -i.bak 's|      - uses: aws-actions|      # - uses: aws-actions|' "$DIR/.github/workflows/deploy.yml"
run_check "$DIR"
expect_rc 1 "$rc"
expect_out "allowlists deploy.yml, which is not a workflow"
end

# --- rule 2 --------------------------------------------------------------------------------
begin "rule 2: an allowlist entry naming no workflow fails"
fixture dead_entry
allowlist "deploy.yml" "gone.yml"
run_check "$DIR"
expect_rc 1 "$rc"
expect_out "ERROR infra/bootstrap/oidc.tf allowlists gone.yml"
end

begin "rule 2: an allowlist entry naming a workflow that never assumes the role fails"
fixture pages_listed
allowlist "deploy.yml" "pages.yml"
run_check "$DIR"
expect_rc 1 "$rc"
expect_out "allowlists pages.yml, which is not a workflow"
end

# --- rule 3, every forbidden event in every trigger shape ------------------------------------
for event in pull_request_target issue_comment issues workflow_run; do
  begin "rule 3: $event on a token-minting workflow fails (block form)"
  fixture "block_$event"
  aws_workflow deploy.yml "  push:
  $event:
    types: [created]"
  run_check "$DIR"
  expect_rc 1 "$rc"
  expect_out "deploy.yml can mint an OIDC token and is triggered by $event"
  end
done

begin "rule 3: flow-list form, on the non-AWS minter"
fixture flow_list
must sed -i.bak '1,3d' "$DIR/.github/workflows/pages.yml"
must sed -i.bak '1i\
on: [push, workflow_run]
' "$DIR/.github/workflows/pages.yml"
run_check "$DIR"
expect_rc 1 "$rc"
expect_out "pages.yml can mint an OIDC token and is triggered by workflow_run"
end

begin "rule 3: scalar form, and permissions: write-all counts as minting"
fixture scalar
cat >"$DIR/.github/workflows/triage.yml" <<'EOF'
"on": issues
permissions: write-all
jobs:
  label:
    runs-on: ubuntu-latest
    steps:
      - run: echo ok
EOF
run_check "$DIR"
expect_rc 1 "$rc"
expect_out "triage.yml can mint an OIDC token and is triggered by issues"
end

begin "rule 3: a fork-triggerable event on a workflow minting nothing passes"
fixture non_minting
run_check "$DIR"
expect_rc 0 "$rc"
expect_not_out "ci.yml"
end

begin "rule 3: an event name nested under another trigger's filters is not a trigger"
fixture nested
aws_workflow deploy.yml "  push:
    branches:
      - issues"
run_check "$DIR"
expect_rc 0 "$rc"
end

# --- refusals ------------------------------------------------------------------------------
begin "refuses when oidc.tf has no allowlist block"
fixture no_block
printf 'locals {}\n' >"$DIR/infra/bootstrap/oidc.tf"
run_check "$DIR"
expect_rc 2 "$rc"
expect_out "has no 'deploy_role_workflows = [' block"
expect_not_out "check-oidc-workflows: OK"
end

begin "refuses an empty allowlist"
fixture empty
allowlist
run_check "$DIR"
expect_rc 2 "$rc"
expect_out "deploy_role_workflows list is empty"
end

begin "refuses an allowlist line that is not one quoted file name"
fixture two_per_line
printf 'locals {\n  deploy_role_workflows = [\n    "deploy.yml", "pages.yml",\n  ]\n}\n' \
  >"$DIR/infra/bootstrap/oidc.tf"
run_check "$DIR"
expect_rc 2 "$rc"
expect_out "is not one quoted workflow file name per line"
end

begin "refuses a token-minting workflow with no top-level on:"
fixture no_on
must sed -i.bak '/^on:/d' "$DIR/.github/workflows/pages.yml"
run_check "$DIR"
expect_rc 2 "$rc"
expect_out "pages.yml has no top-level on: key"
end

begin "refuses a missing REPO_ROOT"
run_check "$TMP_ROOT/absent"
expect_rc 2 "$rc"
expect_out "not a directory"
end

finish
