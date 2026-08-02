# The deploy grant: the S3 and CloudFront calls that
# .github/workflows/deploy-web.yml makes, on this stack's bucket and
# distribution, and nothing else. The fourth such grant on
# `cumulo-github-actions`, after infra/ingestion, infra/api and infra/forecast,
# and written to the same shape deliberately — convention 8 in infra/README.md
# is that every grant the shared role holds lives in the stack that needed it.
#
# It lives in this stack rather than in bootstrap because of ADR 0001: a
# resource exactly one service would notice belongs to that service's stack.
# The practical consequence is the one worth having — `terraform destroy` here
# takes the deploy permission with it, so a torn-down demo cannot leave a live
# grant behind on a role that outlives it.

# Bootstrap creates this role; this stack only attaches to it. Looked up by
# name, exactly as infra/api/deploy.tf does and for the same reason: a
# `terraform_remote_state` data source would give this stack read access to the
# whole of bootstrap's state — including the account id and every output — to
# learn one string it already knows. The coupling is a naming convention, not a
# wire.
#
# Bootstrap is already applied before this stack (this stack's state lives in
# bootstrap's bucket), and if it somehow were not, this data source fails at
# plan time naming the missing role. `terraform validate` never reads data
# sources, so CI still validates this stack without an AWS call.
data "aws_iam_role" "github_actions" {
  name = "cumulo-github-actions"
}

data "aws_iam_policy_document" "github_actions_deploy" {
  # `aws s3 sync` lists the destination to work out what changed, so the list
  # grant is on the bucket itself rather than its contents — the two are
  # different ARNs and this is the one place that distinction bites.
  statement {
    sid       = "ListWebBucket"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.web.arn]
  }

  # The content push. `--delete` on the sync is what needs DeleteObject: a build
  # that drops a hashed asset must not leave the old one paying for storage
  # forever.
  #
  # Deliberately absent: `s3:GetObject`. `aws s3 sync` diffs on the listing's
  # size and mtime, never on object bodies, so the workflow can write the bucket
  # without being able to read it back — and a compromised CI run cannot exfil
  # the origin, only overwrite it with something the next deploy replaces. Also
  # absent is anything that could change the bucket itself: no
  # PutBucketPolicy, no PutBucketPublicAccessBlock, no DeleteBucket. Those stay
  # reviewable diffs in this directory.
  statement {
    sid = "PublishWebContent"
    actions = [
      "s3:PutObject",
      "s3:DeleteObject",
    ]
    resources = ["${aws_s3_bucket.web.arn}/*"]
  }

  # The cache flush after a push, and the waiter that makes the job honest.
  # `GetInvalidation` is what `aws cloudfront wait invalidation-completed`
  # polls, so the run cannot go green while the edge is still serving the
  # previous build.
  #
  # Deliberately absent: `cloudfront:UpdateDistribution` (and every other
  # mutating call on the distribution). CI ships content; every distribution
  # setting — the origin, the cache behaviour, the error responses, the price
  # class — stays a reviewable `.tf` diff that no workflow can move out from
  # under Terraform. Same rule as infra/api/deploy.tf's refusal of
  # `lambda:UpdateFunctionConfiguration`.
  statement {
    sid = "InvalidateWebCache"
    actions = [
      "cloudfront:CreateInvalidation",
      "cloudfront:GetInvalidation",
    ]
    resources = [aws_cloudfront_distribution.web.arn]
  }
}

resource "aws_iam_role_policy" "github_actions_deploy" {
  # The environment suffix is in the *policy* name, not just the resources it
  # grants on, because the role is shared and this stack is not a singleton:
  # applying the web stack a second time with `environment = "staging"` must add
  # a second inline policy rather than silently overwrite the first one and
  # leave the dev demo undeployable.
  name = "cumulo-web-deploy-${var.environment}"

  role   = data.aws_iam_role.github_actions.name
  policy = data.aws_iam_policy_document.github_actions_deploy.json
}
