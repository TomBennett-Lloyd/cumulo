variable "aws_region" {
  description = <<-EOT
    Region for this stack's SNS topic and its subscription. Deliberately has no
    default, exactly as in infra/storage, infra/ingestion and infra/api: the
    region is an account-level decision that lives in a gitignored
    *.auto.tfvars, so nothing can silently apply into the wrong region because a
    default said so.

    It is load-bearing beyond the usual reasons here, in both directions. The
    alarm stacks assemble this topic's ARN from the naming convention, and an
    SNS ARN is regional — a topic applied into a region the alarms were not
    applied to leaves every alarm action pointing at a topic that does not
    exist, which CloudWatch accepts at apply time and reports only by never
    delivering. And /cumulo/notification-email is a regional SSM parameter, so
    the region also decides whether this stack can read the address at all.
  EOT
  type        = string

  validation {
    condition     = can(regex("^[a-z]{2}(-[a-z]+)+-[0-9]$", var.aws_region))
    error_message = "aws_region must be an AWS region id, e.g. eu-west-1."
  }
}

variable "environment" {
  description = <<-EOT
    Environment suffix in the topic name this stack creates —
    cumulo-alerts-<environment> — and the same suffix convention as every other
    stack. The same value must be used here and in every stack whose alarms
    target the topic, because those stacks assemble the ARN from this name
    rather than reading it from an output.

    Defaulted, unlike aws_region: a wrong value here creates a fresh, idle-free
    topic rather than applying into an unintended region.
  EOT
  type        = string
  default     = "dev"

  validation {
    condition     = can(regex("^[a-z0-9-]+$", var.environment))
    error_message = "environment must be lowercase alphanumerics and hyphens, e.g. dev — it is interpolated directly into the topic name that every stack's alarm actions are assembled from."
  }
}
