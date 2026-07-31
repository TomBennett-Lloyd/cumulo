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
# No `alarm_actions`, mirroring infra/storage/alarms.tf and
# infra/ingestion/alarms.tf: there is nowhere to send them yet. Notification
# wiring (SNS topic, subscriptions) arrives with #29, which owns that area. An
# alarm with no action is still visible in the CloudWatch console and in
# `aws cloudwatch describe-alarms --state-value ALARM`, and creating a topic
# here purely to have an action would be infrastructure nobody reads.
#
# Cost: two alarms, joining storage's four and ingestion's two — eight of the
# always-free ten. That headroom is now the thing to check before adding a
# ninth and a tenth; past ten, alarms bill $0.10 each per month.

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
  # other signal the platform has. Firing here is the trigger to bring #29's
  # per-IP limiting forward, not to raise the throttle.
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1800
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"

  alarm_description = "The Cumulo fleet API is taking sustained traffic far above demo volume — averaging over 6 requests/second for five minutes, against a stage ceiling of 10/second. The bill is bounded by that throttle (ADR 0005, ≈ $36/month worst case), but legitimate visitors are likely being 429ed by whoever is doing this. Read the access pattern before changing anything; the fix is #29's per-IP limiting, not a higher ceiling."
}
