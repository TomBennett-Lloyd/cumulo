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

variable "github_subject_prefix" {
  description = <<-EOT
    GitHub's immutable subject prefix for this repository — the leading portion
    of the OIDC token's `sub` claim, embedding the numeric owner id and
    repository id rather than their current names
    (`repo:<owner>@<owner-id>/<repo>@<repo-id>`).

    This, not `github_repository`, is the security boundary enforced by the
    trust policy in oidc.tf. It must be read from GitHub rather than
    hand-assembled, because the numeric ids are not derivable from the names:

      gh api repos/OWNER/REPO/actions/oidc/customization/sub --jq .sub_claim_prefix

    Anyone applying this stack against their own fork or account must re-derive
    it — the default below is correct only for TomBennett-Lloyd/cumulo.
  EOT
  type        = string
  default     = "repo:TomBennett-Lloyd@36540971/cumulo@1316528563"

  validation {
    # Both segments must carry the `@<digits>` id suffix. A name-only prefix
    # (`repo:owner/repo`) is rejected rather than merely discouraged: names are
    # reassignable, so after a rename whoever claims the freed owner or repo
    # name would inherit trust that was never granted to them. Requiring the
    # ids makes that property machine-enforced instead of documented.
    condition     = can(regex("^repo:[^/@]+@[0-9]+/[^/@:]+@[0-9]+$", var.github_subject_prefix))
    error_message = "github_subject_prefix must be GitHub's immutable, id-embedding form — repo:<owner>@<owner-id>/<repo>@<repo-id>, e.g. repo:TomBennett-Lloyd@36540971/cumulo@1316528563. A name-only prefix is rejected because GitHub names can be reassigned after a rename, which would transfer trust to whoever claims the freed name. Read the real value with: gh api repos/OWNER/REPO/actions/oidc/customization/sub --jq .sub_claim_prefix"
  }
}
