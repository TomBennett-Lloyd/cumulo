# The public edge: one API Gateway **HTTP** API, one `$default` stage, one proxy
# integration, one catch-all route.
#
# ADR 0005 chose this over a Lambda function URL — which is six times cheaper
# per request and needs no second resource — for exactly one property: a rate
# ceiling that is not a concurrency ceiling. `default_route_settings` below is
# that property, and it was the whole of the abuse posture #14 shipped. #29 adds
# the second gateway layer: a tighter per-route throttle on the three writes.
# Read ADR 0005 and ADR 0006 before changing anything in this file; the numbers
# in them are the ones the worst-case bill is computed from.

resource "aws_apigatewayv2_api" "api" {
  name          = "cumulo-api-${var.environment}"
  protocol_type = "HTTP"

  description = "Cumulo fleet API: sites CRUD, per-site forecast and series reads, OpenAPI document and Swagger UI. All routes are served by one Lambda (ADR 0005)."

  # CORS is gateway configuration rather than response-header code in every
  # handler — one of the things the gateway buys over a bare function URL, and
  # the reason no handler in apps/api sets an Access-Control-* header.
  cors_configuration {
    # Wide open, deliberately and temporarily. There is no real web origin to
    # allow yet: #21 owns the domain, and until it lands the demo is served from
    # whatever host the operator or a reviewer happens to use. **Tightening this
    # to the real origin is #21's, and per-route/per-IP limiting is #29's** —
    # ADR 0005 draws that boundary explicitly and this comment is the marker it
    # asked for. `allow_credentials` stays false, which is not optional
    # alongside `*`: the two together are rejected by every browser, and the API
    # is anonymous by design (ADR 0001) so there is nothing to send.
    allow_origins = ["*"]

    # The four methods the route table uses, plus OPTIONS. The gateway answers
    # preflight itself once this block exists, so OPTIONS never reaches the
    # Lambda — it is listed because a method absent from this list is a method
    # the browser is told it may not use.
    allow_methods = ["GET", "POST", "PUT", "DELETE", "OPTIONS"]

    # `content-type` is required rather than tidy: `application/json` is not a
    # CORS-safelisted Content-Type value, so without it every POST and PUT from
    # a browser fails preflight while curl keeps working — the failure that
    # looks like a broken client.
    allow_headers = ["content-type"]

    # Ten minutes of preflight caching. Every preflight is a billed gateway
    # request in its own right (ADR 0005: the Swagger page is already the
    # request-hungry one), so this is a cost line as much as a latency one.
    max_age = 600
  }
}

# One integration for the whole API. AWS_PROXY hands the request to the function
# untouched, which is what lets the route table live in TypeScript where it can
# be unit-tested, instead of being split between HCL and code.
resource "aws_apigatewayv2_integration" "api" {
  api_id           = aws_apigatewayv2_api.api.id
  integration_type = "AWS_PROXY"
  integration_uri  = aws_lambda_function.api.invoke_arn

  # Payload format 2.0, and apps/api parses exactly this shape: its
  # gateway-event schema reads `rawPath`, `requestContext.http.method`, `body`,
  # `isBase64Encoded`, `queryStringParameters` and `headers`. Dropping to 1.0
  # would move `rawPath` to `path` and `requestContext.http.method` to
  # `httpMethod`, so the two numbers are a contract between this line and that
  # schema — the failure mode is every request 400ing on an unparseable event.
  payload_format_version = "2.0"

  # No `timeout_milliseconds`: the default is the 30 s maximum, and lambda.tf
  # deliberately sits the function's own timeout below it so a hung request
  # fails as a Lambda timeout with a log line rather than as a bare gateway 504.
}

