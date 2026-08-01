# Three alarms, all required work rather than monitoring garnish.
#
# This stack's whole output is invisible: a cycle that publishes nothing looks
# exactly like a cycle that published everything, unless something is watching.
# The handler is written to make that visible (it throws when any location fails
# to publish, precisely so `Errors` moves), and these alarms are the other half
# of that design — a metric nobody alarms on is a metric nobody reads. The third
# alarm, added by #29, covers the one failure that never reaches the handler at
# all: an invocation that was discarded before it started.
#
# `treat_missing_data = "notBreaching"` on all three. The function reports
# Errors only when it is invoked, SQS stops publishing queue metrics when a
# queue has been idle for six hours, and Lambda publishes AsyncEventsDropped
# only when it drops something — so without this an idle demo, which is the
# normal state, would sit permanently in INSUFFICIENT_DATA and nobody would
# notice the day it changed.
#
# `alarm_actions` and `ok_actions` on all three, mirroring
# infra/storage/alarms.tf and infra/api/alarms.tf: they point at the platform
# alerts topic that infra/alerting owns (#29). This file used to say there was
# nowhere to send them yet; there is now, and the local below explains why the
# ARN is assembled rather than read.
#
# Cost: three alarms, joining storage's four and the api stack's two inside the
# always-free 10 CloudWatch alarms — see the alarm-budget subsection in
# infra/README.md, which owns the platform-wide count. $0.

