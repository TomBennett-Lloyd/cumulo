# Cumulo infrastructure

All AWS infrastructure lives here as Terraform. Nothing is created by hand in the console — if it exists in the account, it exists in a `.tf` file, because the alternative is infrastructure that cannot be torn down and a cost ceiling that cannot be trusted.

A **stack** is one directory under `infra/`, applied independently, with its own state. There are six today:

| Stack       | Directory          | Owns                                                                                                                                                                                                                                        |
| ----------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bootstrap` | `infra/bootstrap/` | Terraform's own remote state bucket, the GitHub Actions OIDC role, and the monthly cost-ceiling budget alarm.                                                                                                                               |
| `alerting`  | `infra/alerting/`  | The platform alerts SNS topic every other stack's alarms notify, and its email subscription.                                                                                                                                                |
| `storage`   | `infra/storage/`   | The four DynamoDB tables of [ADR 0002](../docs/adr/0002-storage-split.md), and their four throttle alarms.                                                                                                                                  |
| `ingestion` | `infra/ingestion/` | The hourly ingestion Lambda and its schedule, the weather-readings queue and DLQ of [ADR 0004](../docs/adr/0004-ingestion-transport.md), three alarms, and the CI deploy grant for its own function.                                        |
| `api`       | `infra/api/`       | The fleet API Lambda and the API Gateway HTTP API of [ADR 0005](../docs/adr/0005-fleet-api-hosting.md), including the stage throttle that bounds its bill, two alarms, and the CI deploy grant for it.                                      |
| `forecast`  | `infra/forecast/`  | The forecast Lambda of [ADR 0003](../docs/adr/0003-pv-model-runtime.md) and the event source mapping that wires it to ingestion's queue per [ADR 0004](../docs/adr/0004-ingestion-transport.md), one alarm, and the CI deploy grant for it. |

`storage` depends on `bootstrap` in one direction only: it keeps its state in the bucket `bootstrap` creates, so `bootstrap` is applied first and torn down last. Nothing else couples them — no resource in either stack references the other, and `storage` can be destroyed and re-applied on its own.

`ingestion` depends on `bootstrap` in exactly the same one direction, for exactly the same reason: its state lives in `bootstrap`'s bucket, and nothing else. Its relationship to `storage` is deliberately weaker than a dependency — **there is no cross-stack reference of any kind**. No `terraform_remote_state` data source, no output consumed, no ARN passed in. `ingestion`'s IAM policy names `cumulo-sites-<env>` and `cumulo-weather-<env>` by assembling them from the naming convention ADR 0002 fixed, which `storageTableName()` in `@cumulo/storage` also mirrors, so the two stacks share a convention rather than a wire. `ingestion` therefore plans and applies while `storage` is mid-apply, or before `storage` exists at all; what it cannot do is run a _cycle_ against tables that are not there. The one operator obligation that follows is that both stacks are applied with the same `environment` and into the same region, since a table ARN is regional and the suffix is in the name.

`api` sits in exactly the same shape as `ingestion`, one stack later: its state lives in `bootstrap`'s bucket, it attaches its own deploy grant to `bootstrap`'s shared role, and **it has no cross-stack reference to `storage` at all** — `cumulo-sites-<env>` and `cumulo-series-<env>` are assembled from the naming convention, not read from an output. The same operator obligation follows (same region, same `environment`), plus one that is unique to this stack: it is the only one whose input is the public internet, so the stage throttle in `infra/api/gateway.tf` is load-bearing configuration rather than tuning. [ADR 0005](../docs/adr/0005-fleet-api-hosting.md) computes the worst-case bill from those two numbers; changing them changes the bound.

`forecast` is where that shape stops being uniform, and the difference is worth knowing before the first apply. Its state lives in `bootstrap`'s bucket and it attaches its own deploy grant there, like the other two; its relationship to `storage` is the same convention-not-a-wire arrangement, with `cumulo-sites-<env>`'s `by-location` index and `cumulo-series-<env>` assembled from the naming convention. But its relationship to `ingestion` is **stronger than either**, because it is the first stack that names another stack's resource in something other than an IAM policy: `aws_lambda_event_source_mapping` in `infra/forecast/event-source.tf` targets `cumulo-weather-readings-<env>` by ARN. Still no `terraform_remote_state` — the ARN is assembled from region, account and the name ADR 0004 fixed — but the consequence differs in kind. A missing table is a stack that applies and then fails at runtime; a missing **queue** is a stack that fails at `terraform apply`, because Lambda validates the event source when the mapping is created. So `ingestion` is a genuine apply-order prerequisite for `forecast`, and the only one in the platform that is not simply "bootstrap first".

There is a second coupling between those two stacks that no dependency graph shows: `infra/forecast/lambda.tf`'s `timeout = 50` and `infra/ingestion/transport.tf`'s `visibility_timeout_seconds = 300` are the two halves of ADR 0004's 6× floor, and raising the first without the second is a correctness bug that nothing mechanical will catch. Both files carry the obligation in a comment; `docs/tech-debt.md` records why the `check:infra-mirrors` gate cannot express it.

`alerting` is the newest, and it is the one stack every other stack points at. It holds the SNS topic that `storage`, `ingestion`, and `api` send their alarm state changes to — and it holds it **without a single cross-stack reference in either direction**. The alarm stacks assemble `arn:aws:sns:<region>:<account-id>:cumulo-alerts-<environment>` from the naming convention, exactly as they assemble table ARNs, so the topic is an interface rather than an output: `alerting` can be applied before or after them, and a plan of any stack succeeds while another is mid-apply. The obligation is the familiar one, with one new failure mode worth stating plainly — same region, same `environment`, because an SNS ARN carries both, and a mismatch is **not** an apply error. CloudWatch accepts an alarm action pointing at a topic that does not exist and reports it only by never delivering, which is why the alerting runbook proves delivery from AWS rather than from a green apply.

Later stacks arrive as sibling directories with their service tickets, per [ADR 0001](../docs/adr/0001-service-boundaries.md): a resource used by exactly one service is owned by that service's stack; a resource more than one service would notice is platform-owned. `storage` is platform-owned by that test — ingestion, forecast, and the fleet API all read or write those tables. So is `alerting`, and more sharply: every stack that has an alarm would notice its absence, and a per-stack topic would multiply the one genuinely manual step in this repo — confirming an email subscription by hand — by the number of stacks, for no gain in routing to a single recipient.

**The one rule that has no exceptions:** no long-lived AWS credentials, anywhere. GitHub Actions authenticates by OIDC and holds no keys. A human operator holds short-term credentials in their own shell, and those never enter this repo, a Terraform variable, or an Actions secret. The single section of this document where operator credentials are discussed at all is [Operator prerequisites](#operator-prerequisites).

---

## Conventions

These eight decisions were made with the bootstrap stack because it is the first Terraform in the repo, and they apply to every stack after it.

### 1. One directory per independently-applied stack

`infra/<stack>/`, flat, no nesting. The unit of a directory is "things that get applied and destroyed together", which is also the unit of a blast radius and of a teardown. Terraform workspaces were rejected for the same reason: they share one configuration across environments, so they cannot express "these resources have separate lifecycles", which is the only distinction being drawn here.

### 2. State keys are `<stack>/terraform.tfstate`

One bucket for the whole project, one key prefix per stack. The prefix is the directory name, so a state object, a directory, and the `Stack` tag on every resource inside it all carry the same word — three independent trails back to the code that owns a resource.

### 3. The state bucket is `cumulo-tfstate-<account-id>`

S3 bucket names are globally unique, so the name needs an account-scoped component; the account id supplies one deterministically. Deliberately **no random suffix**: a random name would have to be recorded somewhere outside Terraform to survive a teardown, and "somewhere outside Terraform" is where infrastructure goes to become undocumented. After a full teardown and a fresh spin-up, the bucket comes back with the same name and `backend.hcl` is still correct.

### 4. Locking uses S3's native lockfile, not a DynamoDB table

`use_lockfile = true` in `backend.tf`. The classic pattern pairs the state bucket with a DynamoDB lock table; S3 now does conditional writes, so the bucket can lock itself. One fewer resource to provision, tag, bill, and remember to destroy — and DynamoDB-based state locking is deprecated in current Terraform, so the classic pattern is now the legacy one. The cost is a hard floor of Terraform 1.12, enforced in `versions.tf` rather than left to a README nobody reads at the wrong moment.

### 5. Pinning: Terraform `>= 1.12.0, < 2.0.0`, AWS provider `~> 6.0`, lock file committed

The Terraform floor is the locking requirement above; the ceiling keeps a future 2.0 from arriving during an apply. The provider is pinned to a major, with the exact patch fixed by `.terraform.lock.hcl`, which is committed. CI pins Terraform to an **exact patch** (`terraform_version` in `.github/workflows/ci.yml`) because `terraform fmt` output is a function of the binary version, and a CI job that disagrees with the operator's formatter is a check that fails for reasons nobody can reproduce.

The lock file records hashes for `darwin_arm64`, `darwin_amd64`, `linux_amd64`, and `linux_arm64` — operator laptops and CI runners both. It is maintained with `terraform providers lock -platform=...`, not by whichever machine happened to run `init` last, and CI runs `init -lockfile=readonly` so a stale lock file fails the build instead of being silently rewritten. When bumping the provider:

```bash
terraform -chdir=infra/bootstrap init -upgrade
terraform -chdir=infra/bootstrap providers lock \
  -platform=darwin_arm64 -platform=darwin_amd64 \
  -platform=linux_amd64 -platform=linux_arm64
