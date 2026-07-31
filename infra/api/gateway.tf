# The public edge: one API Gateway **HTTP** API, one `$default` stage, one proxy
# integration, one catch-all route.
#
# ADR 0005 chose this over a Lambda function URL — which is six times cheaper
# per request and needs no second resource — for exactly one property: a rate
# ceiling that is not a concurrency ceiling. `default_route_settings` below is
# that property, and it is the whole of the abuse posture #14 ships. Read the
# ADR before changing anything in this file; the numbers in it are the ones the
# worst-case bill is computed from.

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

# `$default` — one catch-all route, not seven declared ones. The route table is
# in apps/api/src/http/router.ts, where it is unit-tested and where an unknown
# path returns the same `apiErrorSchema`-shaped 404 as an unknown site does.
# Declaring the seven routes here as well would put the same list in two places
# with nothing checking they agree, and would hand unmatched paths to the
# gateway's own untyped 404 instead.
resource "aws_apigatewayv2_route" "default" {
  api_id    = aws_apigatewayv2_api.api.id
  route_key = "$default"
  target    = "integrations/${aws_apigatewayv2_integration.api.id}"

  # No authorizer. The demo is anonymous on purpose (ADR 0001); auth is #30.
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
  # limiting, per-route overrides on this same stage, and the site-cap counter
  # are #29's, not this ticket's.
  default_route_settings {
    throttling_rate_limit  = 10
    throttling_burst_limit = 20
  }

  # No `access_log_settings`. Access logs with route keys are one of the things
  # ADR 0005 notes the gateway makes available to #29; turning them on now would
  # bill CloudWatch ingestion for a log nothing reads, on the stack whose whole
  # argument is that nothing bills for existing.
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
