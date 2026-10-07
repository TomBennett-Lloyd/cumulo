# The cost guard (ADR 0010, #588). The ~$100/month ceiling (CLAUDE.md) is held
# by reacting to measured cost rather than by a low rate ceiling: the stage
# throttle in gateway.tf stays at its capacity cap, and the stage is set to zero
# only when spend says so. Read ADR 0010 before changing a number here — it
# carries the bound these numbers produce and the premises it rests on.
#
# Two ways to trip, one function that trips:
#
#   * the COMPOSITE — `cost-anomaly-held` AND `cost-burn-rate`, each in ALARM
#     for 20 of the last 24 hourly datapoints. A composite alarm has no hold of
#     its own, so the hold is on each child; the two holds overlap in at least
#     20 + 20 − 24 = 16 hours, not necessarily the same 20.
#   * the BILLING alarm — `AWS/Billing EstimatedCharges` above the billing
#     trip. Billing metrics exist only in us-east-1 and a composite reads alarms
#     in its own Region, so this leg is a second input to the same function, via
#     a us-east-1 topic, rather than an `OR` in the composite's rule. It is the
#     leg the ceiling's bound rests on; the composite only trips earlier.
#
# Both invoke `cumulo-api-cost-trip-<env>` (apps/api/src/cost-trip), which zeroes
# the stage's default throttle and every route override. Reset is manual and is
# a runbook step (infra/README.md, api stack): an apply of this stack restores
# gateway.tf's values — so ANY apply of this stack resets a trip — and the three
# trip alarms are then forced to OK so that one still breaching fires again.
#
# ---------------------------------------------------------------------------
# Restatement ledger (`docs/standards/architecture.md` rule 9) for the values
# this file owns. A floor rather than a census: what this sweep found, run
# 2026-10-07 from the repo root —
#
#   git grep -nE 'cost-trip|cost guard|7\.31|19,0[0-9]{2}|billing trip|\$70' -- ':!docs/tech-debt.md' ':!docs/review-feedback.md'
#
#   * `worst_case_usd_per_request` and its terms — ADR 0010 (Decision, the
#     table it is derived in); infra/README.md's api cost section.
#   * `billing_trip_usd` — ADR 0010 (the bound); infra/README.md (runbook,
#     cost); outputs.tf's closing worst-case note.
#   * the five alarms' prices — outputs.tf's IDLE COST banner;
#     infra/README.md's alarm budget, which owns the count.
#   * `monthly_ceiling_usd` — restates infra/bootstrap/budget.tf's
#     `limit_amount = "100"`, which restates CLAUDE.md's hard constraint. The
#     two Terraform figures move together or the burn projection and the budget
#     disagree about what "over" means.
#   * the 20-of-24 hold — ADR 0010; infra/README.md's runbook (reset section).
# ---------------------------------------------------------------------------