```

Every stack carries its own `.terraform.lock.hcl` and is bumped the same way with its own `-chdir`; they are independent files and may legitimately sit on different provider patches until each is bumped.

### 6. First apply: local state, then migrate the stack into its own bucket

The bootstrap stack creates the bucket that stores the bootstrap stack's state, which does not exist when the stack is first applied. Resolved by applying against a local backend, then migrating the resulting state into the bucket that apply just created. Teardown runs it in reverse. Both directions are scripted below in [Runbook: spin up](#runbook-spin-up-the-bootstrap-stack) and [Runbook: tear down](#runbook-tear-down-the-bootstrap-stack), and the mechanism is explained in [Why the override dance](#why-the-override-dance).

**This convention applies to `bootstrap` alone.** Every later stack — `storage` included — finds the bucket already there, so it inits straight against S3 with `-backend-config=backend.hcl` and never sees a local backend, an override file, or a state migration. If you find yourself writing a `backend_override.tf` outside `infra/bootstrap/`, something has gone wrong.

### 7. Account-specific values stay out of the public repo

This repository is public. The AWS account id is not a credential, but it is an identifier that narrows an attacker's search, and there is no reason for it to be in a git history that cannot be rewritten. So `backend.tf` carries a **partial** backend configuration — the repo-wide conventions (`key`, `encrypt`, `use_lockfile`) are committed, and `bucket` and `region` come from a gitignored `backend.hcl` at init time. Region likewise comes from a gitignored `bootstrap.auto.tfvars`. Both have committed `.example` twins, so the shape is documented even though the values are not, and `.gitignore` blocks the real files along with Terraform override files.

Personal config tied to the account goes one step further and does not live on the operator's disk either. The budget alarm's notification address is an email address — personal data with no business in a public git history, and no business being retyped into a local file on every machine that ever applies this stack. It lives in an **operator-created SSM parameter**, `/cumulo/notification-email` (SecureString, default KMS key), and Terraform only ever _reads_ it through a data source. The account is the source of truth: there is exactly one copy, in the region the stack deploys to, and a second machine spinning the stack up needs no handoff. Terraform cannot create it without reintroducing the problem — the value would have to come from a variable again — so the one-time `put-parameter` is an operator step in [A1](#phase-a--configure-and-plan). The address does land in Terraform state, which is why state lives in a private bucket; it never lands in git.

That decision has a consequence worth stating plainly: `terraform output` prints values that embed the account id, and three of the five outputs contain it. Do not paste raw output into committed files, PR bodies, or issue comments — quote the shape (`arn:aws:iam::<account-id>:role/cumulo-github-actions`), not the digits.

### 8. The GitHub Actions role starts with zero permissions, and every grant it later holds lives in the stack that needed it

`aws_iam_role.github_actions` is created with no inline policies and no managed policy attachments, and the bootstrap stack still attaches none. That was never a to-do: the smoke test that proves the role works — `aws sts get-caller-identity` — requires no permissions at all, so the entire OIDC path was verifiable end to end before a single grant existed. Deploy permissions then arrive least-privilege with the service tickets that need them, from those tickets' own stacks and scoped to the resources those services own (ADR 0001). A broad `PowerUserAccess` in `oidc.tf` would be quicker and would quietly undo that, and it would also mean a destroyed service left its deploy rights behind on a role that outlives it.

The first grant landed with the ingestion stack (#11): `infra/ingestion/deploy.tf`, two actions — `lambda:UpdateFunctionCode` and `lambda:GetFunction` — on one function ARN. The consequence for a reader is worth stating plainly: **`oidc.tf` no longer tells you what this role can do, and it never will again.** The account is the only complete answer, and it is one command:

```bash
aws iam list-role-policies --role-name cumulo-github-actions
```

The trust policy is the security boundary, and it is worth reading `oidc.tf` before changing: the `sub` condition is a single-value `StringEquals` allowlist — `…:ref:refs/heads/main` — not a `:*` wildcard, so tags, other branch refs and every event context GitHub has or later adds cannot assume the role at all. It held a second value until #11: a PR-context subject, present only so `oidc-smoke` could run pre-merge against a role with no permissions. That entry was deleted by the same change that attached the first grant, as the rule then required, because a PR-context run is triggerable by any fork author and must never hold deploy permissions. **The rule outlives its first application** — nothing an unmerged contributor controls goes back into that list. What it cost is pre-merge OIDC verification, and the recovery, if that coverage is ever wanted again, is a second, permanently permissionless role trusted for the PR context alone; see the header comment in `.github/workflows/oidc-smoke.yml`, which now runs on `main` pushes and `workflow_dispatch` for exactly this reason.

Checking `aud` is necessary and nowhere near sufficient — every GitHub Actions token in the world carries `aud=sts.amazonaws.com`, so a trust policy that stops at the audience lets any repository on GitHub assume the role while still looking like it has a condition block that does something.

The prefix in front of those two claims is GitHub's **immutable subject**, `repo:<owner>@<owner-id>/<repo>@<repo-id>`, and it is the part worth getting right. Almost every GitHub-OIDC tutorial shows the name-based form `repo:<owner>/<repo>:…`; current GitHub does not issue that, so a policy written from those examples matches nothing and every assume fails with `Not authorized to perform sts:AssumeRoleWithWebIdentity` — a failure that reads like a missing permission and is actually a string mismatch. Embedding the ids is also the stricter choice, not merely the working one: GitHub names are reassignable, so a name-based policy would keep trusting whoever registered the org or repo name this project released, while numeric ids are never reissued.

Because the ids are not derivable from the names, the value is read from GitHub rather than assembled, and lives in `var.github_subject_prefix` (`variables.tf`), whose `validation` block rejects a name-only prefix outright:

```bash
gh api repos/OWNER/REPO/actions/oidc/customization/sub --jq .sub_claim_prefix
# repo:<owner>@<owner-id>/<repo>@<repo-id>
```

The numeric owner and repository ids are public identifiers, not secrets — unlike the account id of convention 7, they belong in the committed default.

---

## Operator prerequisites

Needed once per machine, before either runbook.

**Terraform**, at the exact version CI pins:

```bash
brew install hashicorp/tap/terraform
terraform version   # expect v1.15.8 — must satisfy >= 1.12.0, < 2.0.0
```

**GitHub CLI**, authenticated (`gh auth status`), for publishing repo variables.

**AWS CLI 2.32 or newer**, because the login flow below needs it:

```bash
aws --version   # expect aws-cli/2.32.0 or later
```

**Short-term AWS credentials, obtained by browser login:**

```bash
aws login
```

This opens a browser OAuth flow and stores **short-term credentials that the CLI refreshes automatically**, with a hard 12-hour session cap after which you log in again. There is no access key to create, copy, paste, rotate, or leak — which is the point. If you are signing in as an IAM user rather than the account root, that user needs the AWS-managed **`SignInLocalDevelopmentAccess`** policy attached; root needs nothing extra.

Confirm you are pointed at the intended account before touching anything:

```bash
aws sts get-caller-identity
```

> **If a tool cannot find the credentials.** Terraform and other SDK-based tools resolve the login provider through the standard credential chain, but an older SDK in the chain may not recognise it. Bridge it for the current shell only:
>
> ```bash
> eval "$(aws configure export-credentials --format env)"
> ```
>
> These are the same short-term credentials, exported into environment variables; they expire with the session. Never redirect that command into a file, a `.env`, or an Actions secret.

**What never happens, in either runbook:** creating an IAM access key, writing credentials to a file in this repo, or adding an AWS secret to GitHub. `gh secret list` should never show an AWS entry — the OIDC role exists so that it does not have to.

---

## Runbook: spin up the bootstrap stack

Every command runs from `infra/bootstrap/`:

```bash
cd infra/bootstrap
```

### Where the phases sit relative to PR review

The runbook splits at the plan, because `.tf` files require human review before they are applied ([CLAUDE.md](../CLAUDE.md) merge policy) and because a plan is exactly the artefact a reviewer needs:

- **Phase A** — through `terraform plan`. Nothing is created; a plan needs only read access. Its summary goes in the PR body.
- **PR review** — human, on the PR.
- **Phase B** — `apply` onward, after review.

On the bootstrap PR this ordering is mandatory. On any later clean spin-up (including the teardown rehearsal's re-apply) there is no PR in flight, so Phase A runs straight into Phase B.

### Phase A — configure and plan

**A1. Create the two gitignored local files from their committed examples.**

```bash
cp bootstrap.auto.tfvars.example bootstrap.auto.tfvars
cp backend.hcl.example backend.hcl
```

Set the region in `bootstrap.auto.tfvars` — `aws_region = "eu-west-1"` — and in `backend.hcl` set both the region and the bucket name. The bucket name is `cumulo-tfstate-` followed by the account id:

```bash
aws sts get-caller-identity --query Account --output text
```

`backend.hcl`'s `region` and `bootstrap.auto.tfvars`'s `aws_region` must be the same value: the backend and the provider have to agree on where the bucket lives. `github_repository` needs no entry — it defaults to `TomBennett-Lloyd/cumulo`.

**Applying against your own fork or account?** Then `github_subject_prefix` does need an entry, because its default is this repository's immutable subject and no other repository's tokens will ever match it. Re-derive yours and put it in `bootstrap.auto.tfvars` alongside the region (convention 8 explains why this is the security boundary):

```bash
gh api repos/OWNER/REPO/actions/oidc/customization/sub --jq .sub_claim_prefix
```

**Still A1, but once per _account_ rather than once per machine: the budget-alarm notification parameter.** The budget alarm emails this address; per convention 7 it lives in the account rather than in any file here:

```bash
aws ssm put-parameter --name /cumulo/notification-email \
  --type SecureString --value <your-email> --region eu-west-1
```

`--region` must be the same value as `bootstrap.auto.tfvars`'s `aws_region`: Parameter Store is regional and the data source reads from the region the provider is configured for, so a CLI default region that differs from `aws_region` writes the parameter somewhere Terraform will never look — and A5 then fails with `ParameterNotFound` for a parameter that demonstrably exists. Pass it explicitly rather than trusting the CLI default. This has already been done for this account, so a routine spin-up skips it; the step exists so a clean account can be reproduced from this document alone. Confirm it is there, in the right region, without printing the address:

```bash
aws ssm get-parameter --name /cumulo/notification-email --query 'Parameter.Name' --output text --region eu-west-1
```

Terraform reads the parameter and never writes it. If it is missing, the plan in A5 fails with a `ParameterNotFound` error naming this parameter — which is the intended failure, not a reason to hardcode an address.

**A2. Add the local-backend override.**

```bash
cat > backend_override.tf <<'EOF'
terraform {
  backend "local" {}
}
EOF
```

**A3. Confirm none of that is visible to git.** All three files are gitignored; this proves it rather than assuming it:

```bash
git status --short   # expect no output for infra/bootstrap/
```

**A4. Initialise against local state.** No `-backend-config` here — the override replaced the S3 backend, and a local backend takes no bucket:

```bash
terraform init
```

**A5. Plan.** The tee target is outside the repo on purpose, so a plan output file cannot be committed:

```bash
terraform plan -no-color | tee ~/cumulo-bootstrap-plan.txt
```

Expect **`Plan: 8 to add, 0 to change, 0 to destroy.`** — one S3 bucket plus its four configuration resources, the IAM OIDC provider, the IAM role, and the AWS Budgets cost-ceiling budget. Any other count means the configuration is not what this document describes; stop and find out why. The `/cumulo/notification-email` parameter is read, not created, so it adds nothing to that count.

**A6. Stop here on the bootstrap PR.** Summarise the plan in the PR body (resource counts, bucket name shape, role name — not the account digits, per convention 7) and wait for review. `oidc-smoke` does not run on the PR at all — it has not been a pre-merge check since #11 (convention 8) — so there is no red check to explain here; B7 runs it by hand once the variables exist.

### Phase B — apply, migrate, publish

**B1. Apply.**

```bash
terraform apply
```

**B2. Remove the override and migrate the state into the bucket that now exists.** Terraform will ask whether to copy the existing state to the new backend; answer `yes`:

```bash
rm backend_override.tf
terraform init -migrate-state -backend-config=backend.hcl
```

**B3. Verify the state actually landed remotely — before removing anything local.**

```bash
BUCKET="$(terraform output -raw state_bucket_name)"
aws s3api head-object --bucket "$BUCKET" --key bootstrap/terraform.tfstate
terraform state list   # now read from S3
```

Expect **11 lines**: the 8 managed resources from A5 plus the three data sources
(`data.aws_caller_identity.current`, `data.aws_iam_policy_document.github_actions_trust`,
`data.aws_ssm_parameter.notification_email`), which `state list` prints alongside them.
Only the 8 are created, billed, or destroyed.

**B4. Remove the local state files.** They are gitignored, but a stale local state that still describes live resources is a trap for the next operator:

```bash
rm -f terraform.tfstate terraform.tfstate.backup
```

**B5. Confirm no drift.** `-detailed-exitcode` exits `0` for no changes, `2` for pending changes, `1` for an error — so the exit code is the assertion:

```bash
terraform plan -detailed-exitcode
echo $?   # expect 0
```

**B6. Publish the two repo variables.** Both values come from `terraform output`, never hand-assembled from an account id or retyped from memory:

```bash
gh variable set AWS_OIDC_ROLE_ARN --repo TomBennett-Lloyd/cumulo \
  --body "$(terraform output -raw github_actions_role_arn)"
gh variable set AWS_REGION --repo TomBennett-Lloyd/cumulo \
  --body "$(terraform output -raw aws_region)"
