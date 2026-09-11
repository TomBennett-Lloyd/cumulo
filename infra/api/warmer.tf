# The warmer (#473). Every real visitor arrives at an idle function, so the
# first paint of the demo is a cold start — p99 2.96 s against a warm p50 of
# 54 ms, on an endpoint whose organic traffic is zero, measured over the 30 days
# to 2026-08-24 and recorded in #473. This is the clock that keeps two execution
# environments alive so that nobody's first request is the one that pays for
# them. The 54 ms is a tuned input as well as a symptom — the ledger at the foot
# of this header says which cost row is computed from it.
#
# It invokes the function **directly**. A scheduled HTTPS call through the
# gateway would be billed as a gateway request, counted by the `Count` metric
# the request-flood alarm watches (alarms.tf), and metered by the stage throttle
# — a warmer that spends the cost bound it is meant to sit under. A direct
# invoke touches none of the three.
#
# Two containers, not one. `apps/web/src/dashboard/Dashboard.tsx` calls
# `listSites` first, and `apps/web/src/dashboard/FleetPanel.tsx` gates its two
# `useFleetQuery` calls on the result (`const enabled = sites.length > 0`), so a
# visitor's first paint is one request followed by a concurrent pair. One warm
# environment covers the first request and leaves the pair to cold-start a
# second — which is why this rule carries two targets rather than one.
#
# ---------------------------------------------------------------------------
# Restatement ledger (`docs/standards/architecture.md` rule 9) for the values
# this file owns. A floor rather than a census: it lists what the sweep below
# found, and one more carrier extends it rather than falsifies it. Sweep, run
# 2026-09-11 from the repo root:
#
#   git grep -nE '192\.0\.2\.1|cumulo-warmer|17,?280|54 ms|cron\(0/5' -- :/
#
#   * **The cadence and the target count** — `schedule_expression` below and the
#     two `aws_cloudwatch_event_target` blocks are the owner. Every monthly
#     figure anywhere is computed from that pair and from nothing else.
#     - `infra/README.md`, api cost table, the "warmer's arithmetic" bullet —
#       *computing*: `12 × 2 × 24 × 30 = 17,280` is derived there, and it is the
#       one site that shows the derivation.
#     - `infra/README.md`, api cost table — the Lambda invocations, Lambda
#       compute and DynamoDB reads rows, the paragraph above the table, and the
#       "meaning of idle" note under it: *asserting*, each carrying the derived
#       17,280 or the ≈ $0.005/month it drives.
#     - `infra/README.md`, storage cost table — the "everything else" row, the
#       standing-bill paragraph, and the ingestion teardown bullet that contrasts
#       the two scheduled stacks: *asserting*, the same two figures.
#     - `infra/api/outputs.tf` — the CloudWatch-logs and Lambda-invocations
#       bullets of the cost commentary: *asserting*, the same 17,280.
#     - `infra/README.md`, api runbook step B3 — *asserting* the five resources
#       this file declares (`Plan: 20 to add`). That is the resource count
#       rather than the cadence, but it moves for the same reason: a third
#       target changes both, as does the `cron(0/5 * * * ? *)` readback in B7.
#   * **The warm `GET /v1/sites` latency, 54 ms** — measured over the 30 days to
#     2026-08-24, recorded in #473, restated in the first paragraph above.
#     Carried by `infra/README.md`'s Lambda compute row, which is *computing*:
#     ≈ 233 GB-s is `17,280 × 0.25 GB × 54 ms`. Re-measure the latency and that
#     row is re-derived in the same change.
#   * **The payload's markers, `192.0.2.1` and `cumulo-warmer`** — the `locals`
#     below are the owner. Carried by `infra/README.md`'s B3 payload readback
#     (*asserting*: it tells the operator what the plan must show) and by B7's
#     note on what the log group cannot separate (*arguing*: the markers are
#     what it says identify an invocation to a reader).
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_event_rule" "warmer" {
  name = "cumulo-api-warmer-${var.environment}"

  # Every five minutes, around the clock. A cron expression rather than
  # `rate(5 minutes)`: `rate` anchors its first tick to the moment the rule was
  # created, so the tick times move on every re-create and a log line cannot be
  # matched to a tick. This fires at :00, :05, :10 and so on, always.
  #
  # `infra/ingestion/schedule.tf` steps its schedule off the top of the hour on
  # purpose, and that reasoning deliberately does not transfer here: it is
  # avoiding a herd on Open-Meteo's shared per-minute ceiling, and nothing on
  # this path calls Open-Meteo or spends any quota shared outside this account.
  #
  # 24/7 rather than plausible viewing hours. Restricting the window would halve
  # an invocation count that is already a low single-digit percentage of an
  # allowance, in exchange for the demo being cold for whichever reader opens
  # the link at 03:00 — which is the entire failure this ticket describes.
  schedule_expression = "cron(0/5 * * * ? *)"

  description = "Keeps two cumulo-api-${var.environment} execution environments warm by invoking GET /v1/sites directly every five minutes (#473). Never reaches the HTTP API."
}

