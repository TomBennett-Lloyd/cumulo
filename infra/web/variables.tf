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

variable "api_origin" {
  description = <<-EOT
    The origin the deployed SPA calls its API on — scheme and host, nothing
    else — appended to the Content-Security-Policy's `connect-src` by
    security-headers.tf.

    Empty is the **pre-API** state, not a deployment mode: it defaults to empty
    so this stack can plan and apply before infra/api exists, and it is the only
    reason the default is there. It is not "a demo-mode deployment" — neither
    deploy path will publish a build without an API base URL.
    .github/workflows/deploy-web.yml fails its preflight step on an empty
    VITE_API_BASE_URL, and .github/workflows/deploy-pages.yml carries a
    job-level `if: vars.VITE_API_BASE_URL != ''` and skips entirely. Demo mode
    exists in local dev, vitest and the Playwright lane, and nowhere a
    distribution serves. So any distribution reachable by deploy-web.yml needs
    this set, and one serving content with this still empty is the quiet failure
    the next paragraph describes rather than a supported configuration.

    This is the same operator-published string as the repo variable
    `VITE_API_BASE_URL` (step B2 of infra/README.md's web runbook), travelling
    the other way. There, the value is baked into the build so the SPA knows
    where to call; here, it is baked into the policy so the browser will let it.
    The two carriers must agree. If they disagree — or if this is left empty
    against a build that has an API base URL — the deployed demo's own fetches
    are blocked by its own CSP, and the failure surfaces in the browser console
    rather than in any plan or apply. Both come from the same command,
    `terraform -chdir=../api output -raw api_endpoint`, and neither should ever
    be retyped from the other.

    Never a wildcard. `https://*.execute-api.<region>.amazonaws.com` would look
    like a convenience and would in fact admit every API Gateway in the region —
    including anyone else's — as a destination the page may send data to. The
    exact host is the only safe value, which is why the validation below rejects
    anything carrying a path, a trailing slash or a port as well.
  EOT
  type        = string
  default     = ""

  validation {
    condition     = var.api_origin == "" || can(regex("^https://[a-z0-9][a-z0-9.-]*$", var.api_origin))
    error_message = "api_origin must be empty, or an origin — scheme and host only, e.g. https://abc123.execute-api.eu-west-1.amazonaws.com — with no path, no trailing slash and no port."
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
