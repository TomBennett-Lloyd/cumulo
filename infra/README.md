# Cumulo infrastructure

All AWS infrastructure lives here as Terraform. Nothing is created by hand in the console — if it exists in the account, it exists in a `.tf` file, because the alternative is infrastructure that cannot be torn down and a cost ceiling that cannot be trusted.

A **stack** is one directory under `infra/`, applied independently, with its own state. There is one today:

| Stack       | Directory          | Owns                                                                                                          |
| ----------- | ------------------ | ------------------------------------------------------------------------------------------------------------- |
| `bootstrap` | `infra/bootstrap/` | Terraform's own remote state bucket, the GitHub Actions OIDC role, and the monthly cost-ceiling budget alarm. |

Later stacks arrive as sibling directories with their service tickets, per [ADR 0001](../docs/adr/0001-service-boundaries.md): a resource used by exactly one service is owned by that service's stack; a resource more than one service would notice is platform-owned.

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

### 6. First apply: local state, then migrate the stack into its own bucket

The bootstrap stack creates the bucket that stores the bootstrap stack's state, which does not exist when the stack is first applied. Resolved by applying against a local backend, then migrating the resulting state into the bucket that apply just created. Teardown runs it in reverse. Both directions are scripted below in [Runbook: spin up](#runbook-spin-up-the-bootstrap-stack) and [Runbook: tear down](#runbook-tear-down-the-bootstrap-stack), and the mechanism is explained in [Why the override dance](#why-the-override-dance).

### 7. Account-specific values stay out of the public repo

This repository is public. The AWS account id is not a credential, but it is an identifier that narrows an attacker's search, and there is no reason for it to be in a git history that cannot be rewritten. So `backend.tf` carries a **partial** backend configuration — the repo-wide conventions (`key`, `encrypt`, `use_lockfile`) are committed, and `bucket` and `region` come from a gitignored `backend.hcl` at init time. Region likewise comes from a gitignored `bootstrap.auto.tfvars`. Both have committed `.example` twins, so the shape is documented even though the values are not, and `.gitignore` blocks the real files along with Terraform override files.

Personal config tied to the account goes one step further and does not live on the operator's disk either. The budget alarm's notification address is an email address — personal data with no business in a public git history, and no business being retyped into a local file on every machine that ever applies this stack. It lives in an **operator-created SSM parameter**, `/cumulo/notification-email` (SecureString, default KMS key), and Terraform only ever _reads_ it through a data source. The account is the source of truth: there is exactly one copy, in the region the stack deploys to, and a second machine spinning the stack up needs no handoff. Terraform cannot create it without reintroducing the problem — the value would have to come from a variable again — so the one-time `put-parameter` is an operator step in [A1](#phase-a--configure-and-plan). The address does land in Terraform state, which is why state lives in a private bucket; it never lands in git.

That decision has a consequence worth stating plainly: `terraform output` prints values that embed the account id, and three of the five outputs contain it. Do not paste raw output into committed files, PR bodies, or issue comments — quote the shape (`arn:aws:iam::<account-id>:role/cumulo-github-actions`), not the digits.

### 8. The GitHub Actions role starts with zero permissions

`aws_iam_role.github_actions` has no inline policies and no managed policy attachments. This is not an oversight or a to-do: the smoke test that proves the role works — `aws sts get-caller-identity` — requires no permissions at all, so the entire OIDC path can be verified end to end before a single grant exists. Deploy permissions then arrive least-privilege with the service tickets that need them, scoped to the resources those services own (ADR 0001). A broad `PowerUserAccess` here would be quicker and would quietly undo that.

The trust policy is the security boundary, and it is worth reading `oidc.tf` before changing: the `sub` condition is a two-value `StringEquals` allowlist — one `…:ref:refs/heads/main`, one `…:pull_request` — not a `:*` wildcard, so tags, other branch refs and future event contexts cannot assume the role at all. The `pull_request` entry is there only so `oidc-smoke` can run pre-merge against a role with no permissions; **the change that attaches the first permission to this role must delete that entry in the same PR**, because a pull_request-context run must never hold deploy permissions. Checking `aud` is necessary and nowhere near sufficient — every GitHub Actions token in the world carries `aud=sts.amazonaws.com`, so a trust policy that stops at the audience lets any repository on GitHub assume the role while still looking like it has a condition block that does something.

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

**A6. Stop here on the bootstrap PR.** Summarise the plan in the PR body (resource counts, bucket name shape, role name — not the account digits, per convention 7) and wait for review. The `oidc-smoke` check will be red on the PR until Phase B publishes the repo variables; that is expected, and the workflow's preflight step says so on the run itself.

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

Then re-run the PR's previously-red `oidc-smoke` check, which should now pass:

```bash
gh pr checks --repo TomBennett-Lloyd/cumulo
```

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

That does not dilute convention 8. Bootstrap's "deliberately minimal" property is about _deploy permissions_ and app resources, and this budget is notification-only: no budget action, no SNS topic, no IAM grant of any kind. The GitHub Actions role still has zero permissions, the `pull_request` entry in its trust policy is untouched, and CI still never touches AWS. Budget _actions_ — auto-attaching a deny policy at 100% — would change all three of those and start the $0.10/day meter; they are a separate decision, not an increment of this one.

Email subscribers are attached to the budget directly rather than through SNS. Budget notifications need no subscription confirmation, whereas an SNS email subscription requires a human to click a link and, until they do, cannot be deleted for three days — a teardown that blocks for three days is not a teardown.

**A quiet forecast alarm is not a broken one.** FORECASTED notifications need roughly five weeks of usage history before AWS will produce a forecast at all, so on a young account that threshold is simply silent. The three ACTUAL thresholds work from the first billing period and cover the gap.

---

## Cost

`eu-west-1`, and the amounts are not rounded down for effect — the stack really is this cheap, which is the reason a remote backend is affordable at all under the ~$100/month ceiling.

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
