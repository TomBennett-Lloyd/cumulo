variable "aws_region" {
  description = <<-EOT
    Region for this stack's queue, function, schedule and alarms. Deliberately
    has no default, exactly as in infra/storage: the region is an account-level
    decision that lives in a gitignored *.auto.tfvars, so nothing can silently
    apply into the wrong region because a default said so.

    It is load-bearing beyond the usual reasons here. This stack's IAM policy
    names the storage stack's DynamoDB tables by ARN, and a table ARN is
    regional. Applying ingestion into a region the storage stack was not applied
    to produces a function whose grants point at tables that do not exist —
    which fails at the first cycle, in CloudWatch, rather than at apply.
  EOT
  type        = string

  validation {
    condition     = can(regex("^[a-z]{2}(-[a-z]+)+-[0-9]$", var.aws_region))
    error_message = "aws_region must be an AWS region id, e.g. eu-west-1."
  }
}

variable "environment" {
  description = <<-EOT
    Environment suffix in every name this stack creates — the queue, its
    dead-letter queue, the function, and the log group — and in the storage
    table names its IAM policy grants access to. The same suffix convention as
    infra/storage's `cumulo-<table>-<environment>`, and the same value must be
    used in both stacks or ingestion is granted access to tables that do not
    exist.

    Defaulted, unlike aws_region: a wrong value here creates a fresh, empty,
    idle-free set of resources rather than applying into an unintended region.
  EOT
  type        = string
  default     = "dev"

  validation {
    condition     = can(regex("^[a-z0-9-]+$", var.environment))
    error_message = "environment must be lowercase alphanumerics and hyphens, e.g. dev — it is interpolated directly into queue, function and table names."
  }
}
