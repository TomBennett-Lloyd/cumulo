# Remote state for the bootstrap stack itself, in the bucket this stack creates.
#
# This is a *partial* configuration on purpose: `bucket` and `region` are
# account-specific and are supplied at init time from a gitignored `backend.hcl`
# (copy `backend.hcl.example`), so the public repo never records the AWS account
# id. `key` and the safety settings below are repo-wide conventions and belong
# in version control.
#
# Locking uses S3's native lockfile rather than a DynamoDB lock table: one fewer
# resource to provision and tear down, $0, and DynamoDB-based state locking is
# deprecated in current Terraform. It is why versions.tf floors Terraform at
# 1.12.
#
# Chicken-and-egg: on the very first apply this bucket does not exist yet, so
# there is nowhere to keep the state that records the bucket. Resolved by a
# gitignored `backend_override.tf` — Terraform's override-file semantics replace
# this whole block with `backend "local"` — applying against local state, then
# deleting the override and running
# `terraform init -migrate-state -backend-config=backend.hcl` to move the state
# into the bucket it just created. Teardown reverses it. Both directions are
# scripted step by step in infra/README.md; do not improvise them.
terraform {
  backend "s3" {
    key          = "bootstrap/terraform.tfstate"
    encrypt      = true
    use_lockfile = true
  }
}
