# The origin: a private bucket holding apps/web's production build. Nothing
# reaches it except CloudFront, and nothing writes to it except the deploy
# workflow (deploy.tf grants exactly that).

# Same pattern as infra/bootstrap/state.tf, for the same reason: the bucket name
# needs a globally-unique component, the account id supplies one
# deterministically, and reading it from the caller keeps the digits out of this
# public repository entirely (infra/README.md convention 7). No random suffix —
# a random name would have to be recorded somewhere outside Terraform to survive
# a teardown, and after a destroy/re-apply this name comes back identical, so
# the WEB_BUCKET_NAME repo variable stays correct across the cycle. (The
# distribution id and domain do not; see outputs.tf.)
data "aws_caller_identity" "current" {}

resource "aws_s3_bucket" "web" {
  bucket = "cumulo-web-${var.environment}-${data.aws_caller_identity.current.account_id}"

  # Unlike bootstrap's state bucket, this one holds nothing that cannot be
  # rebuilt: every object in it is a Vite build artefact that
  # `pnpm --filter @cumulo/web build` reproduces from a commit. So force_destroy
  # costs nothing and buys the thing CLAUDE.md requires — `terraform destroy`
  # completing on a non-empty bucket instead of stopping with BucketNotEmpty and
  # leaving the operator to empty it by hand.
  force_destroy = true
}

resource "aws_s3_bucket_public_access_block" "web" {
  bucket = aws_s3_bucket.web.id

  # All four on, unconditionally. The bucket is reached through CloudFront's
  # origin access control and nothing else; there is no static-website-hosting
  # endpoint here and no public read. This is what makes the bucket policy below
  # the *only* way in, which is in turn what makes the SourceArn condition on it
  # a real boundary rather than a decoration.
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

data "aws_iam_policy_document" "web_origin" {
  # The origin access control grant, and nothing else. CloudFront signs its
  # origin requests with SigV4 (cloudfront.tf) and presents itself as the
  # service principal; this statement is what accepts that signature.
  statement {
    sid     = "AllowCloudFrontOACRead"
    actions = ["s3:GetObject"]

    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }

    resources = ["${aws_s3_bucket.web.arn}/*"]

    # Without this condition the statement reads "any CloudFront distribution in
    # any AWS account may read this bucket" — the service principal is shared by
    # every customer's distributions, so it identifies the service, not the
    # caller. The SourceArn narrows it to this one distribution. Read from the
    # resource rather than assembled, which also keeps the account id the ARN
    # embeds out of this file.
    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.web.arn]
    }
  }

  # Deliberately absent: `s3:ListBucket`. CloudFront never needs it, and its
  # absence is load-bearing for the SPA rewrite — a bucket that does not grant
  # list answers a request for a missing key with 403 rather than 404, which is
  # why cloudfront.tf maps *both* codes to /index.html.
}

resource "aws_s3_bucket_policy" "web" {
  bucket = aws_s3_bucket.web.id
  policy = data.aws_iam_policy_document.web_origin.json
}

# Deliberately absent, and each for a reason rather than an oversight:
#
#   * No `aws_s3_bucket_versioning`. The objects here are build artefacts whose
#     history is the git history; versions would only accumulate storage and
#     make force_destroy do more work at teardown.
#   * No `aws_s3_bucket_server_side_encryption_configuration`. SSE-S3 (AES256)
#     has been the unconditional default for every new bucket since 2023, so the
#     resource would encode the default and then need maintaining. Bootstrap's
#     state bucket declares it explicitly because state is sensitive enough to
#     be worth stating; a public web build is not.
#   * No `aws_s3_bucket_logging`. Access logs to a second bucket bill for
#     storage forever to observe traffic that CloudFront's free metrics already
#     summarise. Nothing in this stack may bill for existing.
