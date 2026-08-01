# Two alarms, both required work rather than monitoring garnish, and chosen so
# that they do not fire on the same event.
#
# This is the first Cumulo stack whose input is the public internet, so the two
# things worth watching are the two things nothing else in the platform reports:
# whether the API is failing its callers, and whether somebody is hammering it.
# The bootstrap stack's budget alarm is the money backstop, but it is a *monthly
# actual spend* alarm at 50% of ~$100 — under ADR 0005's ≈ $36 worst case it
# would never fire at all. Abuse has to be visible some other way, and that is
# what the second alarm below is.
#
# `treat_missing_data = "notBreaching"` on both: API Gateway publishes these
# metrics only when the API is called, and an idle demo is the normal state.
# Without it both alarms would sit permanently in INSUFFICIENT_DATA and nobody
# would notice the day that changed.
#
# Both are dimensioned on `ApiId` alone rather than on `ApiId, Stage`. There is
# exactly one stage (`$default`, gateway.tf), so the two dimension sets describe
# the same traffic, and the API-level aggregate is the one API Gateway publishes
# unconditionally — an alarm on a dimension combination that turns out not to be
# emitted is an alarm that reads as healthy forever.
#
# `alarm_actions` and `ok_actions` on both, mirroring infra/storage/alarms.tf
# and infra/ingestion/alarms.tf: they point at the platform alerts topic that
# infra/alerting owns (#29). This file used to say there was nowhere to send
# them yet; there is now, and the local below explains why the ARN is assembled
# rather than read.
#
# That arrival matters most for the flood alarm below, whose meaning #29 also
# narrowed. It was written as the trigger to bring per-IP limiting forward;
# per-IP limiting now exists, so a firing no longer means "somebody is hammering
# this and nothing is stopping them" — it means the flood survived the limiter,
# which leaves a distributed source or the unlimited read routes. That is a
# narrower and more serious reading, and it is one a human has to act on within
# minutes of the traffic starting. A state change nobody is emailed about is a
# trigger nobody pulls.
#
# Cost: two alarms, joining storage's four and ingestion's three — nine of the
# always-free ten. The platform-wide count and who gets the tenth live in the
# alarm-budget subsection of infra/README.md; past ten, alarms bill $0.10 each
# per month and every "$0.00/mo" in that document stops being literally true.

locals {
  # The alerting stack (infra/alerting) owns this topic. Its ARN is assembled
  # from the naming convention rather than read through a
  # `terraform_remote_state` data source — the same deliberate coupling iam.tf
  # documents at length for the DynamoDB table ARNs, and where
  # `data.aws_caller_identity.current` is declared: the stacks share a
  # convention, not a wire, so this one plans while alerting's state is
  # mid-apply, or before alerting exists at all.
  #
  # The obligation that buys: alerting must be applied with the same
  # `environment` and into the same region, exactly as storage must. A mismatch
  # is not an apply error — CloudWatch accepts an action pointing at a topic
  # that does not exist and reports it only by never delivering, which is why
  # the alerting runbook verifies delivery from AWS rather than from a green
  # apply.
  alerts_topic_arn = "arn:aws:sns:${var.aws_region}:${data.aws_caller_identity.current.account_id}:cumulo-alerts-${var.environment}"
}

resource "aws_cloudwatch_metric_alarm" "api_5xx" {
  alarm_name  = "cumulo-api-${var.environment}-5xx"
  namespace   = "AWS/ApiGateway"
  metric_name = "5xx"
  dimensions = {
    ApiId = aws_apigatewayv2_api.api.id
  }

  # Any server error at all, within five minutes. This is deliberately the
  # gateway's metric rather than Lambda's `Errors`, because it is the superset:
  # a crashed, timed-out or out-of-memory invocation surfaces here as a 502 or
  # 504, *and* so does a 500 that apps/api's top-level boundary caught and
  # shaped into an `apiErrorSchema` body — which Lambda does not count as an
  # error at all, since the function returned normally. Alarming on Lambda
  # `Errors` as well would add a second alarm that fires only in cases this one
  # already covers.
  #
  # Threshold 0 with Sum: this API should never 5xx. A threshold tuned to
  # tolerate a few would be tuned to hide the first one. 4xx is deliberately not
  # alarmed — a 404 for an unknown site is the documented behaviour of a route,
  # not a fault.
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"

  alarm_actions = [local.alerts_topic_arn]
  ok_actions    = [local.alerts_topic_arn]

  alarm_description = "The Cumulo fleet API returned a 5xx. Either the function failed outright (a 502/504 — check the log group for a timeout or an init error) or a handler threw and the top-level boundary shaped it into a 500; the structured log line names which. DynamoDB read throttling on cumulo-series is the failure ADR 0005 predicts under load."
}

resource "aws_cloudwatch_metric_alarm" "api_request_flood" {
  alarm_name  = "cumulo-api-${var.environment}-request-flood"
  namespace   = "AWS/ApiGateway"
  metric_name = "Count"
  dimensions = {
    ApiId = aws_apigatewayv2_api.api.id
  }

  # 1,800 requests in five minutes — six requests/second averaged, against the
  # stage's 10/second ceiling (gateway.tf). The two numbers this sits between
  # are both from ADR 0005: a demo session is 30–60 requests including Swagger
  # UI's assets, and the ceiling held continuously is 3,000 requests per
  # five-minute period. So this fires at roughly thirty simultaneous sessions
  # sustained for five minutes, which the expected regime cannot reach and the
  # abusive one crosses immediately.
  #
  # It is not a cost alarm — the throttle already bounds the bill, and this
  # volume is pennies. It is the *visibility* the throttle does not provide:
  # ADR 0005 records that one abusive caller consuming the ceiling 429s every
  # legitimate visitor, and that availability failure is invisible in every
  # other signal the platform has.
  #
  # #29 changed what a firing *means* without changing the threshold. The per-IP
  # limiter now absorbs a single-source flood before it reaches this volume, so
  # crossing 1,800 in five minutes implies either a distributed source or a
  # concentration on the read routes the limiter deliberately leaves alone. The
  # response is still to read the access pattern rather than to raise the
  # throttle — the ceiling is what bounds the bill.
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1800
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"

  alarm_actions = [local.alerts_topic_arn]
  ok_actions    = [local.alerts_topic_arn]

  alarm_description = "The Cumulo fleet API is taking sustained traffic far above demo volume — averaging over 6 requests/second for five minutes, against a stage ceiling of 10/second. The bill is bounded by that throttle (ADR 0005, ≈ $36/month worst case), but legitimate visitors are likely being 429ed by whoever is doing this. Read the access pattern before changing anything, and note what this volume implies now that #29's per-IP limiting is in place: a single-source flood is blocked well below this threshold, so reaching it means a distributed source or traffic concentrated on the unlimited read routes. Neither is fixed by a higher ceiling."
}
