variable "aws_region" {
  description = <<-EOT
    Region for this stack's function, HTTP API, log group and alarms.
    Deliberately has no default, exactly as in infra/storage and
    infra/ingestion: the region is an account-level decision that lives in a
    gitignored *.auto.tfvars, so nothing can silently apply into the wrong
    region because a default said so.

    It is load-bearing beyond the usual reasons here. This stack's IAM policy
    names the storage stack's DynamoDB tables by ARN, and a table ARN is
    regional. Applying the API into a region the storage stack was not applied
    to produces a function whose grants point at tables that do not exist —
    which fails at the first request, in CloudWatch, rather than at apply.
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
    group, the HTTP API, the execution role and the deploy grant — and in the
    storage table names its IAM policy grants access to. The same suffix
    convention as infra/storage's `cumulo-<table>-<environment>`, and the same
    value must be used in both stacks or the API is granted access to tables
    that do not exist.

    It is also the value passed to the function as CUMULO_ENV, which is what
    storageTableName() in @cumulo/storage resolves table names from at runtime.
    So a mismatch between this and the storage stack's `environment` breaks the
    grant and the lookup together, in the same direction, which is the only
    mercy in it.

    Defaulted, unlike aws_region: a wrong value here creates a fresh, empty,
    idle-free set of resources rather than applying into an unintended region.
  EOT
  type        = string
  default     = "dev"

  validation {
    condition     = can(regex("^[a-z0-9-]+$", var.environment))
    error_message = "environment must be lowercase alphanumerics and hyphens, e.g. dev — it is interpolated directly into function, API and table names."
  }
}

variable "web_origins" {
  description = <<-EOT
    Comma-separated browser origins allowed to call the write routes, beyond the
    API's own origin, which the function always allows and never needs told
    (it reads it from the request's own domain name). Passed to the function as
    CUMULO_WEB_ORIGINS; the origin check itself is in apps/api and is documented
    in that README's abuse-protection section.

    Empty by default, and that default is correct today: the only browser that
    calls a write route right now is the Swagger UI this API serves itself, and
    that is same-origin. #144 adds the CloudFront URL here and #21 the custom
    domain — as tfvars values, when those origins exist. Neither belongs in a
    committed file: an origin hard-coded in Terraform is an origin that outlives
    the deployment it was true for, and this stack's whole naming convention is
    that environment-specific strings come in as variables.

    This is friction, not authentication. It stops a drive-by script and a
    cross-site page in a browser, both of which cannot choose their Origin
    header; it stops nothing that sets the header itself, and it is not meant
    to. ADR 0006 records that as a stated non-goal.
  EOT
  type        = string
  default     = ""

  validation {
    # Each entry must be a bare origin — scheme, host, optional port, and
    # nothing else. A trailing slash or a path is the failure this catches, and
    # it is worth a validation because of how quietly it fails: the check in
    # apps/api compares against the browser's Origin header, which never carries
    # either, so "https://example.com/" matches nothing and the origin it was
    # added for stays locked out with no error anywhere.
    #
    # Whitespace around a comma is rejected rather than trimmed, and on purpose:
    # what the function splits is this exact string, so anything this validation
    # forgives is something the runtime comparison may not. A loud plan-time
    # error naming the fix beats a value that applies cleanly and matches
    # nothing.
    condition = var.web_origins == "" || alltrue([
      for origin in split(",", var.web_origins) :
      can(regex("^https?://[A-Za-z0-9.-]+(:[0-9]+)?$", origin))
    ])
    error_message = "web_origins must be a comma-separated list of bare origins, e.g. https://example.cloudfront.net,http://localhost:5173 — scheme and host only, no trailing slash and no path."
  }
}
