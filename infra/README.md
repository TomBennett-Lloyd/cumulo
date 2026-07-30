# Cumulo infrastructure

All AWS infrastructure lives here as Terraform. Nothing is created by hand in the console — if it exists in the account, it exists in a `.tf` file, because the alternative is infrastructure that cannot be torn down and a cost ceiling that cannot be trusted.

A **stack** is one directory under `infra/`, applied independently, with its own state. There is one today:

| Stack       | Directory          | Owns                                                                   |
| ----------- | ------------------ | ---------------------------------------------------------------------- |
| `bootstrap` | `infra/bootstrap/` | Terraform's own remote state bucket, and the GitHub Actions OIDC role. |

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

That decision has a consequence worth stating plainly: `terraform output` prints values that embed the account id, and three of the four outputs contain it. Do not paste raw output into committed files, PR bodies, or issue comments — quote the shape (`arn:aws:iam::<account-id>:role/cumulo-github-actions`), not the digits.

### 8. The GitHub Actions role starts with zero permissions

`aws_iam_role.github_actions` has no inline policies and no managed policy attachments. This is not an oversight or a to-do: the smoke test that proves the role works — `aws sts get-caller-identity` — requires no permissions at all, so the entire OIDC path can be verified end to end before a single grant exists. Deploy permissions then arrive least-privilege with the service tickets that need them, scoped to the resources those services own (ADR 0001). A broad `PowerUserAccess` here would be quicker and would quietly undo that.

The trust policy is the security boundary, and it is worth reading `oidc.tf` before changing: the `sub` condition pins `repo:<owner>/<repo>:*` with the owner and repo segments literal. Checking `aud` is necessary and nowhere near sufficient — every GitHub Actions token in the world carries `aud=sts.amazonaws.com`, so a trust policy that stops at the audience lets any repository on GitHub assume the role while still looking like it has a condition block that does something.

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

Expect **`Plan: 7 to add, 0 to change, 0 to destroy.`** — one S3 bucket plus its four configuration resources, the IAM OIDC provider, and the IAM role. Any other count means the configuration is not what this document describes; stop and find out why.

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
terraform state list   # now read from S3; expect the 7 resources from A5
```

**B4. Remove the local state files.** They are gitignored, but a stale local state that still describes live resources is a trap for the next operator:

```bash
rm -f terraform.tfstate terraform.tfstate.backup
```

**B5. Confirm no drift.** `-detailed-exitcode` exits `0` for no changes, `2` for pending changes, `1` for an error — so the exit code is the assertion:

```bash
terraform plan -detailed-exitcode
echo $?   # expect 0
```

**B6. Publish the two repo variables.** The role ARN comes from `terraform output`, never hand-assembled from an account id:

```bash
gh variable set AWS_OIDC_ROLE_ARN --repo TomBennett-Lloyd/cumulo \
  --body "$(terraform output -raw github_actions_role_arn)"
gh variable set AWS_REGION --repo TomBennett-Lloyd/cumulo --body eu-west-1
```

`AWS_REGION` is typed literally because the region is an input to this stack rather than something it derives — it must equal `aws_region` in `bootstrap.auto.tfvars` and `region` in `backend.hcl`. Then confirm what exists, and what does not:

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
terraform state list   # expect the same 7 resources
```

**T3. Destroy.** `force_destroy = true` on the bucket is what allows this to complete — a versioned bucket is never empty, and by this point it holds only a copy of state that T1 already brought home:

```bash
terraform destroy
```

**T4. Verify it is actually gone**, from AWS rather than from Terraform's own opinion. All three commands are expected to _fail_, and the specific failures are the evidence:

```bash
BUCKET="cumulo-tfstate-$(aws sts get-caller-identity --query Account --output text)"

aws s3api head-bucket --bucket "$BUCKET"
# expect: An error occurred (404) ... Not Found

aws iam get-role --role-name cumulo-github-actions
# expect: An error occurred (NoSuchEntity) ...

aws iam list-open-id-connect-providers
# expect: no entry containing token.actions.githubusercontent.com
```

**T5. Clean the working directory.**

```bash
rm -f backend_override.tf terraform.tfstate terraform.tfstate.backup
rm -rf .terraform
```

Keep `backend.hcl` and `bootstrap.auto.tfvars` — the bucket name is deterministic (convention 3), so both are still correct for the next spin-up.

**T6. Repo variables — leave them, unless this is the end of the project.** A teardown rehearsal should _not_ delete `AWS_OIDC_ROLE_ARN`: the role name and account are fixed, so a fresh apply reproduces a byte-identical ARN, and the stored value still matching afterwards is itself a check that the runbook is reproducible. Only on a final decommission:

```bash
gh variable delete AWS_OIDC_ROLE_ARN --repo TomBennett-Lloyd/cumulo
gh variable delete AWS_REGION --repo TomBennett-Lloyd/cumulo
```

**After T4 this stack costs exactly $0** — not "approximately nothing", but no billable resource remaining. There is nothing left to leak, because IAM roles and OIDC providers are free and the only chargeable thing the stack ever created was the bucket.

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

## Cost

`eu-west-1`, and the amounts are not rounded down for effect — the stack really is this cheap, which is the reason a remote backend is affordable at all under the ~$100/month ceiling.

| Resource group                                                                       | Billing basis                                                   | Estimate                       |
| ------------------------------------------------------------------------------------ | --------------------------------------------------------------- | ------------------------------ |
| **State bucket — storage** (`aws_s3_bucket.tfstate`)                                 | S3 Standard, ~$0.023/GB-month                                   | < $0.01/mo (state is KB-scale) |
| **State bucket — requests** (state reads/writes plus native lockfile PUT/GET/DELETE) | ~$0.005/1,000 PUT, ~$0.0004/1,000 GET                           | < $0.01/mo (hundreds of ops)   |
| **Bucket configuration** (versioning, SSE-S3, public access block, lifecycle rule)   | No charge for the configuration; versions bill as storage above | $0.00/mo                       |
| **IAM** (`aws_iam_openid_connect_provider.github`, `aws_iam_role.github_actions`)    | IAM roles and OIDC providers are free                           | $0.00/mo                       |
| **Total**                                                                            |                                                                 | **≈ $0.01/mo — rounds to $0**  |

Notes on why nothing here grows:

- **Versioning is bounded.** The lifecycle rule expires noncurrent versions after 90 days, so state history cannot accumulate indefinitely. Without it, versioning is a slow storage leak.
- **SSE-S3, not SSE-KMS.** State is encrypted at rest either way; a customer-managed KMS key would add a monthly key charge plus per-request charges to the one stack whose entire purpose includes being tearable down to $0.
- **The native lockfile has no standing charge.** A DynamoDB lock table would sit in the account billing for existence even while idle; the lockfile is an object that exists only during an operation.
- **No NAT gateway, no load balancer, no VPC endpoint** — this stack creates nothing with an hourly rate. That is the property to preserve when adding to it: per-request costs at this volume are noise, and hourly ones are the whole budget.
