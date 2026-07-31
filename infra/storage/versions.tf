# Same floor as the bootstrap stack, and for the same reason: this stack locks
# its own state with S3's native lockfile (see backend.tf), which Terraform
# versions below 1.12 do not support. The ceiling keeps a future 2.0 from
# arriving mid-apply. The exact provider patch is fixed by .terraform.lock.hcl,
# which is committed and maintained with `terraform providers lock -platform=...`
# for all four platforms (infra/README.md convention 5).
terraform {
  required_version = ">= 1.12.0, < 2.0.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
}