locals {
  # ---------------------------------------------------------------------------
  # The worst-case cost of one request, in US dollars per MILLION requests,
  # eu-west-1 list prices (the rates ADR 0005's and ADR 0006's Amendments
  # record). The burn-rate alarm multiplies every request by this figure, so it
  # projects as if all traffic were the priced request.
  #
  # The priced request is the maximum-width series read,
  # `GET /v1/sites/{siteId}/series` over the 336-hour span cap — ~1,000 items of
  # ~250 B, ≈ 30 eventually-consistent read units (ADR 0005, Consequences).
  # **It is the heaviest request only once #506 lands**, serving
  # `GET /v1/fleet/actuals` from the `#FLEET` roll-up instead of fanning out per
  # site (≈ 300 RRU at the 100-site fleet today) — an owner decision, 2026-10-07.
  # #506 is therefore a carrier of this figure. Even then two reads exceed it at
  # the fleet's 52-location ceiling (`packages/shared/src/site.ts`): the
  # roll-up's 168-hour actuals read, ≈ 270 RRU, and `GET /v1/fleet/forecast`,
  # ≈ 78 RRU. Traffic concentrated on those is under-counted here and is caught
  # by the billing leg, which ADR 0010's bound is computed on.
  # ---------------------------------------------------------------------------
  cost_guard_read_units = 30

  # Lambda duration for that request. Unmeasured for the series read itself;
  # the one measured single-Query route is `GET /v1/sites` at 54 ms warm p50
  # (#473, warmer.tf), and a series read returns ~250 KB rather than a few — so
  # 200 ms is that measurement with the margin stated (owner: price it "at
  # slightly above its measured time").
  cost_guard_duration_seconds = 0.2

  cost_guard_usd_per_million = {
    gateway_request = 1.11
    lambda_request  = 0.20
    # GB × seconds × $16.6667 per million GB-seconds.
    lambda_compute = aws_lambda_function.api.memory_size / 1024 * local.cost_guard_duration_seconds * 16.6667
    series_read    = local.cost_guard_read_units * 0.1415
    # The series route is per-IP limited: one window write, one half-unit read.
    limiter = 0.705 + 0.07075
    # ~250 B per invocation (ADR 0005) at $0.57/GB.
    log_ingest = 250 * 0.57 / 1000
  }

  # ≈ $7.31 per million, so ≈ $0.0000073 per request.
  worst_case_usd_per_request = sum(values(local.cost_guard_usd_per_million)) / 1000000

  monthly_ceiling_usd = 100
  # ADR 0005's 30-day month.
  hours_per_month = 720
  # Actual month-to-date spend that trips the stage (owner decision D2,
  # 2026-10-07). ADR 0010 derives why $70 and not $80.
  billing_trip_usd = 70

  hold_hours           = 24
  hold_breaching_hours = 20

  # One definition of the request count both projections read: hourly, on the
  # API rather than the stage, for the reason alarms.tf's header gives.
  cost_guard_requests_metric = {
    namespace   = "AWS/ApiGateway"
    metric_name = "Count"
    period      = 3600
    stat        = "Sum"
    dimensions  = { ApiId = aws_apigatewayv2_api.api.id }
  }

  # The anomaly alarm twice (owner decision D1): `notice` emails within the hour
  # and trips nothing; `held` emails nothing and is the composite's input.
  cost_anomaly_alarms = {
    notice = { evaluation_periods = 1, datapoints_to_alarm = 1, notify = true }
    held   = { evaluation_periods = local.hold_hours, datapoints_to_alarm = local.hold_breaching_hours, notify = false }
  }

  cost_trip_function_name = "cumulo-api-cost-trip-${var.environment}"
  cost_trip_artifact_path = "${path.module}/../../apps/api/dist/cost-trip.zip"
}

# --- the projections ----------------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "cost_anomaly" {
  for_each = local.cost_anomaly_alarms

  alarm_name = "cumulo-api-${var.environment}-cost-anomaly${each.key == "held" ? "-held" : ""}"

  # A band two standard deviations wide around the model CloudWatch trains on
  # this metric. The metric is absent whenever the API is idle, so the model may
  # never train; this alarm then sits in INSUFFICIENT_DATA, the composite's AND
  # is never true, and only the billing leg can trip. The bound does not depend
  # on it (ADR 0010); the runbook's `describe-anomaly-detectors` readback says
  # which state it is in.
  comparison_operator = "GreaterThanUpperThreshold"
  threshold_metric_id = "band"
  evaluation_periods  = each.value.evaluation_periods
  datapoints_to_alarm = each.value.datapoints_to_alarm
  treat_missing_data  = "notBreaching"

  metric_query {
    id          = "band"
    expression  = "ANOMALY_DETECTION_BAND(requests, 2)"
    label       = "Expected requests per hour"
    return_data = true
  }

  metric_query {
    id          = "requests"
    return_data = true

    metric {
      namespace   = local.cost_guard_requests_metric.namespace
      metric_name = local.cost_guard_requests_metric.metric_name
      period      = local.cost_guard_requests_metric.period
      stat        = local.cost_guard_requests_metric.stat
      dimensions  = local.cost_guard_requests_metric.dimensions
    }
  }

  alarm_actions = each.value.notify ? [local.alerts_topic_arn] : []
  ok_actions    = each.value.notify ? [local.alerts_topic_arn] : []

  alarm_description = each.value.notify ? "Requests to the Cumulo fleet API this hour are above the band CloudWatch expects. Nothing is tripped by this alarm; the stage is tripped only if this persists for 20 of 24 hours alongside a projected month above $${local.monthly_ceiling_usd}, or if actual spend passes $${local.billing_trip_usd} (ADR 0010)." : "Input to cumulo-api-${var.environment}-cost-trip: request volume above the expected band for ${local.hold_breaching_hours} of the last ${local.hold_hours} hours. No actions of its own (ADR 0010)."
}

