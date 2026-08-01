# Throttle alarms on the two provisioned tables — required work, not
# monitoring garnish.
#
# ADR 0002 accepts throttling as the failure mode of taking the free
# provisioned allowance, which makes an *unobserved* throttle the failure mode
# it does not accept. These four alarms are the tripwire for revisit trigger 8:
# a throttle on `cumulo-series` means the read allocation has met real traffic,
# and the answer is to flip `billing_mode` to PAY_PER_REQUEST — one attribute,
# no migration — rather than to add auto-scaling (see tables.tf) or argue about
# RCU.
#
# Threshold 0 with a 60-second Sum and one evaluation period: any throttled
# request at all, within a minute. There is deliberately no hysteresis. These
# tables should throttle zero times, so a single event is signal, and a
# threshold tuned to tolerate a few would be tuned to hide the first one.
#
# `treat_missing_data = "notBreaching"` because DynamoDB publishes these
# metrics only when throttling occurs. Without it an idle demo — the normal
# state — would sit permanently in INSUFFICIENT_DATA and nobody would notice
# the day it changed.
#
# Both `alarm_actions` and `ok_actions` point at the platform alerts topic
# (#29). This file used to say there was nowhere to send them yet; there is now,
# and the local below explains why the ARN is assembled rather than read.
# `ok_actions` is not symmetry for its own sake: a throttle alarm that fires and
# then recovers is the common case, and without the recovery mail the only way
# to learn it had cleared is to go and look — which is the behaviour the whole
# file exists to avoid depending on.
#
# Cost: four alarms, inside the always-free 10 CloudWatch alarms — see the
# alarm-budget subsection in infra/README.md, which owns the platform-wide
# count. $0.
#
# The four, written out because the names below are assembled by for_each and
# would otherwise appear in this repo nowhere a grep could find them:
#
#   cumulo-series-<env>-read-throttle    cumulo-series-<env>-write-throttle
#   cumulo-weather-<env>-read-throttle   cumulo-weather-<env>-write-throttle

data "aws_caller_identity" "current" {}

locals {
  # The alerting stack (infra/alerting) owns this topic. Its ARN is assembled
  # from the naming convention rather than read through a `terraform_remote_state`
  # data source, which is the same deliberate coupling infra/api/iam.tf documents
  # for table ARNs and infra/README.md states for every pair of stacks in this
  # repo: the stacks share a convention, not a wire. A remote-state reference
  # would make this stack unable to plan while alerting's state was mid-apply,
  # and would give a plan of the storage stack a reason to fail because of a
  # different stack's bucket.
  #
  # The obligation that buys: alerting must be applied with the same
  # `environment` and into the same region, because an SNS ARN carries both. A
  # mismatch is not an apply error — CloudWatch accepts an action pointing at a
  # topic that does not exist and reports it only by never delivering, which is
  # why the alerting runbook verifies delivery from AWS rather than from a green
  # apply.
  alerts_topic_arn = "arn:aws:sns:${var.aws_region}:${data.aws_caller_identity.current.account_id}:cumulo-alerts-${var.environment}"


  # Both provisioned tables get the same pair of alarms, so the pair is
  # described once and expanded over the tables rather than written four times.
  # Keyed by table name (not by index) so adding or removing a table never
  # renames another table's alarm resource in state.
  provisioned_tables = {
    series  = aws_dynamodb_table.series.name
    weather = aws_dynamodb_table.weather.name
  }
}

resource "aws_cloudwatch_metric_alarm" "read_throttle" {
  for_each = local.provisioned_tables

  alarm_name  = "cumulo-${each.key}-${var.environment}-read-throttle"
  namespace   = "AWS/DynamoDB"
  metric_name = "ReadThrottleEvents"
  dimensions = {
    TableName = each.value
  }

  statistic           = "Sum"
  period              = 60
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"

  alarm_actions = [local.alerts_topic_arn]
  ok_actions    = [local.alerts_topic_arn]

  alarm_description = "Read requests were throttled on ${each.value}. The provisioned read allocation (ADR 0002) has met real traffic; the sanctioned response is to flip billing_mode to PAY_PER_REQUEST, not to add auto-scaling."
}

resource "aws_cloudwatch_metric_alarm" "write_throttle" {
  for_each = local.provisioned_tables

  alarm_name  = "cumulo-${each.key}-${var.environment}-write-throttle"
  namespace   = "AWS/DynamoDB"
  metric_name = "WriteThrottleEvents"
  dimensions = {
    TableName = each.value
  }

  statistic           = "Sum"
  period              = 60
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"

  alarm_actions = [local.alerts_topic_arn]
  ok_actions    = [local.alerts_topic_arn]

  # A throttled write is the quieter of the two: BatchWriteItem returns HTTP 200
  # carrying UnprocessedItems, so a caller that ignores that field reports a
  # clean run while dropping data. The adapters retry and return a typed partial
  # result (ADR 0002 consequence 4); this alarm is what says it happened at all.
  alarm_description = "Write requests were throttled on ${each.value}. Check for BatchWriteItem partial results in the ingestion logs — the provisioned write allocation (ADR 0002) has met real traffic."
}