locals {
  # RFC 5737 TEST-NET-1, reserved for documentation and never routable, so this
  # address cannot collide with a visitor's. It is the payload's marker: an
  # operator who sees it knows the invocation was synthetic.
  #
  # It also keeps the warmer out of anyone else's limiter bucket. `GET /v1/sites`
  # is deliberately unlimited today — the route table in `apps/api/src/main.ts`
  # says which routes are limited and why — so nothing reads this yet; a later
  # ticket that limited the route would otherwise have the warmer spending a
  # real caller's window.
  warmer_source_ip = "192.0.2.1"

  # An API Gateway HTTP API payload-v2 event, carrying exactly the fields
  # `parseGatewayEvent` in `apps/api/src/http/gateway-event.ts` requires:
  # `rawPath`, `requestContext.http.method`, `requestContext.http.sourceIp` and
  # `requestContext.domainName`. The absent-able fields — `body`,
  # `queryStringParameters`, `isBase64Encoded` — are omitted, which that schema
  # tolerates by design.
  #
  # `GET /v1/sites` is the route because it is the request a visitor actually
  # makes first, it costs one Query, and it is the one that opens the DynamoDB
  # connection every later handler reuses — `/openapi.json` would warm the
  # runtime and leave that connection cold.
  #
  # `rawPath` is a code↔Terraform mirror, and the gate cannot hold it — stated
  # here rather than left to be discovered, per `docs/standards/architecture.md`
  # rule 8. The route lives in `apps/api/src/main.ts` as an inline
  # `segments: ['v1', 'sites']` entry in the `routes` array, and
  # `.claude/scripts/check-infra-mirrors.sh`'s `str-eq` mode reads a Terraform
  # *resource attribute* against an `export const NAME = '<text>';` — neither
  # side has that shape, and this one is inside a `jsonencode` in a `locals`
  # block, which the gate's reader does not address at all. Making it
  # declarable would mean exporting a path constant from the API purely so
  # infrastructure could compare against it, which is application code shaped by
  # a gate rather than by the service. So the drift is real and unmechanised:
  # rename the route and the warmer keeps working — a 404 still warms the
  # runtime — but stops opening the DynamoDB connection, which is the half of
  # the job it is here for, and nothing goes red. What catches it is a human
  # step rather than a gate: the runbook's B7 in `infra/README.md` replays this
  # very payload through a *synchronous* `aws lambda invoke` and reads the
  # status out of the response body, which is the one thing the rule's own
  # asynchronous ticks cannot report. Re-run that step after any change to the
  # route table.
  # **There is no `origin` header, and that is a decision.** The write routes are
  # guarded by `checkWriteOrigin` (ADR 0006), so this payload repointed at
  # `POST /v1/sites` would be refused rather than admitted: the warmer cannot
  # become a way around the origin check even by accident. `user-agent` carries
  # no meaning to the handler — only `origin` is surfaced from `headers` — and
  # is here as the second half of the payload's self-identification.
  warmer_event = jsonencode({
    rawPath = "/v1/sites"
    requestContext = {
      http = {
        method   = "GET"
        sourceIp = local.warmer_source_ip
      }
      # The stack's own endpoint with its scheme removed, which is what the
      # gateway sends and what `ownOrigin` is rebuilt from. Derived rather than
      # written down: the api id is server-assigned at create time (ADR 0005),
      # so any literal here would be a guess that survived until the first
      # re-create.
      domainName = trimprefix(aws_apigatewayv2_api.api.api_endpoint, "https://")
    }
    headers = {
      "user-agent" = "cumulo-warmer"
    }
  })
}