```

The region is an _input_ to this stack rather than something it derives, so the stack re-exports it as the `aws_region` output purely to keep this step copy-paste: what lands in the repo variable is then provably the same value Terraform used, and cannot drift from `aws_region` in `bootstrap.auto.tfvars` or `region` in `backend.hcl`. Then confirm what exists, and what does not:

```bash
gh variable list --repo TomBennett-Lloyd/cumulo
gh secret list --repo TomBennett-Lloyd/cumulo   # expect no AWS entry, ever
```

**B7. Prove the role can be assumed.** This is the only check that exercises the OIDC path end to end:

```bash
gh workflow run oidc-smoke.yml --repo TomBennett-Lloyd/cumulo
gh run list --workflow oidc-smoke.yml --repo TomBennett-Lloyd/cumulo --limit 1
```

`workflow_dispatch` is the whole of the manual path, and since #11 it is also the only way to run this check other than merging an `infra/**` change to `main`. So run it here rather than assuming a PR check covered it.

The evidence is the `aws sts get-caller-identity` output in the run log: an account, and a caller ARN of the form `arn:aws:sts::<account-id>:assumed-role/cumulo-github-actions/cumulo-oidc-smoke-<run-id>`. Confirm the account matches the one from `terraform output -raw aws_account_id`.

---

## Runbook: tear down the bootstrap stack

Teardown is a first-class requirement, not a paragraph of good intentions: the cost ceiling in [CLAUDE.md](../CLAUDE.md) is only credible if this works, and it is exercised rather than assumed.

**Exercised once, then read.** This runbook was rehearsed end to end — real destroy, real re-spin-up — when the stack was first built. That rehearsal proves the _procedure_; it does not need repeating every time a resource joins the stack, because repeating it puts live state at real risk to re-prove something already proven. So the routine check that a newly added resource dies with the stack is the non-destructive one:

```bash
terraform -chdir=infra/bootstrap plan -destroy -no-color
```

Expect **`Plan: 0 to add, 0 to change, 8 to destroy.`** with the new resource among the enumerated destroys — for the cost-ceiling budget, `aws_budgets_budget.monthly_cost_ceiling`. A resource that Terraform plans to destroy is a resource Terraform owns, which is the whole claim. Full rehearsals are reserved for changes to the teardown procedure itself (the override dance, the backend, the ordering below), where the procedure is what is in doubt. Everything from T1 onward describes a real teardown, for when one is actually wanted.

The ordering matters more than anything else here. **The state that describes the bucket lives in the bucket.** Destroy the bucket while state is still remote and Terraform loses the record of what it was deleting mid-operation. So the state comes home first.

**T1. Bring the state back to local disk.**

```bash
cd infra/bootstrap
cat > backend_override.tf <<'EOF'
terraform {
  backend "local" {}
}
EOF
terraform init -migrate-state
```

**T2. Confirm the local state is real before destroying its remote home.**

```bash
ls -l terraform.tfstate
terraform state list   # expect the same 11 lines as B3 — 8 resources + 3 data sources
```

This step is load-bearing, not ceremony. T1's prompt accepts only the literal string `yes`; anything else — including `y` — is taken as "start with an empty state", and Terraform then reports a _successful_ init while `terraform.tfstate` never appears and the real state stays in S3. A `terraform destroy` from that position would have no idea what it owns. If `ls` finds no file, nothing has been lost yet: re-init back to S3 with `terraform init -reconfigure -backend-config=backend.hcl` and start T1 again.

**T3. Destroy.** `force_destroy = true` on the bucket is what allows this to complete — a versioned bucket is never empty, and by this point it holds only a copy of state that T1 already brought home:

```bash
terraform destroy
```

**T4. Verify it is actually gone**, from AWS rather than from Terraform's own opinion. All four commands are expected to _fail_ or come back empty, and the specific failures are the evidence:

```bash
BUCKET="cumulo-tfstate-$(aws sts get-caller-identity --query Account --output text)"

aws s3api head-bucket --bucket "$BUCKET"
# expect: An error occurred (404) ... Not Found

aws iam get-role --role-name cumulo-github-actions
# expect: An error occurred (NoSuchEntity) ...

aws iam list-open-id-connect-providers
# expect: no entry containing token.actions.githubusercontent.com

aws budgets describe-budget \
  --account-id "$(aws sts get-caller-identity --query Account --output text)" \
  --budget-name cumulo-monthly-cost-ceiling
# expect: An error occurred (NotFoundException) ...
```

The budgets API is account-scoped rather than regional, so it needs the account id passed explicitly; deriving it from `sts get-caller-identity` in the same line keeps the digits out of this file (convention 7).

**T5. Clean the working directory.**

```bash
rm -f backend_override.tf terraform.tfstate terraform.tfstate.backup
rm -rf .terraform
```

Keep `backend.hcl` and `bootstrap.auto.tfvars` — the bucket name is deterministic (convention 3), so both are still correct for the next spin-up.

**T6. Repo variables and the notification parameter — leave them, unless this is the end of the project.** A teardown rehearsal should _not_ delete `AWS_OIDC_ROLE_ARN`: the role name and account are fixed, so a fresh apply reproduces a byte-identical ARN, and the stored value still matching afterwards is itself a check that the runbook is reproducible. The same logic covers `/cumulo/notification-email`: Terraform never owned it, `destroy` therefore never touched it, and leaving it means the next spin-up needs no A1 handoff. Only on a final decommission:

```bash
gh variable delete AWS_OIDC_ROLE_ARN --repo TomBennett-Lloyd/cumulo
gh variable delete AWS_REGION --repo TomBennett-Lloyd/cumulo
aws ssm delete-parameter --region eu-west-1 --name /cumulo/notification-email
```

**After T4 this stack costs exactly $0** — not "approximately nothing", but no billable resource remaining. There is nothing left to leak, because IAM roles, OIDC providers and notification-only budgets are all free, and the only chargeable thing the stack ever created was the bucket. The parameter left behind by T6 is free too: standard tier, default KMS key.

To spin back up, run [Phase A](#phase-a--configure-and-plan) then [Phase B](#phase-b--apply-migrate-publish) back to back; A1 is already done.

---

## Why the override dance

The chicken-and-egg is real and worth understanding before improvising around it: **this stack's state describes the bucket that stores this stack's state.** On first apply there is nowhere to put the state that records the bucket's creation.

Terraform's [override file](https://developer.hashicorp.com/terraform/language/files/override) semantics are the escape hatch. A file named `override.tf` or `*_override.tf` has its blocks _merged over_ the matching blocks in the rest of the configuration — so a `backend "local" {}` in `backend_override.tf` replaces the `backend "s3"` block in `backend.tf` without editing it. Then `terraform init -migrate-state` moves state between backends when the backend configuration changes.

Three properties make this the right shape:

- **The committed configuration is always the truth.** `backend.tf` contains the real S3 backend at every commit. Nobody reviewing the repo sees a local backend and wonders whether state is on someone's laptop, and there is no "remember to change this back" step whose omission is invisible.
- **The override cannot be committed.** `.gitignore` blocks `override.tf`, `*_override.tf`, and their `.json` forms. A missed cleanup fails closed.
- **It reverses cleanly.** The same override, applied again, is what brings state home before teardown.

Alternatives, and why not: creating the bucket by hand or by CLI script leaves it unmanaged by Terraform, so it never appears in a plan and never gets destroyed by a teardown. A separate "bootstrap-the-bootstrap" stack just moves the same problem one directory over and adds a state file that has the identical question to answer. Committing a local backend and remembering to point it at S3 later relies on the one thing that is guaranteed to fail eventually.

---

## Why the cost-ceiling budget lives in bootstrap

The ~$100/month ceiling in [CLAUDE.md](../CLAUDE.md) was a convention until `aws_budgets_budget.monthly_cost_ceiling` made AWS enforce it: a monthly COST budget named `cumulo-monthly-cost-ceiling` that emails the address in `/cumulo/notification-email` at 50%, 80% and 100% of actual spend, and at a forecast of 100%.

It sits in this stack rather than a sibling one because of convention 1. A stack is a lifecycle unit, and this alarm's lifecycle is exactly bootstrap's: it has to exist from the first spin-up until the final decommission, and it has to be the last thing still watching while anything else in the account is billable. A sibling stack would either be torn down before bootstrap — leaving the alarm dead while resources were still spending — or need a new cross-stack ordering rule to prevent that. It is account-level and more than one service will rely on it, so [ADR 0001](../docs/adr/0001-service-boundaries.md) makes it platform-owned.

That does not dilute convention 8. Bootstrap's "deliberately minimal" property is about _deploy permissions_ and app resources, and this budget is notification-only: no budget action, no SNS topic, no IAM grant of any kind. It added nothing to the GitHub Actions role, it did not touch the trust policy, and CI still never touches AWS to plan or validate. Budget _actions_ — auto-attaching a deny policy at 100% — would change all three of those and start the $0.10/day meter; they are a separate decision, not an increment of this one. (The role's zero-permission state ended later and for an unrelated reason — #11's deploy grant, from the ingestion stack — which is convention 8's subject, not this budget's.)

Email subscribers are attached to the budget directly rather than through SNS. Budget notifications need no subscription confirmation, whereas an SNS email subscription requires a human to click a link and, until they do, cannot be deleted for three days — a teardown that blocks for three days is not a teardown.

The `alerting` stack does not overturn that reasoning; it is the case where the same reasoning runs out. A CloudWatch alarm action **must** be an ARN, so alarms cannot reach an inbox without a topic, and the three-day floor becomes an operator obligation — confirm the subscription promptly — rather than a design that can avoid it. The two stacks read the same `/cumulo/notification-email` parameter and arrive at the same inbox by the two different routes their resources require. Keeping the topic out of `bootstrap` is convention 1 again: the budget must outlive everything billable, whereas a topic with no alarms pointing at it is dead weight, so their lifecycles are genuinely different.

**A quiet forecast alarm is not a broken one.** FORECASTED notifications need roughly five weeks of usage history before AWS will produce a forecast at all, so on a young account that threshold is simply silent. The three ACTUAL thresholds work from the first billing period and cover the gap.

---

## Runbook: the alerting stack

One SNS topic and one email subscription — the destination for every CloudWatch alarm in the platform, per [issue #29](https://github.com/TomBennett-Lloyd/cumulo/issues/29). Every command runs from `infra/alerting/`:

```bash
cd infra/alerting
```

**Prerequisites:** the bootstrap stack applied (this stack's state lives in the bucket bootstrap creates, and `/cumulo/notification-email` is created in bootstrap's step A1), and an operator credential session — see [Operator prerequisites](#operator-prerequisites).

**Apply it any time after bootstrap.** There is no ordering constraint against `storage`, `ingestion` or `api` in either direction: those stacks assemble this topic's ARN from the naming convention rather than reading an output, so they plan and apply whether or not the topic exists. Applying `alerting` **last** is therefore legal and is also the mistake worth naming — in the window before it exists, every alarm in the account has an action pointing at nothing and fails to deliver silently. Apply it early.

**There is no override dance here** (convention 6). The state bucket already exists, so this stack inits straight against S3.

### Phase A — configure and plan the topic

**A1. Create the two gitignored local files from their committed examples.**

```bash
cp alerting.auto.tfvars.example alerting.auto.tfvars
cp backend.hcl.example backend.hcl
```

Set `aws_region` in `alerting.auto.tfvars`, and both `region` and `bucket` in `backend.hcl`. The region must match every other stack's: an SNS ARN is regional, the alarm stacks build it from `var.aws_region`, and `/cumulo/notification-email` is a regional SSM parameter this stack has to be able to read.

`environment` needs no entry; it defaults to `dev`. It must match the `environment` the alarm stacks were applied with, because it is part of the topic name they assemble.

**A2. Confirm none of that is visible to git.**

```bash
git status --short   # expect no output for infra/alerting/
```

**A3. Initialise against the real backend.**

```bash
terraform init -backend-config=backend.hcl
```

**A4. Plan.** The tee target is outside the repo on purpose, so a plan output file cannot be committed:

```bash
terraform plan -no-color | tee ~/cumulo-alerting-plan.txt
```

Expect **`Plan: 2 to add, 0 to change, 0 to destroy.`** — the topic and its email subscription. The `/cumulo/notification-email` parameter is read, not created, so it adds nothing to that count. Any other count means the configuration is not what this document describes; stop and find out why.

**If the plan fails with the "must hold a single plain email address" message**, the parameter holds a display name, angle brackets, or a comma-separated list. That is a deliberate `postcondition` in `topic.tf`, mirroring `bootstrap/budget.tf`: AWS accepts a malformed endpoint, creates a subscription that looks healthy, and never delivers — which would silence every alarm in the platform. Fix the parameter and re-plan.

**A5. Stop here on the PR.** `.tf` files require human review before they are applied (CLAUDE.md merge policy).

### Phase B — apply, confirm, and prove delivery

**B1. Apply.**

```bash
terraform apply
```

**B2. Confirm the subscription from the inbox.** SNS sends a confirmation mail to the address in the parameter; open it and click the link. **This is the one manual step in this repository, and it is not optional.** Terraform creates the subscription in `PendingConfirmation` and reports a clean apply either way — a green apply is not evidence that alerts will be delivered.

Confirm it promptly for a second reason: an unconfirmed SNS subscription cannot be deleted for three days, which would put a three-day floor under `terraform destroy` of this stack. A confirmed one deletes immediately.

**B3. Prove the subscription is real.** Read it back from AWS, not from Terraform's opinion of AWS. The assertion is the absence of the literal string `PendingConfirmation`:

```bash
aws sns list-subscriptions-by-topic \
  --topic-arn "$(terraform output -raw topic_arn)" \
  --query 'Subscriptions[].{Protocol:Protocol,Arn:SubscriptionArn}'
# expect: Protocol "email" and an Arn ending in a subscription id
# NOT:    "PendingConfirmation"
```

**B4. Confirm no drift.**

```bash
terraform plan -detailed-exitcode
echo $?   # expect 0
```

**B5. Prove an alarm actually reaches the inbox.** This is the only check that exercises the whole path — assembled ARN, topic policy, subscription — and none of the three fails loudly on its own. Drive one alarm into ALARM by hand and wait for the mail:

```bash
aws cloudwatch set-alarm-state \
  --alarm-name "cumulo-api-dev-request-flood" \
  --state-value ALARM \
  --state-reason "alerting runbook B5 notification smoke"
```

The mail arrives within a minute or so. The alarm returns to OK on its next evaluation without further action, and `ok_actions` means that recovery arrives as a second mail — which is itself the proof that the recovery half of the wiring works.

If nothing arrives, check in this order: the subscription is confirmed (B3); the alarm's `AlarmActions` names the topic that actually exists (`aws cloudwatch describe-alarms --alarm-names … --query 'MetricAlarms[].AlarmActions'` against `terraform output -raw topic_arn` — a region or `environment` mismatch between stacks shows up here and nowhere else); and the topic has not acquired server-side encryption, which silently blocks CloudWatch from publishing (see the comment in `topic.tf`).

**B6. Confirm the platform's alarm count matches the budget below.**

```bash
aws cloudwatch describe-alarms --alarm-name-prefix cumulo- \
  --query 'length(MetricAlarms)'
# expect: 9 — see "CloudWatch alarm budget" in the Cost section
```

### Teardown

```bash
terraform destroy
```

Expect `2 to destroy`. It completes immediately **provided the subscription was confirmed**; an unconfirmed one blocks for three days, which is the whole reason B2 is written as an obligation rather than a suggestion.

Verify from AWS rather than from Terraform:

```bash
aws sns list-topics --query "Topics[?contains(TopicArn, 'cumulo-alerts')]"
# expect: []
```

Destroying this stack does not break any other stack's apply — the alarms keep an action pointing at an ARN that no longer resolves, and CloudWatch neither complains nor delivers. **That is the failure mode to remember:** a torn-down alerting stack looks exactly like a healthy one from every other stack's perspective. Tear it down last, or accept that nothing is watching.

**Leave the topic up at the end.** It costs $0 sitting there, and every alarm in the account is pointing at it.

---

## Runbook: the storage stack

Four DynamoDB tables and four CloudWatch alarms, per [ADR 0002](../docs/adr/0002-storage-split.md). Every command runs from `infra/storage/`:

```bash
cd infra/storage
```

**Prerequisites:** the bootstrap stack applied (this stack's state lives in the bucket bootstrap creates), and an operator credential session — see [Operator prerequisites](#operator-prerequisites).

**There is no override dance here.** The bucket already exists, so this stack inits straight against S3 (convention 6). No `backend_override.tf`, no local state, no `-migrate-state`, in either direction.

### Phase A — configure and plan the tables

The same A/B split as the bootstrap runbook, and for the same reason: `.tf` files require human review before they are applied, and a plan is exactly the artefact a reviewer needs. The heading differs from bootstrap's only so the two sections have distinct anchors.

**A1. Create the two gitignored local files from their committed examples.**

```bash
cp storage.auto.tfvars.example storage.auto.tfvars
cp backend.hcl.example backend.hcl
```

Set `aws_region` in `storage.auto.tfvars`, and both `region` and `bucket` in `backend.hcl`. They must be the same region as the bootstrap stack — the backend and the provider have to agree on where the bucket lives, and the bucket only exists in one place. The bucket name is `cumulo-tfstate-` followed by the account id:

```bash
aws sts get-caller-identity --query Account --output text
```

`environment` needs no entry; it defaults to `dev`. Setting it to something else creates a **fresh, empty** set of tables — DynamoDB has no rename, so Terraform destroys and recreates, and the data goes with it.

**A2. Confirm none of that is visible to git.**

```bash
git status --short   # expect no output for infra/storage/
```

**A3. Initialise against the real backend.**

```bash
terraform init -backend-config=backend.hcl
```

**A4. Plan.** The tee target is outside the repo on purpose, so a plan output file cannot be committed:

```bash
terraform plan -no-color | tee ~/cumulo-storage-plan.txt
```

Expect **`Plan: 8 to add, 0 to change, 0 to destroy.`** — four tables (`sites`, `series`, `weather`, `metrics`) and four throttle alarms (read and write, on `series` and `weather`). Any other count means the configuration is not what this document describes; stop and find out why. In particular, **9 or more would mean an auto-scaling resource has appeared**, which is the one thing `tables.tf` exists to prevent.

**A5. Stop here on the PR.** `.tf` files require human review before they are applied (CLAUDE.md merge policy). Summarise the plan in the PR body — resource counts, table-name shape, capacity numbers — and label it `awaiting-review`.

### Phase B — apply and prove

**B1. Apply.**

```bash
terraform apply
```

**B2. Confirm what exists.**

```bash
terraform state list   # expect exactly 8 lines — this stack has no data sources
```

**B3. Confirm the capacity that the whole cost argument rests on.** Read it back from AWS, not from Terraform's opinion of AWS:

```bash
ENV="$(terraform output -raw environment)"
aws dynamodb describe-table --table-name "cumulo-series-$ENV" \
  --query 'Table.ProvisionedThroughput.{W:WriteCapacityUnits,R:ReadCapacityUnits}'
# expect: W 14, R 21
aws dynamodb describe-table --table-name "cumulo-weather-$ENV" \
  --query 'Table.ProvisionedThroughput.{W:WriteCapacityUnits,R:ReadCapacityUnits}'
# expect: W 5, R 3
```

19 WCU / 24 RCU against the Region's always-free 25 / 25. Then confirm the non-resource is genuinely absent — an empty list here is the assertion that nothing can scale this past the free tier:

```bash
aws application-autoscaling describe-scalable-targets --service-namespace dynamodb
# expect: {"ScalableTargets": []}
```

**B4. Confirm no drift.**

```bash
terraform plan -detailed-exitcode
echo $?   # expect 0
```

**B5. Smoke-test the adapters against the real tables.** This is the only check that exercises TTL, sparse GSI behaviour, and `BETWEEN` range semantics — the three things unit tests cannot prove:

```bash
CUMULO_ENV="$(terraform output -raw environment)" pnpm --filter @cumulo/storage smoke
```

Every line PASS, exit 0, and no residual items (the script re-queries to prove it).

### Teardown rehearsal

Teardown is a project requirement, so it is exercised rather than documented. Unlike bootstrap's, this one has no ordering trap — the state lives in a bucket another stack owns, so nothing is destroying its own foundation.

**What it costs you: all the data, irrecoverably.** No PITR, no final snapshot, no export — deliberate, per ADR 0002. The archive weather cache embodies spent Open-Meteo quota and re-fetching it spends the quota again.

```bash
terraform destroy
```

Verify from AWS rather than from Terraform:

```bash
aws dynamodb list-tables --query "TableNames[?starts_with(@, 'cumulo-')]"
# expect: []
aws cloudwatch describe-alarms --alarm-name-prefix cumulo- --query "MetricAlarms[?ends_with(AlarmName, 'throttle')].AlarmName"
# expect: []
```

The filter is what keeps this assertion honest now that more than one stack creates `cumulo-` alarms: the four throttle alarms are storage's, and the other stacks' — ingestion's three (`…-errors`, `…-dlq-…-not-empty`, `cumulo-ingestion-<env>-async-dropped`) and the api stack's two (`cumulo-api-<env>-5xx`, `cumulo-api-<env>-request-flood`) — are expected to survive a storage teardown. A bare prefix query would have started reporting a failed teardown the day ingestion was applied.

Then re-apply and re-verify, because a teardown that cannot be reversed is only half a rehearsal:

```bash
terraform apply
terraform plan -detailed-exitcode ; echo $?   # expect 0
CUMULO_ENV="$(terraform output -raw environment)" pnpm --filter @cumulo/storage smoke
```

Keep `backend.hcl` and `storage.auto.tfvars` — both are still correct for the next spin-up. **Leave the tables up at the end**: #11, #12, #14, and #16 need them, and they cost $0 sitting there, which is the entire point of the capacity decision.

---

## Runbook: the ingestion stack

One Lambda, one hourly EventBridge rule, one SQS queue with its dead-letter queue, one log group, one execution role, three alarms, and one deploy grant on the shared GitHub Actions role — the whole of [issue #11](https://github.com/TomBennett-Lloyd/cumulo/issues/11)'s infrastructure, per [ADR 0004](../docs/adr/0004-ingestion-transport.md), plus the cycle-starvation alarm [issue #29](https://github.com/TomBennett-Lloyd/cumulo/issues/29) added. Every command runs from `infra/ingestion/`:

```bash
cd infra/ingestion
```

> **Applying this stack for the first time since #11 merged? Re-apply `bootstrap` first.** #11 changed two stacks at once, and the order is not optional. `infra/bootstrap/oidc.tf` lost the PR-context subject from its trust policy (convention 8) and `infra/ingestion/deploy.tf` gained the inline policy that forced that deletion. Apply bootstrap first, then this stack: applying ingestion first would attach a deploy permission to a role that a fork PR author can still assume, which is precisely the window the trust-policy change closes. Bootstrap's re-apply is small — `Plan: 0 to add, 1 to change, 0 to destroy`, the role's `assume_role_policy` — and needs no override dance, because bootstrap's state is already remote by this point.

**Prerequisites**, in this order and for these reasons:

1. **The bootstrap stack applied** — this stack's state lives in the bucket bootstrap creates, and since #11 this stack also attaches an inline policy to the role bootstrap owns, so `data.aws_iam_role.github_actions` fails at plan time if bootstrap has not run.
2. **The storage stack applied**, with the same `environment` and in the same region. Not a Terraform dependency: nothing here references storage's state or outputs, and a plan succeeds without it. It is a _runtime_ prerequisite — the IAM policy grants access to `cumulo-sites-<env>` and `cumulo-weather-<env>` by name, so applying against absent tables produces a stack that plans, applies, and then fails its first cycle in CloudWatch.
3. **An operator credential session** — see [Operator prerequisites](#operator-prerequisites).
4. **A built Lambda artefact**, which is the one prerequisite the other two runbooks do not have.

**There is no override dance here** (convention 6), exactly as in the storage runbook: the bucket already exists, so this stack inits straight against S3 in both directions.

### Phase A — build, configure, and plan

**A1. Build the artefact. This comes first, not last.**

```bash
pnpm --filter @cumulo/ingestion build
ls -l ../../apps/ingestion/dist/handler.zip
```

`apps/ingestion/dist/handler.zip` is a fixed contract between that build script and `lambda.tf`, not something Terraform discovers or produces — a `null_resource` shelling out to pnpm during a plan is the kind of infrastructure that works on exactly one machine. Terraform reads the file to compute `source_code_hash`, which is what makes a rebuilt artefact actually deploy instead of comparing equal on filename alone.

Skip this step and `terraform plan` stops with `No Lambda artefact at apps/ingestion/dist/handler.zip` and the command to run — a resource precondition, chosen over letting the apply fail later with the provider's `no such file or directory`. Note the asymmetry that makes CI work: `terraform validate` deliberately does **not** need the artefact, because whether the configuration is well-formed is not a question about whether somebody ran a build. CI validates all three stacks on every push and builds nothing.

**A2. Create the two gitignored local files from their committed examples.**

```bash
cp ingestion.auto.tfvars.example ingestion.auto.tfvars
cp backend.hcl.example backend.hcl
```

Set `aws_region` in `ingestion.auto.tfvars`, and both `region` and `bucket` in `backend.hcl`. Same region as bootstrap and storage — the backend and the provider have to agree on where the bucket lives, and a DynamoDB table ARN is regional, so a mismatch here silently grants access to tables in a region that has none. The bucket name is `cumulo-tfstate-` followed by the account id:

```bash
aws sts get-caller-identity --query Account --output text
```

`environment` needs no entry; it defaults to `dev`. If you set it, set the same value in `storage.auto.tfvars` — it is in the queue, function, log group, and granted table names.

**A3. Confirm none of that is visible to git.**

```bash
git status --short   # expect no output for infra/ingestion/
```

`dist/` is gitignored too, so the artefact from A1 does not appear either.

**A4. Initialise against the real backend.**

```bash
terraform init -backend-config=backend.hcl
```

**A5. Plan.** The tee target is outside the repo on purpose, so a plan output file cannot be committed:

```bash
terraform plan -no-color | tee ~/cumulo-ingestion-plan.txt
```

Expect **`Plan: 14 to add, 0 to change, 0 to destroy.`** — the queue, the DLQ, the function, the log group, the EventBridge rule, its target, the async invoke config that pins the function's retry policy to zero, the Lambda permission, the execution role, its inline policy, the three alarms, and the deploy grant on `cumulo-github-actions`. Any other count means the configuration is not what this document describes; stop and find out why. The five data sources — `aws_caller_identity`, the existing `cumulo-github-actions` role, and three IAM policy documents (Lambda trust, execution, deploy) — are read rather than created and add nothing to the count.

**A6. Stop here on the PR.** `.tf` files require human review before they are applied (CLAUDE.md merge policy). Summarise the plan in the PR body — resource counts, queue-name shape, the timeout numbers — and label it `awaiting-review`. Per convention 7, quote shapes rather than digits.

### Phase B — apply and prove the cycle

The heading differs from the storage runbook's only so the two sections have distinct anchors, the same reason its Phase A differs from bootstrap's.

**B1. Apply.**

```bash
terraform apply
```

**B2. Confirm what exists.**

```bash
terraform state list   # expect 18 lines — the 13 resources plus the 5 data sources
```

The deploy grant is the one resource in this stack that lives on something another stack owns, so confirm it landed where it was meant to rather than trusting the count:

```bash
aws iam list-role-policies --role-name cumulo-github-actions
# expect: cumulo-ingestion-deploy-<env>
```

**B3. Capture the two identifiers other things need.** Both come from `terraform output`, never hand-assembled and never retyped: a queue URL is **server-assigned**, and a URL guessed from an account id and a queue name is how a configuration ends up pointing at a queue that does not exist.

```bash
terraform output -raw queue_url
terraform output -raw function_name
```

The queue URL embeds the account id, so it is a convention-7 value: it goes into #12's stack configuration and into your shell, never into a committed file, a PR body, or an issue comment.

**B4. Prove the schedule is armed** — that the rule exists, is enabled, and points at the function:

```bash
ENV="$(terraform output -raw environment)"
aws events describe-rule --name "cumulo-ingestion-hourly-$ENV" --query '{Schedule:ScheduleExpression,State:State}'
# expect: cron(7 * * * ? *), ENABLED
aws events list-targets-by-rule --rule "cumulo-ingestion-hourly-$ENV" --query 'Targets[].Arn'
# expect: one ARN, the ingestion function
```

**B5. Invoke a cycle by hand rather than waiting until minute 7.** The handler takes no event payload, so an empty object is the whole invocation:

```bash
aws lambda invoke --function-name "$(terraform output -raw function_name)" \
  --payload '{}' --cli-binary-format raw-in-base64-out /dev/stdout
```

Expect a `CycleReport` and no `FunctionError`. A `FunctionError` carrying `CycleFailedError` is the intended signal that some location did not publish — read the `ingestion.cycle.summary` log line for how many of how many:

```bash
aws logs tail "/aws/lambda/$(terraform output -raw function_name)" --since 10m
```

**B6. Confirm the messages actually landed.** This is the only check that exercises the whole path — fetch, DynamoDB write, publish — end to end. Until #12 exists there is no consumer, so a cycle's messages sit in the queue:

```bash
aws sqs get-queue-attributes --queue-url "$(terraform output -raw queue_url)" \
  --attribute-names ApproximateNumberOfMessages
# expect 12 for the canonical fleet: one message per distinct weather location
```

Then confirm the DLQ is empty, which is the state the alarm in `alarms.tf` exists to keep true. Its URL is looked up by name rather than derived from the main queue's — a queue URL is server-assigned, and string-editing one into another is exactly the hand-assembly B3 warns against:

```bash
DLQ_URL="$(aws sqs get-queue-url --queue-name "cumulo-weather-readings-dlq-$ENV" --output text)"
aws sqs get-queue-attributes --queue-url "$DLQ_URL" --attribute-names ApproximateNumberOfMessages
# expect 0
```

**Drain the queue before leaving it**, or the first thing #12's consumer sees is a backlog of stale hand-invoked cycles: `aws sqs purge-queue --queue-url "$(terraform output -raw queue_url)"`.

**B7. Confirm no drift.**

```bash
terraform plan -detailed-exitcode
echo $?   # expect 0
```

A `2` here immediately after an apply usually means the artefact was rebuilt in between — `source_code_hash` changed, so Terraform correctly wants to deploy it. Away from an apply, the ordinary cause is the deploy workflow below, and that `2` is expected rather than drift; the next section says why.

### The deploy path: what CI ships and what Terraform owns

`.github/workflows/deploy-ingestion.yml` updates the function's **code** on every push to `main` that touches `apps/ingestion/**`, `packages/shared/**`, `packages/storage/**`, or the lockfile. It does nothing else, and it cannot: `deploy.tf` grants `cumulo-github-actions` exactly `lambda:UpdateFunctionCode` and `lambda:GetFunction` on this one function ARN. There is no `UpdateFunctionConfiguration` in that grant, so timeout, memory, environment variables, execution role, schedule, queue and alarms remain things only a reviewed `.tf` change can move.

Authentication is OIDC and there is no AWS secret in the repository, per the rule at the top of this document. The role is assumed with a session named `deploy-ingestion-<run-id>`, so CloudTrail traces an `UpdateFunctionCode` back to the run — and therefore the commit — that made it.

**The drift this creates is real, expected, and bounded.** Terraform's `source_code_hash` records the artefact of the last _apply_. After CI deploys, the live code no longer matches it, and `terraform plan` reports a pending change to `aws_lambda_function.ingestion`. That is Terraform being right about a fact it was not told, not a fault:

- **Applying it is safe.** It re-uploads the artefact built from your working tree. Build first (Phase A1) or you will ship a stale bundle — the precondition stops an absent one, not an old one.
- **Not applying it is also safe.** The function keeps running CI's code. Nothing else in the plan is affected, because no other attribute depends on the artefact.
- **What is _not_ safe is treating a non-empty plan here as noise.** B7's `-detailed-exitcode` check is only meaningful if you know which change you are expecting to see, so read the plan rather than the exit code once CI has deployed at least once.

To check what is actually running, without an apply:

```bash
aws lambda get-function --function-name "$(terraform output -raw function_name)" \
  --query 'Configuration.{Sha:CodeSha256,Modified:LastModified}'
```

Compare `Sha` with the `Sha` the deploy run printed. They match, or CI did not ship what you think it did.

### Teardown

Teardown is a project requirement, so it is stated rather than assumed. This stack has no ordering trap at all: its state lives in a bucket another stack owns, nothing here is another stack's foundation, and — unlike the Kinesis stream ADR 0004 replaced — every resource in it is free whether it is destroyed or forgotten.

```bash
terraform destroy
```

Verify from AWS rather than from Terraform:

```bash
aws lambda list-functions --query "Functions[?starts_with(FunctionName, 'cumulo-ingestion')].FunctionName"
# expect: []
aws sqs list-queues --queue-name-prefix cumulo-weather-readings --query 'QueueUrls'
# expect: null
aws logs describe-log-groups --log-group-name-prefix /aws/lambda/cumulo-ingestion --query 'logGroups[].logGroupName'
# expect: []

aws iam list-role-policies --role-name cumulo-github-actions
# expect: no cumulo-ingestion-deploy-<env> entry — the role survives, its ingestion grant does not
```

That last one is the reason the deploy grant lives in this stack rather than in `bootstrap` (ADR 0001). A destroyed service must not leave a live deploy permission behind on a role that outlives it, and this command is the check that it did not.

The log-group one is the other one worth actually running. Lambda creates its own never-expiring log group on first invocation if Terraform has not declared one, and a group created that way is outside Terraform's ownership — so it survives `destroy` and bills for storage indefinitely. `lambda.tf` declares the group explicitly and the execution role has no `logs:CreateLogGroup`, which is what makes an empty list here a property of the design rather than luck.

Keep `backend.hcl` and `ingestion.auto.tfvars` — both are still correct for the next spin-up. To spin back up, run [Phase A](#phase-a--build-configure-and-plan) then [Phase B](#phase-b--apply-and-prove-the-cycle) back to back, starting from the build.

**Whether to leave it up** is a real choice, unlike storage's. The stack costs $0 idle either way, but a stack that is up is *running*: it fetches from Open-Meteo every hour, spending quota (~288 calls/day against the free 10,000) and filling the queue with messages nothing is consuming until #12 lands. Leaving it running is the right default while #12 is being built and the wrong one afterwards if the queue is not being drained. Disabling the rule (`aws events disable-rule --name "cumulo-ingestion-hourly-$ENV"`) stops the cycles without destroying anything — but it is drift, and the next `terraform apply` re-enables it, which is the correct behaviour and worth knowing before it surprises you.

---

## Runbook: the api stack

One Lambda, one API Gateway HTTP API with its `$default` stage and integration, four routes — the catch-all plus the three declared write routes that carry a tighter 2 rps / burst 4 throttle ([ADR 0006](../docs/adr/0006-demo-abuse-protection.md), #29) — one log group, one execution role, two alarms, one Lambda permission, and one deploy grant on the shared GitHub Actions role. That is [issue #14](https://github.com/TomBennett-Lloyd/cumulo/issues/14)'s infrastructure per [ADR 0005](../docs/adr/0005-fleet-api-hosting.md), plus #29's write throttles. Every command runs from `infra/api/`:

```bash
cd infra/api
```

**This is the first stack in the platform that is reachable from the public internet**, and the one property to hold onto while reading the rest: the write endpoint is unauthenticated by design (ADR 0001 — auth is #30), so the stage throttle is what turns "we hope nobody hammers the demo" into an arithmetic bound of ≈ $36/month. It is two lines in `gateway.tf`, and an apply that dropped them would remove the bound silently.

**Prerequisites**, in this order and for these reasons:

1. **The bootstrap stack applied** — this stack's state lives in the bucket bootstrap creates, and it attaches an inline policy to the role bootstrap owns, so `data.aws_iam_role.github_actions` fails at plan time if bootstrap has not run.
2. **The storage stack applied**, with the same `environment` and in the same region. Not a Terraform dependency: nothing here references storage's state or outputs, and a plan succeeds without it. It is a _runtime_ prerequisite — the IAM policy grants access to `cumulo-sites-<env>` and `cumulo-series-<env>` by name, and the function resolves those same names from `CUMULO_ENV`, so applying against absent tables produces a stack that plans, applies, and then 500s on its first request.
3. **An operator credential session** — see [Operator prerequisites](#operator-prerequisites).
4. **A built Lambda artefact**, exactly as the ingestion runbook requires one.

**There is no override dance here** (convention 6): the bucket already exists, so this stack inits straight against S3 in both directions.

### Phase A — build, configure, and plan the API

The same A/B split as every other runbook, and for the same reason: `.tf` files require human review before they are applied, and a plan is exactly the artefact a reviewer needs.

**A1. Build the artefact. This comes first, not last.**

```bash
pnpm --filter @cumulo/api build
ls -l ../../apps/api/dist/handler.zip
```

`apps/api/dist/handler.zip` is a fixed contract between that build script and `lambda.tf`. It carries the bundled handler **and** the pinned `swagger-ui-dist` assets that serve `/docs`, per ADR 0005's Swagger decision — one artefact, one lifecycle, so the rendered spec and the running API cannot disagree.

Skip this step and `terraform plan` stops with `No Lambda artefact at apps/api/dist/handler.zip` and the command to run. `terraform validate` deliberately does **not** need it, which is what lets CI validate this stack on every push while building nothing.

**A2. Create the two gitignored local files from their committed examples.**

```bash
cp api.auto.tfvars.example api.auto.tfvars
cp backend.hcl.example backend.hcl
```

Set `aws_region` in `api.auto.tfvars`, and both `region` and `bucket` in `backend.hcl`. Same region as bootstrap and storage — a DynamoDB table ARN is regional, so a mismatch silently grants access to tables in a region that has none. The bucket name is `cumulo-tfstate-` followed by the account id:

```bash
aws sts get-caller-identity --query Account --output text
```

`environment` needs no entry; it defaults to `dev`. If you set it, set the same value in `storage.auto.tfvars` — it is in the function, API, role, log group and granted table names, and in `CUMULO_ENV`.

**A3. Confirm none of that is visible to git.**

```bash
git status --short   # expect no output for infra/api/
```

`dist/` is gitignored too, so the artefact from A1 does not appear either.

**A4. Initialise against the real backend.**

```bash
terraform init -backend-config=backend.hcl
```

**A5. Plan.** The tee target is outside the repo on purpose, so a plan output file cannot be committed:

```bash
terraform plan -no-color | tee ~/cumulo-api-plan.txt
```

Expect **`Plan: 15 to add, 0 to change, 0 to destroy.`** — the function, its log group, the HTTP API, the integration, the `$default` route, the **three declared write routes** (`aws_apigatewayv2_route.write` is a `for_each` over three route keys, so it counts as three), the `$default` stage, the Lambda permission, the execution role, its inline policy, the two alarms, and the deploy grant on `cumulo-github-actions`. Any other count means the configuration is not what this document describes; stop and find out why. The five data sources — `aws_caller_identity`, the existing `cumulo-github-actions` role, and three IAM policy documents (Lambda trust, execution, deploy) — are read rather than created and add nothing to the count.

**Read both throttles in the plan before approving it.** `default_route_settings` should show `throttling_rate_limit = 10` and `throttling_burst_limit = 20` — the bound in ADR 0005's cost table. The three `route_settings` blocks should show `2` and `4` on the write route keys, which is ADR 0006's layer 2. A plan that does not show them is a plan that costs something else.

**A6. Stop here on the PR.** `.tf` files require human review before they are applied (CLAUDE.md merge policy). Summarise the plan in the PR body — resource counts, the throttle numbers, the function name — and label it `awaiting-review`.

### Phase B — apply and prove the endpoint

**B1. Apply.**

```bash
terraform apply
```

**B2. Confirm what exists.**

```bash
terraform state list   # expect 20 lines — the 15 resources plus the 5 data sources
```

The deploy grant is the one resource in this stack that lives on something another stack owns, so confirm it landed where it was meant to rather than trusting the count — and confirm ingestion's is still there beside it:

```bash
aws iam list-role-policies --role-name cumulo-github-actions
# expect: cumulo-api-deploy-<env> and cumulo-ingestion-deploy-<env>
```

**B3. Capture the endpoint.** It comes from `terraform output`, never hand-assembled and never retyped: the api id is **server-assigned**, so a URL guessed from a template points at nothing.

```bash
API_ENDPOINT="$(terraform output -raw api_endpoint)"
echo "$API_ENDPOINT"   # https://<api-id>.execute-api.<region>.amazonaws.com
```

Unlike the ingestion stack's queue URL this value embeds no account id, so it is safe to quote in a PR body or an issue comment.

**B4. Confirm the throttle is really on the stage** — read it back from AWS rather than from Terraform's opinion of AWS, because this is the setting the cost argument rests on:

```bash
API_ID="$(aws apigatewayv2 get-apis --query "Items[?Name=='cumulo-api-$(terraform output -raw environment)'].ApiId" --output text)"
aws apigatewayv2 get-stage --api-id "$API_ID" --stage-name '$default' \
  --query 'DefaultRouteSettings.{Rate:ThrottlingRateLimit,Burst:ThrottlingBurstLimit}'
# expect: Rate 10.0, Burst 20
```

**B5. Smoke the deployed API.** The endpoint, the docs and the try-it-out flow are [issue #14](https://github.com/TomBennett-Lloyd/cumulo/issues/14)'s acceptance criteria, and the full runbook for them — including the 429 spot-check — lives with the service in `apps/api/README.md`. The three-command version:

```bash
curl -fsS "$API_ENDPOINT/openapi.json" | head -c 200
curl -fsS "$API_ENDPOINT/v1/sites"
open "$API_ENDPOINT/docs"
```

**Empty arrays are the expected answer, not a failure.** Until #12's forecast service is deployed and writing rows, `GET /v1/sites/{siteId}/forecast` returns `200` with `forecasts: []` — deliberate behaviour (a just-created site legitimately has no points yet), and what #17's poll keys on.

**B6. Confirm no drift.**

```bash
terraform plan -detailed-exitcode
echo $?   # expect 0
```

A `2` here has the same two causes as in the ingestion runbook: an artefact rebuilt since the apply, or a CI deploy. See the next section.

### The deploy path: what CI ships for the API

The heading differs from the ingestion runbook's only so the two sections have distinct anchors, the same reason the phases above differ from that runbook's.

`.github/workflows/deploy-api.yml` updates the function's **code** on every push to `main` that touches `apps/api/**`, `packages/shared/**`, `packages/storage/**`, or the lockfile. It does nothing else, and it cannot: `deploy.tf` grants `cumulo-github-actions` exactly `lambda:UpdateFunctionCode` and `lambda:GetFunction` on this one function ARN.

There is no `UpdateFunctionConfiguration` in that grant, so timeout, memory and environment stay reviewable `.tf` changes — and, more to the point on this stack, **there is no `apigatewayv2` permission of any kind**, so no workflow can move the throttle, the CORS configuration, or the routes. The cost guard is reachable only through a reviewed diff in this directory.

Authentication is OIDC and there is no AWS secret in the repository. The role is assumed with a session named `deploy-api-<run-id>`, so CloudTrail traces an `UpdateFunctionCode` back to the run — and therefore the commit — that made it. The `source_code_hash` drift this creates is real, expected and bounded, exactly as described in the [ingestion deploy-path section](#the-deploy-path-what-ci-ships-and-what-terraform-owns) above.

### Teardown of the api stack

No ordering trap: this stack's state lives in a bucket another stack owns, nothing here is another stack's foundation, and every resource in it is free whether it is destroyed or forgotten.

```bash
terraform destroy
```

Verify from AWS rather than from Terraform:

```bash
aws lambda list-functions --query "Functions[?starts_with(FunctionName, 'cumulo-api')].FunctionName"
# expect: []
aws apigatewayv2 get-apis --query "Items[?starts_with(Name, 'cumulo-api')].Name"
# expect: []
aws logs describe-log-groups --log-group-name-prefix /aws/lambda/cumulo-api --query 'logGroups[].logGroupName'
# expect: []

aws iam list-role-policies --role-name cumulo-github-actions
# expect: no cumulo-api-deploy-<env> entry — the role survives, its api grant does not
```

The last two are the ones worth actually running, for the same reasons the ingestion runbook gives: a log group Lambda created for itself outlives `destroy` and bills forever, and a destroyed service must not leave a live deploy permission behind on a role that outlives it.

Keep `backend.hcl` and `api.auto.tfvars` — both are still correct for the next spin-up. To spin back up, run [Phase A](#phase-a--build-configure-and-plan-the-api) then [Phase B](#phase-b--apply-and-prove-the-endpoint) back to back, starting from the build.

**Whether to leave it up.** Unlike ingestion, this stack does nothing while nobody is looking — it is request-driven, so an idle API is genuinely inert as well as free. The reason to think about it anyway is the opposite one: it is public. Leaving it up means leaving an unauthenticated write endpoint on the internet. What bounds it is the layered posture [ADR 0006](../docs/adr/0006-demo-abuse-protection.md) records — an `Origin` check and a per-IP limiter with an auto-block inside the function, the 2 rps write throttle and the 10 rps stage throttle at the gateway, and a hard cap of 40 user sites with oldest-first eviction in the data model. That is an accepted risk for a portfolio demo and a deliberate one; it is not an oversight.

---

## Runbook: the forecast stack

One Lambda, one event source mapping onto ingestion's queue, one log group, one execution role, one alarm, and one deploy grant on the shared GitHub Actions role — the whole of [issue #136](https://github.com/TomBennett-Lloyd/cumulo/issues/136)'s infrastructure, per [ADR 0003](../docs/adr/0003-pv-model-runtime.md) and [ADR 0004](../docs/adr/0004-ingestion-transport.md). Note that ADR 0004 and the ingestion runbook above both call this consumer "#12" — that was the physics-forecast ticket, and the deployable that wraps it is #136. Every command runs from `infra/forecast/`:

```bash
cd infra/forecast
```

**This is the stack with a real apply-order prerequisite**, and it is the one thing to hold onto while reading the rest. Every other stack in the platform names another stack's resources only inside IAM policies, where a wrong name is a runtime failure. This one creates an `aws_lambda_event_source_mapping` against `cumulo-weather-readings-<env>`, and Lambda validates that the queue exists when the mapping is created — so applying before ingestion fails the apply, half way through, with a stack that has a function and no trigger.

**Prerequisites**, in this order and for these reasons:

1. **The bootstrap stack applied** — this stack's state lives in the bucket bootstrap creates, and it attaches an inline policy to the role bootstrap owns, so `data.aws_iam_role.github_actions` fails at plan time if bootstrap has not run.
2. **The ingestion stack applied**, with the same `environment` and in the same region. Unlike every other cross-stack relationship in this document, this one is an **apply-time** prerequisite, for the reason above. It is still not a Terraform dependency — nothing here reads ingestion's state or outputs, and `terraform plan` succeeds without it, because a plan does not call Lambda. The failure is at apply.
3. **The storage stack applied**, with the same `environment` and in the same region. This one _is_ only a runtime prerequisite, exactly like the other stacks': the IAM policy grants access to `cumulo-sites-<env>`'s `by-location` index and `cumulo-series-<env>` by name, and the function resolves those names from `CUMULO_ENV`, so applying against absent tables produces a stack that plans, applies, and then fails on its first message.
4. **An operator credential session** — see [Operator prerequisites](#operator-prerequisites).
5. **A built Lambda artefact**, exactly as the ingestion and api runbooks require one.

**There is no override dance here** (convention 6): the bucket already exists, so this stack inits straight against S3 in both directions.

### Phase A — build, configure, and plan the forecast

The same A/B split as every other runbook, and for the same reason: `.tf` files require human review before they are applied, and a plan is exactly the artefact a reviewer needs.

**A1. Build the artefact. This comes first, not last.**

```bash
pnpm --filter @cumulo/forecast-service build
ls -l ../../apps/forecast/dist/handler.zip
```

`apps/forecast/dist/handler.zip` is a fixed contract between that build script and `lambda.tf`, not something Terraform discovers or produces. Terraform reads the file to compute `source_code_hash`, which is what makes a rebuilt artefact actually deploy instead of comparing equal on filename alone.

Skip this step and `terraform plan` stops with `No Lambda artefact at apps/forecast/dist/handler.zip` and the command to run — a resource precondition, chosen over letting the apply fail later with the provider's `no such file or directory`. Note the asymmetry that makes CI work: `terraform validate` deliberately does **not** need the artefact, because whether the configuration is well-formed is not a question about whether somebody ran a build. CI validates all six stacks on every push and builds nothing.

**A2. Create the two gitignored local files from their committed examples.**

```bash
cp forecast.auto.tfvars.example forecast.auto.tfvars
cp backend.hcl.example backend.hcl
```

Set `aws_region` in `forecast.auto.tfvars`, and both `region` and `bucket` in `backend.hcl`. Same region as bootstrap, storage and ingestion — the backend and the provider have to agree on where the bucket lives, and a DynamoDB table ARN and an SQS queue ARN are both regional, so a mismatch here points the grants at a region with no tables and the event source mapping at a queue that does not exist. The bucket name is `cumulo-tfstate-` followed by the account id:

```bash
aws sts get-caller-identity --query Account --output text
```

`environment` needs no entry; it defaults to `dev`. If you set it, set the same value in `storage.auto.tfvars` and `ingestion.auto.tfvars` — it is in the function, log group, granted table and consumed queue names.

**A3. Confirm none of that is visible to git.**

```bash
git status --short   # expect no output for infra/forecast/
```

`dist/` is gitignored too, so the artefact from A1 does not appear either.

**A4. Initialise against the real backend.**

```bash
terraform init -backend-config=backend.hcl
```

**A5. Plan.** The tee target is outside the repo on purpose, so a plan output file cannot be committed:

```bash
terraform plan -no-color | tee ~/cumulo-forecast-plan.txt
```

Expect **`Plan: 7 to add, 0 to change, 0 to destroy.`** — the function, the log group, the event source mapping, the execution role, its inline policy, the alarm, and the deploy grant on `cumulo-github-actions`. Any other count means the configuration is not what this document describes; stop and find out why. The five data sources — `aws_caller_identity`, the existing `cumulo-github-actions` role, and three IAM policy documents (Lambda trust, execution, deploy) — are read rather than created and add nothing to the count.

Three values in that plan are worth reading rather than skimming, because all three are decisions the review is for: `timeout = 50` on the function (half of the 6× coupling with ingestion's `visibility_timeout_seconds = 300`), and `batch_size = 1` and `maximum_concurrency = 2` on the mapping (the write-side bound that keeps a burst of location messages from hitting `cumulo-series`' 14 WCU all at once).

**A6. Stop here on the PR.** `.tf` files require human review before they are applied (CLAUDE.md merge policy). Summarise the plan in the PR body — resource counts, the timeout and concurrency numbers, the queue-name shape. Per convention 7, quote shapes rather than digits.

### Phase B — apply and prove a message is consumed

**B1. Apply.**

```bash
terraform apply
```

If this fails on the event source mapping with an error naming the queue, the ingestion stack is not applied in this region and environment. That is prerequisite 2, and the fix is to apply ingestion and re-run — nothing needs unwinding, because Terraform records what it did create.

**B2. Confirm what exists.**

```bash
terraform state list   # expect 12 lines — the 7 resources plus the 5 data sources
```

The deploy grant is the one resource in this stack that lives on something another stack owns, so confirm it landed where it was meant to rather than trusting the count:

```bash
aws iam list-role-policies --role-name cumulo-github-actions
# expect: cumulo-forecast-deploy-<env>, alongside the ingestion and api entries
```

**B3. Prove the trigger is armed**, which is this stack's equivalent of the ingestion runbook's schedule check — and the check most worth running, because a mapping that exists but is `Disabled` looks exactly like a working stack from `terraform state list`:

```bash
ENV="$(terraform output -raw environment)"
FN="$(terraform output -raw function_name)"
aws lambda list-event-source-mappings --function-name "$FN" \
  --query 'EventSourceMappings[].{State:State,Batch:BatchSize,Concurrency:ScalingConfig.MaximumConcurrency,Failures:FunctionResponseTypes}'
# expect: State Enabled, Batch 1, Concurrency 2, Failures ["ReportBatchItemFailures"]
```

A `State` of `Disabled` with the mapping otherwise correct is almost always the execution role: Lambda disables a mapping it cannot poll with, and the three SQS actions in `iam.tf` are what it polls with.

**B4. Prove the 6× floor still holds.** This is not drift-checking, it is checking the one invariant that spans two stacks and that no gate enforces:

```bash
aws lambda get-function-configuration --function-name "$FN" --query 'Timeout'
# expect: 50
aws sqs get-queue-attributes \
  --queue-url "$(aws sqs get-queue-url --queue-name "cumulo-weather-readings-$ENV" --output text)" \
  --attribute-names VisibilityTimeout --query 'Attributes.VisibilityTimeout'
# expect: "300" — at least 6x the number above (ADR 0004)
```

**B5. Prove a message is actually consumed, end to end.** Ingestion is the producer, so trigger a cycle rather than synthesising a message — a hand-written payload proves the handler parses what you wrote, not what ingestion sends:

```bash
aws lambda invoke --function-name "cumulo-ingestion-$ENV" \
  --payload '{}' --cli-binary-format raw-in-base64-out /dev/stdout
```

Then watch this function's log, and confirm the queue drains rather than accumulating:

```bash
aws logs tail "/aws/lambda/$FN" --since 5m --follow
aws sqs get-queue-attributes \
  --queue-url "$(aws sqs get-queue-url --queue-name "cumulo-weather-readings-$ENV" --output text)" \
  --attribute-names ApproximateNumberOfMessages
# expect 0 within a minute or so — 12 messages at concurrency 2 is a short stream, not an instant drain
```

A count that stays at 12 means the mapping is not polling (go back to B3). A count that drops while the DLQ fills means the handler is failing per message — check the DLQ, whose alarm lives in the ingestion stack:

```bash
DLQ_URL="$(aws sqs get-queue-url --queue-name "cumulo-weather-readings-dlq-$ENV" --output text)"
aws sqs get-queue-attributes --queue-url "$DLQ_URL" --attribute-names ApproximateNumberOfMessages
# expect 0
```

**B6. Confirm no drift.**

```bash
terraform plan -detailed-exitcode
echo $?   # expect 0
```

A `2` here immediately after an apply usually means the artefact was rebuilt in between — `source_code_hash` changed, so Terraform correctly wants to deploy it. Away from an apply, the ordinary cause is the deploy workflow below, and that `2` is expected rather than drift, for the reasons the [ingestion deploy-path section](#the-deploy-path-what-ci-ships-and-what-terraform-owns) sets out in full.

### The deploy path: what CI ships for the forecast

`.github/workflows/deploy-forecast.yml` updates the function's **code** on every push to `main` that touches its sources. It does nothing else, and it cannot: `deploy.tf` grants `cumulo-github-actions` exactly `lambda:UpdateFunctionCode` and `lambda:GetFunction` on this one function ARN.

There is no `UpdateFunctionConfiguration` in that grant, which matters more here than on the other stacks: this function's `timeout` is one half of a cross-stack invariant, and a workflow that could move it could break ADR 0004's floor without a diff. There is no `UpdateEventSourceMapping` either, so the batch size and the concurrency cap are equally out of CI's reach. Code is the one field CI owns.

Authentication is OIDC and there is no AWS secret in the repository. The `source_code_hash` drift a deploy creates is real, expected and bounded, exactly as described in the ingestion deploy-path section.

### Teardown of the forecast stack

No ordering trap within the platform, but one ordering fact: destroy this stack **before** ingestion if you are tearing both down, or the mapping's queue disappears underneath it. Terraform handles it either way — a mapping whose event source is gone still deletes — but the clean order is consumer first.

```bash
terraform destroy
```

Verify from AWS rather than from Terraform:

```bash
aws lambda list-functions --query "Functions[?starts_with(FunctionName, 'cumulo-forecast')].FunctionName"
# expect: []
aws logs describe-log-groups --log-group-name-prefix /aws/lambda/cumulo-forecast --query 'logGroups[].logGroupName'
# expect: []

aws iam list-role-policies --role-name cumulo-github-actions
# expect: no cumulo-forecast-deploy-<env> entry — the role survives, its forecast grant does not
```

The last two are the ones worth actually running, for the same reasons the ingestion runbook gives: a log group Lambda created for itself outlives `destroy` and bills forever, and a destroyed service must not leave a live deploy permission behind on a role that outlives it.

Keep `backend.hcl` and `forecast.auto.tfvars` — both are still correct for the next spin-up. To spin back up, run [Phase A](#phase-a--build-configure-and-plan-the-forecast) then [Phase B](#phase-b--apply-and-prove-a-message-is-consumed) back to back, starting from the build.

**Whether to leave it up.** This one is the counterpart to ingestion's, and the two answers are linked: ingestion running without forecast grows an unconsumed queue, so if ingestion is up, this stack should be too. Left up alone it is free and nearly inert — it polls an empty queue, which costs polling requests inside the free million and nothing else. The combination to avoid is not "both up", it is "ingestion up, forecast down".

---

## Cost

`eu-west-1`, and the amounts are not rounded down for effect — the stacks really are this cheap, which is the reason a remote backend is affordable at all under the ~$100/month ceiling.

### Bootstrap stack

| Resource group                                                                       | Billing basis                                                                                                                                     | Estimate                       |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| **State bucket — storage** (`aws_s3_bucket.tfstate`)                                 | S3 Standard, ~$0.023/GB-month                                                                                                                     | < $0.01/mo (state is KB-scale) |
| **State bucket — requests** (state reads/writes plus native lockfile PUT/GET/DELETE) | ~$0.005/1,000 PUT, ~$0.0004/1,000 GET                                                                                                             | < $0.01/mo (hundreds of ops)   |
| **Bucket configuration** (versioning, SSE-S3, public access block, lifecycle rule)   | No charge for the configuration; versions bill as storage above                                                                                   | $0.00/mo                       |
| **IAM** (`aws_iam_openid_connect_provider.github`, `aws_iam_role.github_actions`)    | IAM roles and OIDC providers are free                                                                                                             | $0.00/mo                       |
| **Cost-ceiling budget** (`aws_budgets_budget.monthly_cost_ceiling`)                  | Notification-only budgets are free of charge; only _action-enabled_ budgets bill (first two free, then $0.10/day), and this budget has no actions | $0.00/mo                       |
| **Notification parameter** (`/cumulo/notification-email`, read via data source)      | SSM Parameter Store standard tier, encrypted with the default KMS key — no charge for the parameter and none for the key                          | $0.00/mo                       |
| **Total**                                                                            |                                                                                                                                                   | **≈ $0.01/mo — rounds to $0**  |

Notes on why nothing here grows:

- **Versioning is bounded.** The lifecycle rule expires noncurrent versions after 90 days, so state history cannot accumulate indefinitely. Without it, versioning is a slow storage leak.
- **SSE-S3, not SSE-KMS.** State is encrypted at rest either way; a customer-managed KMS key would add a monthly key charge plus per-request charges to the one stack whose entire purpose includes being tearable down to $0.
- **The native lockfile has no standing charge.** A DynamoDB lock table would sit in the account billing for existence even while idle; the lockfile is an object that exists only during an operation.
- **No NAT gateway, no load balancer, no VPC endpoint** — this stack creates nothing with an hourly rate. That is the property to preserve when adding to it: per-request costs at this volume are noise, and hourly ones are the whole budget.

### Alerting stack

Sized against the thing it is built to carry: **nine alarms that should each fire zero times.**

| Resource group                                                                  | Billing basis                                                                                                            | Estimate     |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------ |
| **Topic** (`aws_sns_topic.alerts`)                                              | SNS bills requests and deliveries, **not existence** — there is no per-topic or per-hour charge                          | **$0.00/mo** |
| **Publishes** (one per alarm state change)                                      | First **1,000,000 requests/month** free, then $0.50/M                                                                    | **$0.00/mo** |
| **Email deliveries** (`aws_sns_topic_subscription.notification_email`)          | First **1,000 notifications/month** free, then $2.00 per 100,000                                                         | **$0.00/mo** |
| **Notification parameter** (`/cumulo/notification-email`, read via data source) | SSM Parameter Store standard tier, encrypted with the default KMS key — no charge for the parameter and none for the key | **$0.00/mo** |
| **Total**                                                                       |                                                                                                                          | **$0.00/mo** |

The alarms themselves are **not** costed here. They belong to the stacks that create them, and the allowance they draw on is platform-wide — see [CloudWatch alarm budget](#cloudwatch-alarm-budget) below.

Notes on what would change that:

- **Encryption is the line item deliberately absent.** Server-side encryption with a customer-managed KMS key would add ~$1/month plus request charges — and, before that, it would break delivery: the AWS-managed `alias/aws/sns` key does not grant CloudWatch permission to publish, so an encrypted topic accepts alarm actions and silently drops them. `topic.tf` says so at the point of temptation. The content being protected is an alarm name and a state reason, both already public in this repository.
- **The free delivery tier is 1,000 emails/month, and reaching it is the alarm.** Nine alarms firing and recovering would have to average more than sixteen state changes each per day to cross it. That is not a bill, it is a platform on fire.
- **Nothing here has an hourly rate**, the property every stack in this repo preserves.

### Storage stack

The figures and the workload they are computed from are [ADR 0002](../docs/adr/0002-storage-split.md)'s; they are restated here because a cost table that lives only inside a decision record is not somewhere an operator looks. Sized against ~50 sites over ~30 locations, hourly, a 48-hour horizon, two models, 90-day retention: ~4.6 M write units/month and ~3.5 GB retained.

| Resource group                                                       | Billing basis                                                                                                             | Estimate     |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------ |
| **Provisioned capacity** (`series` 14 WCU / 21 RCU, `weather` 5 / 3) | 19 WCU / 24 RCU against the always-free **25 WCU / 25 RCU per Region**, which does not expire after twelve months         | **$0.00/mo** |
| **On-demand tables** (`sites` + both GSIs, `metrics`)                | $0.625/M write request units, $0.125/M read request units — thousands of requests/month, and $0 while idle                | **$0.00/mo** |
| **Storage** (all four tables)                                        | ~3.5 GB inside the always-free **25 GB**                                                                                  | **$0.00/mo** |
| **Throttle alarms** (4 × `aws_cloudwatch_metric_alarm`)              | 4 of the platform's 9, inside the always-free **10 CloudWatch alarms**; DynamoDB's own metrics are free                   | **$0.00/mo** |
| **Backups / recovery**                                               | PITR off ($0.20/GB-month avoided), no on-demand backups, no exports, AWS-owned encryption key rather than a ~$1/month CMK | **$0.00/mo** |
| **Total**                                                            |                                                                                                                           | **$0.00/mo** |

Genuinely zero, not a rounding error — and unlike the bootstrap stack, this one has no sub-cent line at all.

Notes on what would change that:

- **The free capacity allowance is a hard edge, not a discount.** Crossing 25 WCU or 25 RCU in the Region bills the excess at $0.00065/WCU-hour and $0.00013/RCU-hour. This is why `tables.tf` has no auto-scaling and says so at length: an `aws_appautoscaling_target` is the one change that crosses that edge without appearing in anyone's plan review.
- **The pool is Region-wide and shared.** 19/24 of 25/25 leaves 6 WCU / 1 RCU. That slack is not a growth reserve — the standing rule (a new table defaults to on-demand unless its load is batch-shaped) is what stops it being needed.
- **The honest inversion.** At list price this same allocation would cost ≈ $11.30/month against all-on-demand's ≈ $2.88, because a 7% duty cycle is exactly what on-demand pricing exists to serve. Provisioned wins here only because the tier is free, and ADR 0002 says so rather than pretending it is the better engineering answer.
- **Nothing here has an hourly rate**, which is the property to preserve. Per-request DynamoDB costs at this volume are noise; a VPC, a NAT gateway, or a database instance would be the whole budget — the comparison ADR 0002 turned on.

### Ingestion stack

The figures are [ADR 0004](../docs/adr/0004-ingestion-transport.md)'s, restated here because a cost table that lives only inside a decision record is not somewhere an operator looks. Sized against the canonical fleet: 12 distinct weather locations, one cycle an hour — **~720 invocations/month** and **12 messages per cycle**.

| Resource group                                                   | Billing basis                                                                                                                                                        | Estimate     |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| **Lambda invocations** (`aws_lambda_function.ingestion`)         | ~720/month against the always-free **1,000,000 requests/month**                                                                                                      | **$0.00/mo** |
| **Lambda compute**                                               | 256 MB × even a full 300 s cycle is ~54,000 GB-seconds/month, ~13% of the always-free **400,000 GB-seconds**; a real cycle is a fraction of it                       | **$0.00/mo** |
| **Schedule** (`aws_cloudwatch_event_rule` + target + permission) | EventBridge scheduled rules and their invocations are **not charged** — $0 by pricing, not by allowance                                                              | **$0.00/mo** |
| **SQS** (queue + DLQ)                                            | ~8,760 sends + ~8,760 deletes + the consumer mapping's ~657,000 long-polling receives ≈ **~675,000 requests/month** against the always-free **1,000,000**, no expiry | **$0.00/mo** |
| **CloudWatch logs** (30-day retention on one group)              | ~13 JSON lines/hour — kilobytes/month against the free **5 GB** of ingestion and **5 GB** of storage                                                                 | **$0.00/mo** |
| **Alarms** (3 × `aws_cloudwatch_metric_alarm`)                   | 3 joining storage's 4, inside the always-free **10 CloudWatch alarms**; Lambda and SQS metrics are free                                                              | **$0.00/mo** |
| **Total**                                                        |                                                                                                                                                                      | **$0.00/mo** |

**No resource in this stack bills for existing**, which is the whole of ADR 0004: the Kinesis stream three earlier documents assumed would have cost ≈ $29.20/month on-demand or ≈ $10.95 provisioned — 29% and 11% of the entire ~$100/month ceiling — to move ~175 MB at 0.02% utilisation. With this stack applied, the platform's total standing cost is $0 and `terraform destroy` takes it to $0 in a different sense: nothing left at all.

Notes on what would change that:

- **The SQS request allowance is the number to watch, not the send count.** Sends are ~8,760/month and immaterial; the ~657,000 polling receives are two-thirds of the free million, and they belong to #12's event source mapping rather than to anything in this stack. A **second** ESM-driven queue crosses the million (ADR 0004 revisit trigger 5). The cost of crossing is cents — $0.40/million beyond the free tier, so even doubling the polling floor is ~$0.27/month — but "$0" would stop being literally true.
- **The Lambda timeout is a cost ceiling as well as a correctness one.** 300 s at 256 MB is the worst case the free GB-second allowance is measured against; raising either without raising the other is fine, raising both is the change to think about.
- **A forgotten stack is free but not inert.** Unlike every other resource in the platform, this one _does things_ while nobody is looking: an enabled schedule spends ~288 Open-Meteo calls/day against the 10,000/day free tier and grows an unconsumed queue. That is a quota and hygiene concern, not a billing one — see the teardown section above.
- **Nothing here has an hourly rate**, the same property the other two stacks preserve. The one change that would break it is a VPC configuration on the function: a Lambda in a VPC needing outbound internet access needs a NAT Gateway at ~$32/month, which is a third of the ceiling for a function that only talks to public AWS endpoints and Open-Meteo.

### API stack

The figures are [ADR 0005](../docs/adr/0005-fleet-api-hosting.md)'s, restated here because a cost table that lives only inside a decision record is not somewhere an operator looks. **This is the first stack whose volume is not a property of a schedule**, so it is costed twice: at the expected regime (a portfolio demo — order 10,000 requests/month including Swagger UI's assets) and at the bound (the stage throttle pegged continuously for a 30-day month, 25.92M requests).

| Resource group                                                             | Billing basis                                                                                                                                          | Idle / demo  |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------ |
| **HTTP API requests** (`aws_apigatewayv2_api` + stage, route, integration) | $1.00 per million for the first 300M/month. **No per-hour charge, no minimum, no per-stage fee** — this is the line an ALB would have made ≈ $16.43/mo | **$0.00/mo** |
| **Lambda invocations** (`aws_lambda_function.api`)                         | ~10,000/month against the always-free **1,000,000 requests/month**                                                                                     | **$0.00/mo** |
| **Lambda compute**                                                         | 256 MB × ~100 ms is 0.025 GB-s/request, so the always-free **400,000 GB-seconds** covers 16M requests/month                                            | **$0.00/mo** |
| **CloudWatch logs** (30-day retention on one group)                        | Kilobytes/month at demo volume against the free **5 GB** of ingestion                                                                                  | **$0.00/mo** |
| **Alarms** (2 × `aws_cloudwatch_metric_alarm`)                             | 2 joining storage's 4 and ingestion's 3 — **9 of the always-free 10**; API Gateway and Lambda metrics are free                                         | **$0.00/mo** |
| **IAM** (execution role, inline policies, Lambda permission)               | Roles and policies are free                                                                                                                            | **$0.00/mo** |
| **Standing total**                                                         |                                                                                                                                                        | **$0.00/mo** |

**Standing cost is $0** — no resource in this stack bills for existing, which is the property ADR 0004 established and ADR 0005 was written to protect. An API somebody forgets to destroy costs nothing, exactly like the queue.

The marginal cost is where this stack differs from every other one, and it is the number to know:

| Line               | Rate                                                                     | Per 1M requests |
| ------------------ | ------------------------------------------------------------------------ | --------------- |
| HTTP API requests  | $1.00/M (first 300M/month)                                               | $1.00           |
| Lambda requests    | $0.20/M beyond the always-free million                                   | $0.20           |
| Lambda compute     | $0.0000166667/GB-s — free up to ~16M requests/month at 256 MB and 100 ms | $0.00           |
| **Marginal total** |                                                                          | **$1.20**       |

At the demo regime that is about **one cent a month**. At the bound — 10 requests/second held continuously for 30 days — it is **≈ $36/month**: $25.92 of gateway requests, $5.18 of Lambda requests, $4.13 of compute past the free allowance, and ~$0.75 of log ingestion past the free 5 GB. Roughly a third of the ~$100/month ceiling, sustained, under continuous abuse.

Notes on what would change that:

- **The throttle is the bound.** Delete `default_route_settings` from `infra/api/gateway.tf` and the worst case stops being finite; nothing else in the platform would notice until the bootstrap stack's budget alarm fired at 50% of $100. Those two numbers belong in review whenever this stack changes.
- **The 12-month API Gateway free tier is deliberately not counted.** New accounts get 1M HTTP API calls/month for twelve months. Every figure above is quoted at list price with it assumed absent, because a cost claim that rests on an expiring allowance expires with it. The always-free Lambda and CloudWatch allowances _are_ counted; they do not expire.
- **Swagger UI is the request-hungry page.** A `/docs` view is roughly four or five billed gateway requests plus as many invocations (HTML, CSS, the bundle, `/openapi.json`), which is where the per-request premium lands hardest. It is cents at demo volume; if it ever became a material share of traffic, ADR 0005 revisit trigger 4 says to put the assets on a CDN.
- **Crossing ~16M requests/month is the revisit point for compute**, not for requests: that is where Lambda's 400,000 free GB-seconds runs out at 256 MB, and the marginal cost per million starts rising with function duration instead of staying flat.
- **The alarm allowance is now the tight one.** Nine of ten used, and it is a platform-wide allowance rather than this stack's — see [CloudWatch alarm budget](#cloudwatch-alarm-budget) below, which owns the count.
- **Nothing here has an hourly rate**, the property all six stacks preserve.

### Forecast stack

Sized against the same canonical fleet the ingestion figures use, from the other end of the queue: **12 messages an hour**, one invocation each — **~8,760 invocations/month**, each turning one location's 48-hour horizon into on the order of 240 `cumulo-series` items.

| Resource group                                               | Billing basis                                                                                                                                                      | Estimate     |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------ |
| **Lambda invocations** (`aws_lambda_function.forecast`)      | ~8,760/month against the always-free **1,000,000 requests/month**                                                                                                  | **$0.00/mo** |
| **Lambda compute**                                           | 256 MB × even the full 50 s timeout is 12.8 GB-s/invocation — ~112,000 GB-seconds/month at the absolute worst case, ~28% of the always-free **400,000 GB-seconds** | **$0.00/mo** |
| **Event source mapping** (`aws_lambda_event_source_mapping`) | The resource is free; its ~657,000 polling receives/month are the ones already counted in the ingestion stack's SQS line, not a second charge                      | **$0.00/mo** |
| **DynamoDB writes** (`cumulo-series` via BatchWriteItem)     | ~2,880 items/hour against the storage stack's provisioned **14 WCU**, which is inside the always-free 25 — this stack adds load, not a line                        | **$0.00/mo** |
| **CloudWatch logs** (30-day retention on one group)          | ~12 JSON lines/hour — kilobytes/month against the free **5 GB** of ingestion                                                                                       | **$0.00/mo** |
| **Alarms** (1 × `aws_cloudwatch_metric_alarm`)               | 1 joining storage's 4, ingestion's 2 and the api's 2 — **9 of the always-free 10**; Lambda metrics are free                                                        | **$0.00/mo** |
| **Total**                                                    |                                                                                                                                                                    | **$0.00/mo** |

**No resource in this stack bills for existing**, and the reason is worth stating precisely: the stack's only genuinely new consumption is Lambda compute, and its largest term — the SQS polling — was budgeted by ADR 0004 before this stack existed. Applying it does not move the platform's total standing cost off $0.

Notes on what would change that:

- **This is the stack that consumes the free GB-second allowance fastest.** ~28% at the worst case, against ingestion's ~13%, because invocation count is driven by fleet locations rather than by a clock. Doubling the fleet's distinct locations doubles this line; the timeout is the multiplier, so the 6× coupling with the queue's visibility timeout is a cost decision as well as a correctness one.
- **`maximum_concurrency` is a throttle guard, not a cost guard.** Raising it does not cost more — the same messages are processed either way — but it drives more simultaneous write units at a 14 WCU table, and the bill for crossing that allowance is $0.00065/WCU-hour. The cap keeps the platform inside the free capacity rather than inside a budget.
- **The alarm allowance is now genuinely tight.** Nine of ten used. The tenth is the last free one, and #29's notification wiring is the likeliest claimant.
- **Nothing here has an hourly rate**, the property all six stacks preserve. The change that would break it is the same one as ingestion's: a VPC configuration on the function, which for outbound internet needs a NAT Gateway at ~$32/month — and this function does not talk to the internet at all, only to DynamoDB and SQS.

### CloudWatch alarm budget

CloudWatch's always-free tier is **10 alarms per account**, and it is the only allowance in this platform that is genuinely close to its edge. It is also the only one no single stack can see: alarms are created in four directories, the tier is billed in one account, and every "$0.00/mo" above depends on the total. This subsection is the platform-level owner of that number, and it settles [issue #126](https://github.com/TomBennett-Lloyd/cumulo/issues/126), which asked for exactly that.

**Counted at the time of writing, from the `.tf` files rather than from a previous edition of this document:**

| Stack       | Alarms | Which                                                                                                                        |
| ----------- | -----: | ---------------------------------------------------------------------------------------------------------------------------- |
| `storage`   |      4 | `cumulo-{series,weather}-<env>-{read,write}-throttle` — two resources expanded by `for_each` over the two provisioned tables |
| `ingestion` |      3 | `cumulo-ingestion-<env>-errors`, `cumulo-weather-readings-dlq-<env>-not-empty`, `cumulo-ingestion-<env>-async-dropped`       |
| `api`       |      2 | `cumulo-api-<env>-5xx`, `cumulo-api-<env>-request-flood`                                                                     |
| `alerting`  |      0 | It is the destination, not a source                                                                                          |
| **Total**   |  **9** | **One of the always-free ten still unallocated**                                                                             |

Verify it against the account rather than trusting the table:

```bash
aws cloudwatch describe-alarms --alarm-name-prefix cumulo- --query 'length(MetricAlarms)'
# expect: 9
```

**The decision, which is what #126 asked for.** The tenth alarm is reserved for [#136](https://github.com/TomBennett-Lloyd/cumulo/issues/136)'s forecast runtime, which needs an `Errors` alarm on the same argument the ingestion one rests on: a scheduled deployable whose output is invisible needs something watching. That is a reservation, not a rule — whoever gets there first takes it — but a PR claiming the tenth against a weaker argument should expect to be asked why #136's is not the better use of the last free slot.

**Past ten, alarms bill $0.10 each per month, and the obligation is honesty rather than restraint.** $0.10/month is not a number worth contorting a design around; a silently false cost table is. So a PR that takes the platform past ten **must** do three things in the same change:

1. state the new total in its description, and why the alarm earns its slot;
2. update this table and the per-stack `Alarms` rows in the cost tables above;
3. replace the affected **$0.00/mo** totals with the real figure — eleven alarms make it $0.10/mo, not $0.

That third one is the point. Every cost claim in this document is quoted at list price with expiring allowances deliberately uncounted (see the API stack's note on the 12-month gateway tier), and a "$0.00/mo" that quietly means "$0.10/mo" would be the first place that discipline broke.

**Two things that do not consume the allowance**, worth knowing before anyone economises in the wrong direction: composite alarms are billed separately at $0.50/month each and do not draw on the free ten, and a single alarm resource expanded by `for_each` costs one slot **per instance** — `storage`'s two resources are four alarms, which is why the table counts instances rather than `resource` blocks.
