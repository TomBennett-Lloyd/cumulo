data "aws_caller_identity" "current" {}

locals {
  # Deterministic and globally unique, with no random suffix to track: after a
  # teardown/spin-up cycle the bucket comes back with the same name, so
  # backend.hcl stays valid. Derived from the caller's account rather than
  # passed in as a variable, so the account id never needs to appear in a
  # committed file.
  state_bucket_name = "cumulo-tfstate-${data.aws_caller_identity.current.account_id}"
}

resource "aws_s3_bucket" "tfstate" {
  bucket = local.state_bucket_name

  # Clean teardown is a hard constraint (CLAUDE.md: infra "designed for clean
  # spin-up/tear-down"), and a versioned bucket is never empty, so
  # `terraform destroy` cannot delete this bucket without force_destroy. That
  # trades away a real safety rail and is flagged for review rather than hidden:
  # the mitigation is that the bucket holds nothing but Terraform state, and the
  # teardown runbook migrates that state back to local disk *before* any destroy
  # runs — so the destructive step has nothing left to lose.
  force_destroy = true
}

resource "aws_s3_bucket_versioning" "tfstate" {
  bucket = aws_s3_bucket.tfstate.id

  # State history is the recovery path for a bad apply or a corrupted push.
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "tfstate" {
  bucket = aws_s3_bucket.tfstate.id

  # SSE-S3 (AES256), not SSE-KMS: state is encrypted at rest either way, and a
  # customer-managed key would add a monthly charge plus a key policy to the
  # very stack that has to be tearable down to $0.
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "tfstate" {
  bucket = aws_s3_bucket.tfstate.id

  # Terraform state routinely contains resource identifiers and can contain
  # secrets. All four settings on, unconditionally.
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_lifecycle_configuration" "tfstate" {
  bucket = aws_s3_bucket.tfstate.id

  # Versioning without expiry grows forever. 90 days is long enough to recover
  # from any apply anyone is still reasoning about, and keeps storage at the
  # KB scale that makes this stack effectively free.
  rule {
    id     = "expire-noncurrent-state-versions"
    status = "Enabled"

    filter {}

    noncurrent_version_expiration {
      noncurrent_days = 90
    }
  }
}
