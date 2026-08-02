# Two of these four values are server-assigned and must be captured after an
# apply rather than predicted: the distribution id and the domain name in
# `cloudfront_url` are allocated by CloudFront at create time, exactly as ADR
# 0005 says of the API's endpoint. They also do not survive a destroy/re-apply —
# a rebuilt distribution gets a new id and a new domain — so any teardown cycle
# has to re-publish WEB_DISTRIBUTION_ID and revisit the `web_origins` value in
# infra/api. `bucket_name` is the exception: it is deterministic (convention 3),
# so it comes back identical.
#
# `bucket_name` embeds the AWS account id. Per infra/README.md convention 7 do
# not paste raw output into committed files, PR bodies, or issue comments —
# quote the shape (`cumulo-web-dev-<account-id>`), not the digits. Publish it to
# the repo variable from the output itself:
#
#   gh variable set WEB_BUCKET_NAME --body "$(terraform output -raw bucket_name)"
#
# The other three contain no account digits and are safe to quote. It is not
# marked `sensitive`: the account id is an identifier rather than a credential,
# and marking it would only push every consumer to `-raw` while protecting
# nothing.
#
# ---------------------------------------------------------------------------
# IDLE COST: ≈$0/month — the one line that bills for existing is the stored
# build (~1.7 MB of S3, ~$0.00004/month). Nothing else here has a price for
# merely existing.
# ---------------------------------------------------------------------------
#   * S3 storage — the whole production build is ~1.7 MB, which at $0.023/GB-mo
#     is about $0.00004/month. It rounds to zero and would still round to zero
#     a hundred deploys from now, because each deploy replaces the objects
#     rather than adding to them (`sync --delete`, and no versioning).
#   * S3 requests — a few dozen PUTs per deploy, and GETs only on a CloudFront
#     cache miss. Both are billed per 1,000 and both are noise at this volume.
#   * CloudFront — no hourly rate, no per-distribution charge, nothing for the
#     origin access control. Serving is inside the **always-free** tier:
#     1 TB of data transfer out and 10,000,000 requests per month, plus 1,000
#     invalidation paths per month. That tier is permanent, not a 12-month
#     trial — which matters here, because it is the one this demo actually
#     lives in. (Verified against https://aws.amazon.com/cloudfront/pricing/
#     pay-as-you-go/ on 2026-08-02. Note that the headline pricing page now
#     leads with CloudFront *flat-rate plans* — a $0/month "Free" plan capped at
#     100 GB and 1M requests, and paid tiers above it. Those are opt-in per
#     distribution, subscribed from the console; a distribution created by this
#     API-driven Terraform stays on pay-as-you-go and therefore on the larger
#     always-free allowances quoted above. Do not "upgrade" this distribution to
#     the Free plan: it would *lower* the allowance and force a WAF web ACL
#     onto it.)
#   * Invalidations — the deploy workflow issues one `/*`, which counts as a
#     single path, so a deploy every working day stays inside 1,000/month with
#     two orders of magnitude to spare.
#   * CloudWatch — this stack adds **no alarms**. The always-free ten are fully
#     allocated (see the alarm budget in infra/README.md), and CloudFront's own
#     metrics are free.
#
# The worst case is bounded rather than free, and this stack is the honest
# exception to how the others are bounded: there is no CloudFront analogue of
# the API's stage throttle, so a hot-linked or hammered distribution keeps
# serving and bills roughly $0.085/GB (Europe and North America) past the free
# terabyte. The backstop is the bootstrap stack's budget alarm, not a limit in
# this directory. `terraform destroy` takes everything to $0 — force_destroy
# handles the non-empty bucket, and the distribution takes several minutes to
# disable and delete.

output "cloudfront_url" {
  description = "Base URL of the deployed demo — https://<distribution-id>.cloudfront.net. Server-assigned, so capture it from here after an apply rather than predicting it. This is the value that goes into infra/api's `web_origins` (as a bare origin, no trailing slash) so the API's origin check admits the demo's writes."
  value       = "https://${aws_cloudfront_distribution.web.domain_name}"
}

output "distribution_id" {
  description = "Id of the distribution, for the WEB_DISTRIBUTION_ID repo variable that deploy-web.yml invalidates against. Contains no account digits. Server-assigned and not stable across a destroy/re-apply — re-publish the variable after any teardown cycle."
  value       = aws_cloudfront_distribution.web.id
}

output "bucket_name" {
  description = "Name of the origin bucket, for the WEB_BUCKET_NAME repo variable the deploy workflow syncs into. Embeds the account id — see the convention 7 note above; publish it from this output, never by pasting the value. Deterministic, so unlike the distribution id it survives a destroy/re-apply unchanged."
  value       = aws_s3_bucket.web.bucket
}

output "environment" {
  description = "Environment suffix this stack was applied with (echoes var.environment). Unlike the api and storage stacks this one has no cross-stack requirement to match — nothing here reads another stack's resources — but keeping it aligned is what lets a teardown reason about one environment at a time."
  value       = var.environment
}