locals {
  # The alerting stack (infra/alerting) owns this topic. Its ARN is assembled
  # from the naming convention rather than read through a
  # `terraform_remote_state` data source — the same deliberate coupling this
  # stack already uses for storage's table ARNs (see iam.tf, which is where
  # `data.aws_caller_identity.current` is declared): the stacks share a
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

resource "aws_cloudwatch_metric_alarm" "ingestion_errors" {
  alarm_name  = "cumulo-ingestion-${var.environment}-errors"
  namespace   = "AWS/Lambda"
  metric_name = "Errors"
  dimensions = {
    FunctionName = aws_lambda_function.ingestion.function_name
  }

  # Period 3,600 s: one bucket per invocation, because there is exactly one
  # invocation an hour. A shorter period would leave 59 empty minutes for every
  # minute of signal and make the alarm's state a description of the schedule
  # rather than of the cycle. Sum with threshold 1 means "the hourly cycle
  # errored", with no averaging to hide behind: the function either completed a
  # full fleet cycle or it did not.
  statistic           = "Sum"
  period              = 3600
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"

  alarm_actions = [local.alerts_topic_arn]
  ok_actions    = [local.alerts_topic_arn]

  alarm_description = "The hourly Cumulo ingestion cycle errored. Either the Lambda itself failed, or the handler threw CycleFailedError because at least one location did not publish — the log's ingestion.cycle.summary entry says which, and how many of how many. Check its skippedForDeadline count first: non-zero means the cycle ran out of its time budget and stopped starting locations, which is pathology in one of the three effects rather than a fleet problem (see CYCLE_DEADLINE_MS in apps/ingestion/src/cycle-budget.ts). The summary's deferred count does NOT contribute to this alarm — locations held back by MAX_LOCATIONS_PER_CYCLE are scheduled work that a later cycle picks up, not failures."
}

resource "aws_cloudwatch_metric_alarm" "dlq_not_empty" {
  alarm_name  = "cumulo-weather-readings-dlq-${var.environment}-not-empty"
  namespace   = "AWS/SQS"
  metric_name = "ApproximateNumberOfMessagesVisible"
  dimensions = {
    QueueName = aws_sqs_queue.weather_readings_dlq.name
  }

  # ADR 0004 requires this one by name: "a CloudWatch alarm on the DLQ's
  # ApproximateNumberOfMessagesVisible, since a dead-letter queue nobody watches
  # is a silently broken pipeline."
  #
  # Threshold 0 with Maximum, not Sum: the metric is a gauge (how many messages
  # are sitting there), so summing five minutes of samples would count the same
  # message five times. Any message at all is signal — this queue should be
  # empty forever, and a threshold tuned to tolerate a few would be tuned to
  # hide the first one.
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"

  alarm_actions = [local.alerts_topic_arn]
  ok_actions    = [local.alerts_topic_arn]

  alarm_description = "A weather-readings message failed 5 delivery attempts and was dead-lettered. Ingestion published it, so the fault is downstream: read the message body, then #12's consumer logs. Messages are retained 14 days — the queue is the evidence, so drain it only after the cause is known."
}

# Cycle starvation: the invocation that never happened.
#
# The `ingestion_errors` alarm above can only see cycles that *ran*. EventBridge
# invokes this function asynchronously and schedule.tf pins that path shut —
# `maximum_retry_attempts = 0`, `maximum_event_age_in_seconds = 60` — so an
# invocation Lambda cannot start within 60 seconds is discarded outright. No
# invocation, no Errors datapoint, no log line, and an hour of the fleet's
# weather simply missing. `AsyncEventsDropped` is the only signal that it
# happened at all; schedule.tf's comment already names the metric as the visible
# consequence of that 60-second choice, and this is the alarm that makes it
# visible in practice.
#
# The known cause is not a bug in this stack. Account Lambda concurrency is 10
# and the fleet API shares that pool (measured on issue #29, 2026-08-01: a
# 40-parallel burst against the API returned 11×200 and 29×503, the 503s coming
# from Lambda concurrency rather than from the gateway's throttle). A flood that
# lands on the cycle minute takes the slots this function needs, and the cycle is
# dropped. #29's per-IP limiting narrows that window; it does not close it, and
# closing it properly is a service-quota increase, which is an account-level
# decision rather than a stack one.
#
# Metric name verified against the account before this alarm was written —
# `aws cloudwatch list-metrics --namespace AWS/Lambda --metric-name
# AsyncEventsDropped` returns it dimensioned on FunctionName for this very
# function, so it is neither a guess nor a metric that only exists in
# documentation. The AsyncEventsReceived / AsyncEventAge / AsyncEventsDropped
# family is documented under "Asynchronous invocation metrics" in the Lambda
# metric types page:
# https://docs.aws.amazon.com/lambda/latest/dg/monitoring-metrics-types.html
resource "aws_cloudwatch_metric_alarm" "async_events_dropped" {
  alarm_name  = "cumulo-ingestion-${var.environment}-async-dropped"
  namespace   = "AWS/Lambda"
  metric_name = "AsyncEventsDropped"
  dimensions = {
    FunctionName = aws_lambda_function.ingestion.function_name
  }

  # Period 3,600 s and threshold 1, the same shape and the same reasoning as
  # `ingestion_errors`: one bucket per scheduled invocation, because there is
  # exactly one an hour, and Sum with threshold 1 means "this hour's cycle was
  # thrown away" with no averaging to hide behind. A shorter period would leave
  # 59 empty minutes for every minute of signal.
  #
  # The dimension is FunctionName alone. Lambda also publishes this metric with
  # a `FunctionName, Resource` pair, and alarming on that combination would
  # narrow the alarm to a specific version or alias — this function is invoked
  # unqualified, so the one-dimension aggregate is the series that actually
  # moves.
  statistic           = "Sum"
  period              = 3600
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"

  alarm_actions = [local.alerts_topic_arn]
  ok_actions    = [local.alerts_topic_arn]

  alarm_description = "An hourly Cumulo ingestion cycle was discarded before it ran: EventBridge's asynchronous invocation sat in Lambda's queue past the 60-second maximum event age pinned in infra/ingestion/schedule.tf, with retries deliberately at zero. There is no error and no log line for this cycle because the function was never entered — that hour's weather is simply missing, and the next cycle re-fetches the same 48-hour horizon from fresher data, so a single firing self-heals. Repeated firing does not: the known cause is the account's Lambda concurrency limit of 10, shared with the fleet API, being consumed at the cycle minute (measured, issue #29). Check the API's request-flood alarm for the same window before changing anything here; the fix is a concurrency quota increase, not a longer event age."
}