# `$default` — the catch-all, and still the route that serves the API. The route
# table is in apps/api/src/main.ts (matched by apps/api/src/http/router.ts),
# where it is unit-tested and where an unknown path returns the same
# `apiErrorSchema`-shaped 404 as an unknown site does. Declaring all ten routes
# here as well would put the same list in two places with nothing checking they
# agree, and would hand unmatched paths to the gateway's own untyped 404
# instead.
#
# The three writes below are the deliberate exception, and they are declared for
# one reason only: `route_settings` on the stage is keyed by route key, and a
# key that is not a declared route is a setting for a route the gateway does not
# have. They target the same integration, so declaring them changes nothing
# about how a request is served — the same Lambda, the same TypeScript route
# table, the same 404 — it only makes the per-route throttle addressable.
resource "aws_apigatewayv2_route" "default" {
  api_id    = aws_apigatewayv2_api.api.id
  route_key = "$default"
  target    = "integrations/${aws_apigatewayv2_integration.api.id}"

  # No authorizer. The demo is anonymous on purpose (ADR 0001); auth is #30.
}

locals {
  # The three unauthenticated write routes, as API Gateway route keys:
  # "<METHOD> <path>", with path parameters in braces. These strings are a
  # contract with the route table in apps/api/src/main.ts — same methods, same
  # paths, `{siteId}` where that table has `{ param: siteIdParamName }`.
  #
  # Both ways of breaking that contract fail the same way — silently, by the
  # request falling through to `$default` at the stage's 10/20 instead of
  # matching here at 2/4 — and neither is an error anywhere:
  #
  #   * A key that names no real path never matches, so the throttle protects
  #     nothing. That is the first thing to check if a write stops being
  #     rate-limited.
  #   * Gateway matching is exact on the literal segments, and a router that
  #     normalises paths is not — so a spelling the gateway does not recognise
  #     but the router accepts (a trailing slash, a doubled separator) reaches
  #     the handler with the stage limit rather than this one, which is a
  #     bypass, not a 404. The two halves therefore have to agree on what a path
  #     is: `apps/api/src/http/router.ts` must reject non-canonical paths rather
  #     than normalise them, and that requirement exists because of this block.
  #     Reintroducing normalisation there reopens the hole here, in a file the
  #     change would not touch.
  #
  # One list, used twice below — by the route resources and by the stage's
  # `route_settings` — so the declared routes and the throttled routes cannot
  # drift apart.
  write_route_keys = toset([
    "POST /v1/sites",
    "PUT /v1/sites/{siteId}",
    "DELETE /v1/sites/{siteId}",
  ])
}

# A declared route wins over `$default`: API Gateway matches the most specific
# route key, so these three take precedence and everything else — the reads, the
# OpenAPI document, the Swagger UI and its assets, and every unknown path —
# keeps falling through to the catch-all above.
resource "aws_apigatewayv2_route" "write" {
  for_each = local.write_route_keys

  api_id    = aws_apigatewayv2_api.api.id
  route_key = each.value
  target    = "integrations/${aws_apigatewayv2_integration.api.id}"

  # No authorizer here either, for the same reason (ADR 0001). These routes are
  # public by design; what bounds them is the throttle on the stage, the per-IP
  # limiter in apps/api, and the site cap — the four layers ADR 0006 records.
}

