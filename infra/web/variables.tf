variable "aws_region" {
  description = <<-EOT
    Region for this stack's S3 bucket. Deliberately has no default, exactly as
    in infra/storage, infra/ingestion, infra/api and infra/alerting: the region
    is an account-level decision that lives in a gitignored *.auto.tfvars, so
    nothing can silently apply into the wrong region because a default said so.

    Note what it does *not* control. CloudFront is a global service: the
    distribution, the origin access control and the managed cache policy are
    account-global resources that the provider reaches through its us-east-1
    endpoint regardless of what is set here. The only regional thing in this
    stack is the bucket — and the origin is wired to it by
    `bucket_regional_domain_name`, so the origin follows this value
    automatically rather than needing the region restated anywhere.

    The practical consequence is that a wrong region here does not break the
    demo the way it breaks the alerting stack; it just puts the bucket
    somewhere the operator did not intend, one region further from every cache
    miss. Keep it the same as every other stack.
  EOT
  type        = string

  validation {
    condition     = can(regex("^[a-z]{2}(-[a-z]+)+-[0-9]$", var.aws_region))
    error_message = "aws_region must be an AWS region id, e.g. eu-west-1."
  }
}

variable "environment" {
  description = <<-EOT
    Environment suffix in every name this stack creates — the bucket
    (cumulo-web-<environment>-<account-id>), the origin access control and the
    deploy grant's policy name — and the same suffix convention as every other
    stack.

    Unlike the api and storage stacks, nothing here has to agree with another
    stack's `environment` to work: this stack serves static files and holds no
    grant on, and no reference to, any resource another stack owns. Matching it
    to the others is still the convention, and is what keeps a teardown able to
    reason about one environment at a time.

    Defaulted, unlike aws_region: a wrong value here creates a fresh, empty,
    idle-free bucket and distribution rather than applying into an unintended
    region.
  EOT
  type        = string
  default     = "dev"

  validation {
    condition     = can(regex("^[a-z0-9-]+$", var.environment))
    error_message = "environment must be lowercase alphanumerics and hyphens, e.g. dev — it is interpolated directly into the S3 bucket name, which additionally means it must be DNS-safe."
  }
}
