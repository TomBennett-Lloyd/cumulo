# Two alarms, both required work rather than monitoring garnish.
#
# This stack's whole output is invisible: a cycle that publishes nothing looks
# exactly like a cycle that published everything, unless something is watching.
# The handler is written to make that visible (it throws when any location fails
# to publish, precisely so `Errors` moves), and these alarms are the other half
# of that design — a metric nobody alarms on is a metric nobody reads.
#
# `treat_missing_data = "notBreaching"` on both. The function reports Errors
# only when it is invoked, and SQS stops publishing queue metrics when a queue
# has been idle for six hours — so without this an idle demo, which is the
# normal state, would sit permanently in INSUFFICIENT_DATA and nobody would
# notice the day it changed.
#
# No `alarm_actions`, mirroring infra/storage/alarms.tf: there is nowhere to
# send them yet. Notification wiring (SNS topic, subscriptions) arrives with
# #29, which owns that area. An alarm with no action is still visible in the
# CloudWatch console and in `aws cloudwatch describe-alarms --state-value
# ALARM`, and creating a topic here purely to have an action would be
# infrastructure nobody reads.
#
# Cost: two alarms, joining storage's four inside the always-free 10 CloudWatch
# alarms. $0.

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

  alarm_description = "A weather-readings message failed 5 delivery attempts and was dead-lettered. Ingestion published it, so the fault is downstream: read the message body, then #12's consumer logs. Messages are retained 14 days — the queue is the evidence, so drain it only after the cause is known."
}
