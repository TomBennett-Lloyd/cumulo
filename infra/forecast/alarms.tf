# One alarm, and the reason there is only one is worth reading before adding a
# second.
#
# This stack's failure modes divide cleanly. A *message* that cannot be
# processed is reported back to Lambda as a batch item failure
# (`ReportBatchItemFailures`, event-source.tf), redelivered, and after five
# attempts dead-lettered by the queue's redrive policy — where the ingestion
# stack's existing `cumulo-weather-readings-dlq-<env>-not-empty` alarm is
# already watching. Duplicating that watch here would be two alarms on one
# condition, and the first one to be tuned would make the pair disagree.
#
# What nothing else catches is *invocation*-level failure: a bad environment
# variable, an initialisation crash, a function that hits its 50 s timeout. Those
# never become batch item failures, because the code that would report one did
# not get far enough to run. They move `Errors`. That is this alarm.
#
# `treat_missing_data = "notBreaching"`: the function reports Errors only when it
# is invoked, and it is invoked only when ingestion publishes — so without this
# an idle demo, which is the normal state, would sit permanently in
# INSUFFICIENT_DATA and nobody would notice the day it changed.
#
# `alarm_actions` and `ok_actions`, mirroring infra/storage/alarms.tf,
# infra/ingestion/alarms.tf and infra/api/alarms.tf: they point at the platform
# alerts topic that infra/alerting owns (#29). This file used to say there was
# nowhere to send them yet; there is now, and the local below explains why the
# ARN is assembled rather than read.
#
# `ok_actions` as well as `alarm_actions` for the reason the other three give:
# this alarm's failure is an hourly burst that may well succeed on the next
# cycle, and without the recovery mail the only way to learn it cleared is to go
# and look — which is the behaviour these files exist to avoid depending on.
#
# Cost: one alarm, the tenth of the always-free 10 CloudWatch alarms (storage's
# four, ingestion's three, the api's two, this one). $0 — and it is the last
# free one: the eleventh bills $0.10/month. The platform-wide count and the
# obligations that come with crossing it live in the "CloudWatch alarm budget"
# subsection of infra/README.md, which owns that number.

locals {
  # The alerting stack (infra/alerting) owns this topic. Its ARN is assembled
  # from the naming convention rather than read through a
  # `terraform_remote_state` data source — the same deliberate coupling this
  # stack already uses for the queue ARN in event-source.tf and the table ARNs
  # in iam.tf, which is also where `data.aws_caller_identity.current` is
  # declared: the stacks share a convention, not a wire, so this one plans while
  # alerting's state is mid-apply, or before alerting exists at all.
  #
  # The obligation that buys: alerting must be applied with the same
  # `environment` and into the same region. Note that this is a *softer* failure
  # than the event-source mapping's — a missing queue fails `terraform apply`,
  # whereas a missing topic does not fail anything at all. CloudWatch accepts an
  # action pointing at a topic that does not exist and reports it only by never
  # delivering, which is why the alerting runbook proves delivery from AWS
  # rather than from a green apply.
  alerts_topic_arn = "arn:aws:sns:${var.aws_region}:${data.aws_caller_identity.current.account_id}:cumulo-alerts-${var.environment}"
}

resource "aws_cloudwatch_metric_alarm" "forecast_errors" {
  alarm_name  = "cumulo-forecast-${var.environment}-errors"
  namespace   = "AWS/Lambda"
  metric_name = "Errors"
  dimensions = {
    FunctionName = aws_lambda_function.forecast.function_name
  }

  # Period 3,600 s, matching the ingestion alarm — and for the same reason,
  # arrived at from the other side. This function is invoked in a burst once an
  # hour, when a cycle publishes, so one bucket per hour is one bucket per
  # burst. A shorter period would leave most of every hour empty and make the
  # alarm's state a description of ingestion's schedule rather than of this
  # function's health. Sum with threshold 1 means "at least one invocation
  # failed outright in the last hour", with no averaging to hide a single hard
  # failure behind eleven successes.
  statistic           = "Sum"
  period              = 3600
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"

  alarm_actions = [local.alerts_topic_arn]
  ok_actions    = [local.alerts_topic_arn]

  alarm_description = "A Cumulo forecast invocation failed outright — bad configuration, an initialisation crash, or the 50 s timeout. Note what this alarm does NOT cover: a message the handler could not process is returned as a batch item failure, retried, and eventually dead-lettered, where cumulo-weather-readings-dlq-<env>-not-empty (ingestion stack) is the alarm that fires. So this one firing means the function itself is broken rather than one location's data. Start with `aws logs tail /aws/lambda/cumulo-forecast-<env>` and check whether the invocations reached the handler at all."
}
