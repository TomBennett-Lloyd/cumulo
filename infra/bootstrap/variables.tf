variable "aws_region" {
  description = <<-EOT
    Region for this stack's regional resources (the state bucket; the IAM role
    and OIDC provider are global). Deliberately has no default: the region is
    an account-level decision that lives in a gitignored *.auto.tfvars, so
    nothing can silently apply into the wrong region because a default said so.
  EOT
  type        = string

  validation {
    condition     = can(regex("^[a-z]{2}(-[a-z]+)+-[0-9]$", var.aws_region))
    error_message = "aws_region must be an AWS region id, e.g. eu-west-1."
  }
}

variable "github_repository" {
  description = <<-EOT
    The single owner/repo whose GitHub Actions workflows may assume the deploy
    role. This value is the security boundary of the trust policy in oidc.tf —
    widening it widens who can assume the role.
  EOT
  type        = string
  default     = "TomBennett-Lloyd/cumulo"

  validation {
    condition     = can(regex("^[A-Za-z0-9][A-Za-z0-9._-]*/[A-Za-z0-9][A-Za-z0-9._-]*$", var.github_repository))
    error_message = "github_repository must be a literal owner/repo, e.g. TomBennett-Lloyd/cumulo — no wildcards."
  }
}
