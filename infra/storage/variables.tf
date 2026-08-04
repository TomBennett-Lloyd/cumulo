variable "aws_region" {
  description = <<-EOT
    Region for this stack's tables and alarms. Deliberately has no default: the
    region is an account-level decision that lives in a gitignored
    *.auto.tfvars, so nothing can silently apply into the wrong region because
    a default said so.

    It is load-bearing beyond the usual reasons here. DynamoDB's always-free
    capacity pool is a *per-Region* allowance (ADR 0002;
    `infra/storage/tables.tf`'s header owns the figures), and this stack's one
    provisioned table (`series` — weather went on-demand, #156) is sized
    against a pool that nothing else in the account consumes. Applying a
    second copy into a second region would create a second pool; applying two
    copies into the same region would share one.
  EOT
  type        = string

  validation {
    condition     = can(regex("^[a-z]{2}(-[a-z]+)+-[0-9]$", var.aws_region))
    error_message = "aws_region must be an AWS region id, e.g. eu-west-1."
  }
}

variable "environment" {
  description = <<-EOT
    Environment suffix in every table name — `cumulo-<table>-<environment>`,
    the naming convention fixed by ADR 0002 and mirrored by
    `storageTableName()` in @cumulo/storage. Table names are the least-privilege
    boundary (they become the ARNs in the service IAM policies), so this is the
    one input that decides which data a deployed service can reach.

    Defaulted, unlike aws_region: a wrong value here creates a fresh empty set
    of tables rather than applying into an unintended region, and every table
    in this stack is free at rest.
  EOT
  type        = string
  default     = "dev"

  # This pattern has a mirror in code: `ENVIRONMENT_PATTERN` in
  # `packages/storage/src/table-name.ts` rejects the same suffixes before
  # `storageTableName()` interpolates one. Per architecture rule 8 the pair is
  # declared to `check:infra-mirrors` as well as cited here, so the two patterns
  # cannot drift apart quietly — the gate compares the pattern texts on every
  # `verify` run.
  validation {
    condition     = can(regex("^[a-z0-9-]+$", var.environment))
    error_message = "environment must be lowercase alphanumerics and hyphens, e.g. dev — it is interpolated directly into table names."
  }
}
