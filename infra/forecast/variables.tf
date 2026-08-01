variable "aws_region" {
  description = <<-EOT
    Region for this stack's function, event source mapping and alarm.
    Deliberately has no default, exactly as in infra/storage, infra/ingestion
    and infra/api: the region is an account-level decision that lives in a
    gitignored *.auto.tfvars, so nothing can silently apply into the wrong
    region because a default said so.

    It is load-bearing beyond the usual reasons here, and in one more place
    than in the other stacks. This stack's IAM policy names the storage stack's
    DynamoDB tables by ARN *and* the ingestion stack's SQS queue by ARN, and
    both a table ARN and a queue ARN are regional. Applying forecast into a
    region the storage and ingestion stacks were not applied to produces a
    function whose grants point at a table and a queue that do not exist — and
    the queue half fails at *apply*, because the event source mapping is
    created against that ARN.
  EOT
  type        = string

  validation {
    condition     = can(regex("^[a-z]{2}(-[a-z]+)+-[0-9]$", var.aws_region))
    error_message = "aws_region must be an AWS region id, e.g. eu-west-1."
  }
}

variable "environment" {
  description = <<-EOT
    Environment suffix in every name this stack creates — the function, its log
    group, its execution role and its deploy policy — and in the storage table
    names and the ingestion queue name its IAM policy grants access to. The
    same suffix convention as infra/storage's `cumulo-<table>-<environment>`,
    and the same value must be used in the storage, ingestion and forecast
    stacks or this function is wired to resources that do not exist.

    Defaulted, unlike aws_region: a wrong value here creates a fresh, empty,
    idle-free set of resources rather than applying into an unintended region.
  EOT
  type        = string
  default     = "dev"

  validation {
    condition     = can(regex("^[a-z0-9-]+$", var.environment))
    error_message = "environment must be lowercase alphanumerics and hyphens, e.g. dev — it is interpolated directly into function, queue and table names."
  }
}