resource "aws_cloudwatch_metric_alarm" "cost_burn_rate" {
  alarm_name = "cumulo-api-${var.environment}-cost-burn-rate"

  # The hour's requests priced at the worst case and run on for a month:
  # above the ceiling at ≈ 19,000 requests/hour, with the figures above.
  comparison_operator = "GreaterThanThreshold"
  threshold           = local.monthly_ceiling_usd
  evaluation_periods  = local.hold_hours
  datapoints_to_alarm = local.hold_breaching_hours
  treat_missing_data  = "notBreaching"

  metric_query {
    id          = "projected"
    expression  = "requests * ${format("%.12f", local.worst_case_usd_per_request)} * ${local.hours_per_month}"
    label       = "Projected USD per month at this hour's rate"
    return_data = true
  }

  metric_query {
    id = "requests"

    metric {
      namespace   = local.cost_guard_requests_metric.namespace
      metric_name = local.cost_guard_requests_metric.metric_name
      period      = local.cost_guard_requests_metric.period
      stat        = local.cost_guard_requests_metric.stat
      dimensions  = local.cost_guard_requests_metric.dimensions
    }
  }

  alarm_description = "Input to cumulo-api-${var.environment}-cost-trip: this hour's requests, priced at the worst case in infra/api/cost-guard.tf, project a month above $${local.monthly_ceiling_usd} — for ${local.hold_breaching_hours} of the last ${local.hold_hours} hours. No actions of its own (ADR 0010)."
}

# --- the trips -----------------------------------------------------------------

resource "aws_cloudwatch_composite_alarm" "cost_trip" {
  alarm_name = "cumulo-api-${var.environment}-cost-trip"
  alarm_rule = "ALARM(\"${aws_cloudwatch_metric_alarm.cost_anomaly["held"].alarm_name}\") AND ALARM(\"${aws_cloudwatch_metric_alarm.cost_burn_rate.alarm_name}\")"

  # The trip and the email that announces it. No `ok_actions` towards the
  # function: every invocation trips, so an OK transition must never reach it.
  alarm_actions = [aws_lambda_function.cost_trip.arn, local.alerts_topic_arn]

  alarm_description = "TRIPPED: the Cumulo fleet API stage is throttled to zero. Request volume was anomalous and projected a month above $${local.monthly_ceiling_usd} for ${local.hold_breaching_hours} of ${local.hold_hours} hours (ADR 0010). Reset is manual — infra/README.md, api stack, 'Reset after a cost trip'."
}

resource "aws_cloudwatch_metric_alarm" "billing_trip" {
  provider = aws.us_east_1

  alarm_name  = "cumulo-api-${var.environment}-billing-trip"
  namespace   = "AWS/Billing"
  metric_name = "EstimatedCharges"
  dimensions  = { Currency = "USD" }

  # AWS's own billing-alarm guidance: Maximum over six hours, one of one, and
  # missing data left as missing. The metric is published only once billing
  # alerts are enabled — an operator step with no API (infra/README.md) — and
  # until then this alarm is INSUFFICIENT_DATA, which trips nothing.
  statistic           = "Maximum"
  period              = 21600
  evaluation_periods  = 1
  threshold           = local.billing_trip_usd
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "missing"

  # ALARM only. The topic's Lambda subscription receives every message the topic
  # gets, and every invocation trips, so an `ok_actions` here would trip the
  # stage on the month-start reset.
  alarm_actions = [aws_sns_topic.billing_trip.arn]

  alarm_description = "TRIPPED: actual month-to-date AWS spend passed $${local.billing_trip_usd}, and the Cumulo fleet API stage (eu-west-1) is throttled to zero (ADR 0010). It stays tripped for the rest of the calendar month unless the threshold is raised; reset is in infra/README.md, api stack."
}

resource "aws_sns_topic" "billing_trip" {
  provider = aws.us_east_1

  name = "cumulo-billing-trip-${var.environment}"
}

# Cross-Region: a us-east-1 topic delivering to the eu-west-1 function, which
# SNS supports for Lambda endpoints.
resource "aws_sns_topic_subscription" "billing_trip_function" {
  provider = aws.us_east_1

  topic_arn = aws_sns_topic.billing_trip.arn
  protocol  = "lambda"
  endpoint  = aws_lambda_function.cost_trip.arn
}

