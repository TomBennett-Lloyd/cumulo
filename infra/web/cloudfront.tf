# The CDN in front of the private origin bucket. One distribution, one origin,
# one behaviour, on CloudFront's own *.cloudfront.net domain — no aliases, no
# ACM certificate, no Route 53. Those are #21's, and the seam for them is
# commented on `viewer_certificate` below.

resource "aws_cloudfront_origin_access_control" "web" {
  name        = "cumulo-web-${var.environment}"
  description = "Signs CloudFront's origin requests to the cumulo-web-${var.environment} bucket, so the bucket can stay private."

  origin_access_control_origin_type = "s3"

  # `always` rather than `no-override`: nothing in front of this distribution
  # signs requests for it, so there is no caller-supplied Authorization header
  # to preserve, and "always" is the setting that makes the bucket's
  # public-access block survivable — an unsigned origin request would simply be
  # denied.
  signing_behavior = "always"
  signing_protocol = "sigv4"
}

# ASSUMPTION, unverifiable without AWS credentials: that the AWS-managed cache
# policy is named exactly `Managed-CachingOptimized`. `terraform validate` never
# reads a data source, so CI cannot check this — the first `terraform plan` an
# operator runs does, and fails loudly naming the policy it could not find
# ("no matching cache policy found"). If that happens, the fix is the name
# string here, read from
# `aws cloudfront list-cache-policies --type managed`; nothing else in this file
# changes.
#
# The managed policy rather than a hand-written one because the issue explicitly
# excludes cache tuning, and because its behaviour is exactly right for a
# content-hashed Vite build: gzip/brotli enabled, and the cache key is the path
# only — no query strings, no cookies, no headers.
data "aws_cloudfront_cache_policy" "caching_optimized" {
  name = "Managed-CachingOptimized"
}

resource "aws_cloudfront_distribution" "web" {
  comment = "cumulo-web-${var.environment} — SPA only, see the constraint in infra/web/cloudfront.tf"

  # ---------------------------------------------------------------------------
  # SPA ONLY. Never add an API origin or behavior here.
  #
  # The API's per-IP rate limiter reads `requestContext.http.sourceIp` (ADR
  # 0006) — the direct TCP peer. Behind CloudFront that becomes the edge
  # location's address, so every visitor served by one POP would share a single
  # identity: 30 requests/minute across all of them would trip the limiter and
  # auto-block the whole POP for an hour. The demo's browser therefore calls the
  # API Gateway URL directly, cross-origin, and this distribution serves static
  # files and nothing else.
  #
  # If #21 wants the API behind the CDN (for WAF, or to collapse the origins
  # under one domain), the limiter's identity source moves to the
  # leftmost-untrusted `x-forwarded-for` hop with a stated trust boundary
  # *first*. That is a change to apps/api and to ADR 0006, not a change here.
  # ---------------------------------------------------------------------------
  origin {
    domain_name              = aws_s3_bucket.web.bucket_regional_domain_name
    origin_id                = aws_s3_bucket.web.id
    origin_access_control_id = aws_cloudfront_origin_access_control.web.id
  }

  enabled             = true
  is_ipv6_enabled     = true
  default_root_object = "index.html"

  # The cheapest class: North America and Europe edges only. Viewers elsewhere
  # are still served, from the nearest included edge, at a higher latency and a
  # lower price. For a portfolio demo that is the right trade, and it is the
  # only price lever on a distribution that otherwise has no standing cost.
  price_class = "PriceClass_100"

  default_cache_behavior {
    target_origin_id = aws_s3_bucket.web.id

    # A static SPA reads; it never writes to its own origin. Every write in this
    # product goes to the API Gateway URL directly (see the constraint above),
    # so the method list here is the whole truth rather than a restriction.
    allowed_methods = ["GET", "HEAD"]
    cached_methods  = ["GET", "HEAD"]

    # Not `https-only`: a bare http:// URL should still reach the demo. The
    # redirect costs one round trip and is what makes a pasted link work.
    viewer_protocol_policy = "redirect-to-https"

    cache_policy_id = data.aws_cloudfront_cache_policy.caching_optimized.id

    # Compression at the edge, not in the bucket: the objects are stored once,
    # uncompressed, and CloudFront negotiates gzip/brotli per request. This is
    # most of the transfer saving on a JS bundle.
    compress = true
  }

  # The SPA rewrite. Both codes, deliberately:
  #
  #   * 404 is what S3 answers for a missing key when the caller may list.
  #   * 403 is what it answers when the caller may *not* list — which is this
  #     bucket, because s3.tf grants `s3:GetObject` and nothing else. So 403 is
  #     in practice the code a client-side route like /sites/abc produces, and
  #     mapping only 404 would ship a distribution that 403s on every deep link.
  #
  # Both rewrite to /index.html with a 200, because the SPA's router is the
  # thing that decides whether the path is real, and it cannot decide anything
  # from inside an error page.
  #
  # What is NOT rewritten is the browser's URL: the path and its query string —
  # `?site=<id>` — are untouched by this, and the app reads `location.search`
  # client-side after the shell loads. So no query-string forwarding to the
  # origin is needed, which is exactly as well: Managed-CachingOptimized
  # deliberately excludes query strings from the cache key (one cached copy of
  # index.html serves every `?site=` value), and S3 ignores them anyway.
  #
  # error_caching_min_ttl = 0 so a 403 cached during a broken deploy does not
  # outlive the deploy that fixed it.
  custom_error_response {
    error_code            = 403
    response_code         = 200
    response_page_path    = "/index.html"
    error_caching_min_ttl = 0
  }

  custom_error_response {
    error_code            = 404
    response_code         = 200
    response_page_path    = "/index.html"
    error_caching_min_ttl = 0
  }

  restrictions {
    geo_restriction {
      # Nothing to restrict: the demo is a public portfolio artefact and the
      # abuse surface is the API, which is not behind this distribution at all.
      restriction_type = "none"
    }
  }

  # The #21 seam. This distribution answers on its assigned
  # <id>.cloudfront.net domain, served by CloudFront's own certificate, so
  # there is no ACM resource, no DNS, and no cost here.
  #
  # Adding the custom domain later is additive and local: `aliases = [...]` on
  # this resource, an `acm_certificate_arn` in place of
  # `cloudfront_default_certificate` (plus `minimum_protocol_version` and
  # `ssl_support_method = "sni-only"`), an `aws_acm_certificate` that must be
  # issued in **us-east-1** regardless of var.aws_region — CloudFront reads
  # certificates from that region only, so it needs a second `provider "aws"`
  # with an alias — and the Route 53 records. Nothing else in this stack
  # changes: not the bucket, not the OAC, not the deploy grant, not the outputs.
  # #21 also owns tightening infra/api/gateway.tf's CORS from `*` to the real
  # origins, which is why that is untouched here.
  viewer_certificate {
    cloudfront_default_certificate = true
  }

  # Deliberately absent: `logging_config` (standard access logs bill S3 storage
  # forever), `web_acl_id` (WAF has a standing monthly charge per web ACL, and
  # is entangled with the limiter-identity constraint above), and any
  # `ordered_cache_behavior` (one behaviour, one origin — see the constraint).
}