resource "aws_apigatewayv2_stage" "default" {
  api_id = aws_apigatewayv2_api.api.id

  # `$default` is the stage whose name does not appear in the URL, so the
  # endpoint is https://<api-id>.execute-api.<region>.amazonaws.com/v1/sites
  # rather than .../<stage>/v1/sites. That keeps the paths the OpenAPI document
  # declares identical to the paths the deployed API serves — a stage prefix
  # would make every documented path wrong by one segment.
  name = "$default"

  # Deploy on change. Without this a route or integration change applies to the
  # configuration and never reaches traffic until somebody creates a deployment
  # by hand — a stack that looks applied and is not.
  auto_deploy = true

  # ---------------------------------------------------------------------------
  # THE COST GUARD. Do not remove or raise without re-reading ADR 0005.
  # ---------------------------------------------------------------------------
  # A token bucket: 10 requests/second sustained, 20 in a burst above it,
  # expressed independently of concurrency. The write endpoint is
  # unauthenticated by design and its URL is printed in a README, so what bounds
  # the bill is not the expected traffic but this ceiling. Held at the ceiling
  # continuously for a 30-day month it is 25.92M requests ≈ $36 — roughly a
  # third of the ~$100/month ceiling, forever, under continuous abuse. Delete
  # these two lines and that bound is gone silently; the bootstrap stack's
  # budget alarm is the only backstop left.
  #
  # It is a *cost* control that looks like an abuse control, and ADR 0005 says
  # so: one caller consuming the full 10 rps 429s everybody else. Per-IP
  # limiting and the site-cap counter live in apps/api (#29); the per-route
  # overrides ADR 0005 pre-declared are the block below.
  default_route_settings {
    throttling_rate_limit  = 10
    throttling_burst_limit = 20
  }

  # ---------------------------------------------------------------------------
  # THE WRITE THROTTLE (#29, ADR 0006 layer 2). Five times tighter than the
  # stage ceiling above, on the three routes that create state.
  # ---------------------------------------------------------------------------
  # A `route_settings` block overrides `default_route_settings` for one route
  # key, so on these three the bucket is 2 requests/second sustained, 4 in a
  # burst — reads and the docs pages keep the stage's 10/20. Two things follow
  # from the tighter number, and both are the point:
  #
  #   * It bounds the *write-route share* of the bill. Every limited request
  #     also costs an abuse-table write (the per-IP window counter in apps/api),
  #     and this caps how much of that traffic can be a write. It does not cap
  #     the abuse-table bill: ADR 0006 computes that from the stage ceiling's
  #     25.92M requests/month, correctly, because the limited-route list
  #     includes `GET /v1/sites/{siteId}/series` — a read, which keeps the
  #     stage's 10/20 and is metered by the limiter all the same. Anyone
  #     re-deriving that number from 2 rps will get a figure five times too
  #     small.
  #   * It bites before the stage limit on exactly these routes, which is what
  #     makes the layering observable: a POST flood 429s at 2 rps with the
  #     gateway's own (non-`ApiError`) body while a GET flood from the same
  #     client keeps going to 10 rps.
  #
  # 2 rps is generous for the intended traffic — the demo's add-a-site flow is
  # one POST per human decision — and it is deliberately above the per-IP
  # limiter's 30-per-60 s, so a single abusive IP meets the *application*
  # limiter (which can block it for an hour and returns a typed body) before it
  # meets this one. This layer is what stops many IPs from doing together what
  # one cannot do alone.
  dynamic "route_settings" {
    for_each = local.write_route_keys

    content {
      route_key              = route_settings.value
      throttling_rate_limit  = 2
      throttling_burst_limit = 4
    }
  }

  # No `access_log_settings`. Access logs with route keys are one of the things
  # ADR 0005 notes the gateway makes available to #29; #29 chose the application
  # limiter instead, and turning these on would bill CloudWatch ingestion for a
  # log nothing reads, on the stack whose whole argument is that nothing bills
  # for existing.

  # The stage references only the API, so nothing in the configuration above
  # tells Terraform the routes must exist first — yet `route_settings` is keyed
  # by route key, and settings written before their route is a stage configured
  # for routes the API does not have. Ordering it explicitly costs nothing and
  # removes the question.
  depends_on = [aws_apigatewayv2_route.write]
}

# API Gateway invoking a function is a resource policy on the *function*, not a
# grant on the API. Without this every request returns 500 with an
# "Internal Server Error" the function never saw.
resource "aws_lambda_permission" "api_gateway" {
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.api.function_name
  principal     = "apigateway.amazonaws.com"

  # Scoped to this API rather than left open to the service: without
  # source_arn, any API Gateway in any account could invoke this function. The
  # wildcards cover the stage and the method/path, which are exactly the parts
  # that vary per request — `execution_arn` already pins the API id, which is
  # the part that identifies *this* gateway.
  source_arn = "${aws_apigatewayv2_api.api.execution_arn}/*/*"
}