# The billing leg's email. Its own subscription, because the platform alerts
# topic is in eu-west-1 and an alarm's SNS action is a topic in its own Region.
# Pending until the operator confirms it from the inbox (infra/README.md).
resource "aws_sns_topic_subscription" "billing_trip_email" {
  provider = aws.us_east_1

  topic_arn = aws_sns_topic.billing_trip.arn
  protocol  = "email"
  endpoint  = data.aws_ssm_parameter.notification_email.value
}

# Read through the default (eu-west-1) provider, where the operator created it
# for infra/alerting; that stack's postcondition validates its shape.
data "aws_ssm_parameter" "notification_email" {
  name            = "/cumulo/notification-email"
  with_decryption = true
}

# --- the function --------------------------------------------------------------

resource "aws_lambda_function" "cost_trip" {
  function_name = local.cost_trip_function_name
  role          = aws_iam_role.cost_trip.arn

  runtime = "nodejs22.x"
  handler = "main.handler"

  # Its own artefact, built beside handler.zip by `pnpm --filter @cumulo/api
  # build`, and deliberately outside the CI deploy grant (deploy.tf): a kill
  # switch changes only through an apply somebody reads.
  filename         = local.cost_trip_artifact_path
  source_code_hash = fileexists(local.cost_trip_artifact_path) ? filebase64sha256(local.cost_trip_artifact_path) : null

  timeout     = 10
  memory_size = 128

  environment {
    variables = {
      COST_TRIP_API_ID     = aws_apigatewayv2_api.api.id
      COST_TRIP_STAGE_NAME = aws_apigatewayv2_stage.default.name
      # Every route with its own `route_settings` entry: those outrank the stage
      # default, so a trip that missed one would leave that route open.
      COST_TRIP_ROUTE_KEYS = join(",", sort(local.write_route_keys))
    }
  }

  depends_on = [aws_cloudwatch_log_group.cost_trip]

  lifecycle {
    precondition {
      condition     = fileexists(local.cost_trip_artifact_path)
      error_message = "No Lambda artefact at apps/api/dist/cost-trip.zip. Run `pnpm --filter @cumulo/api build` from the repo root before planning or applying this stack (see the api runbook in infra/README.md)."
    }
  }
}

resource "aws_cloudwatch_log_group" "cost_trip" {
  name              = "/aws/lambda/${local.cost_trip_function_name}"
  retention_in_days = 30
}

resource "aws_iam_role" "cost_trip" {
  name               = local.cost_trip_function_name
  assume_role_policy = data.aws_iam_policy_document.lambda_trust.json
}

# Exactly two grants: patch this API's one stage, and write its own logs.
data "aws_iam_policy_document" "cost_trip" {
  statement {
    sid       = "PatchApiStage"
    actions   = ["apigateway:PATCH"]
    resources = ["arn:aws:apigateway:${var.aws_region}::/apis/${aws_apigatewayv2_api.api.id}/stages/${aws_apigatewayv2_stage.default.name}"]
  }

  statement {
    sid = "WriteOwnLogs"
    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = ["${aws_cloudwatch_log_group.cost_trip.arn}:*"]
  }
}

resource "aws_iam_role_policy" "cost_trip" {
  name   = local.cost_trip_function_name
  role   = aws_iam_role.cost_trip.id
  policy = data.aws_iam_policy_document.cost_trip.json
}

# Who may invoke it: the composite alarm, and the billing topic. Nothing else —
# the function trips on any invocation, so these two policies are its guard.
resource "aws_lambda_permission" "cost_trip_composite" {
  statement_id   = "AllowCostTripCompositeAlarm"
  action         = "lambda:InvokeFunction"
  function_name  = aws_lambda_function.cost_trip.function_name
  principal      = "lambda.alarms.cloudwatch.amazonaws.com"
  source_arn     = aws_cloudwatch_composite_alarm.cost_trip.arn
  source_account = data.aws_caller_identity.current.account_id
}

resource "aws_lambda_permission" "cost_trip_billing_topic" {
  statement_id  = "AllowBillingTripTopic"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.cost_trip.function_name
  principal     = "sns.amazonaws.com"
  source_arn    = aws_sns_topic.billing_trip.arn
}