# Two targets, one rule, one tick. The alternative — two schedules a few seconds
# apart — does not work, and the reason is Lambda's container reuse: an
# invocation is routed to an idle warm environment whenever one exists, and a
# warm `GET /v1/sites` returns in ~54 ms, so a second invocation seconds later
# lands back in the first environment and exactly one container stays warm.
# Simultaneity is the mechanism, not repetition. EventBridge dispatches a rule's
# targets in parallel, so both invocations are in flight together and the second
# has to be given an environment of its own.
#
# The residual, stated rather than assumed: parallel dispatch is a property of
# EventBridge, not a scheduling guarantee from Lambda, and two asynchronous
# deliveries can in principle be serialised in its queue. When that happens the
# tick refreshes one environment instead of two; the next tick is the retry, and
# the check that says which happened is the `count_distinct(@logStream)` query
# in this stack's runbook (infra/README.md).
resource "aws_cloudwatch_event_target" "warmer_first" {
  rule      = aws_cloudwatch_event_rule.warmer.name
  target_id = "warm-first"
  arn       = aws_lambda_function.api.arn
  input     = local.warmer_event
}

resource "aws_cloudwatch_event_target" "warmer_second" {
  rule      = aws_cloudwatch_event_rule.warmer.name
  target_id = "warm-second"
  arn       = aws_lambda_function.api.arn
  input     = local.warmer_event
}

# EventBridge invoking a function is a resource policy on the *function*, not a
# grant on the rule — the same shape as `infra/ingestion/schedule.tf`'s, and the
# same failure mode without it: the rule fires, EventBridge is refused, and the
# only evidence is the rule's FailedInvocations metric.
#
# This is also where least privilege lives for this schedule, and it is narrower
# than the alternative. EventBridge Scheduler would need an IAM role holding
# `lambda:InvokeFunction` — an assumable identity that exists whether or not a
# schedule is using it. A rule needs no principal at all beyond this policy,
# which names one service, one function and one `source_arn`, so no other rule
# in the account can reach this function through it and there is no role to
# hold. That, and the two-targets-per-rule shape above, is why this schedule is
# a rule rather than a Scheduler schedule; both are unpriced, so cost did not
# decide it.
resource "aws_lambda_permission" "warmer" {
  statement_id  = "AllowWarmerRuleInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.api.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.warmer.arn
}

# EventBridge invokes asynchronously, and Lambda's default async policy retries
# a failure twice. Zero retries here, for the reason ingestion's config gives
# and one this stack adds: a warmer ping that failed is worthless a minute later
# — the next tick is the retry — and leaving the default in place makes the
# invocation count "up to three per target per tick" rather than one, which is
# the number infra/README.md's warmer cost row is computed from.
#
# This config governs asynchronous invocations only. Every real request arrives
# synchronously from the HTTP API integration and is untouched by it.
resource "aws_lambda_function_event_invoke_config" "api" {
  function_name = aws_lambda_function.api.function_name

  maximum_retry_attempts = 0

  # 60 s, the API's minimum: an invocation still queued a minute after its tick
  # would warm a container the following tick is about to warm anyway.
  maximum_event_age_in_seconds = 60
}
