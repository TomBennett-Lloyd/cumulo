# Remote state for the fleet API stack, in the bucket the bootstrap stack
# creates.
#
# Partial configuration on purpose, exactly as in infra/bootstrap,
# infra/storage and infra/ingestion: `bucket` and `region` are account-specific
# and are supplied at init time from a gitignored `backend.hcl` (copy
# `backend.hcl.example`), so this public repo never records the AWS account id
# (infra/README.md convention 7). `key` and the safety settings below are
# repo-wide conventions and belong in version control.
#
# The key prefix is the directory name, which is also the `Stack` tag on every
# resource in here (convention 2) — three independent trails from a resource in
# the console back to the code that owns it.
#
# There is no override dance here. Like storage and ingestion, this stack does
# not create the bucket that stores its own state: by the time it is applied the
# bucket already exists, so `terraform init -backend-config=backend.hcl` is the
# first and only init. See the api runbook in infra/README.md.
terraform {
  backend "s3" {
    key          = "api/terraform.tfstate"
    encrypt      = true
    use_lockfile = true
  }
}
