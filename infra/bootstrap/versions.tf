# Terraform >= 1.12 is a hard floor, not a preference: this stack locks its own
# state with S3's native lockfile (see backend.tf), which older versions do not
# support. Every operator and every CI job must clear that floor.
terraform {
  required_version = ">= 1.12.0, < 2.0.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
}
