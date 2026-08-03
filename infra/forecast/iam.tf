# The function's execution role. ADR 0002 reduced least privilege to a list of
# table ARNs, and this stack's sentence is the narrowest of the four: *forecast
# reads sites through one index, writes `series`, and consumes one queue.*
# This file is that sentence, plus the log group it writes.
#
# Nothing here is a managed policy. Neither `AWSLambdaBasicExecutionRole` nor
# `AWSLambdaSQSQueueExecutionRole` — the second is the tempting one, because it
# is exactly the three SQS actions below, but it grants them on **every queue in
# the account**, including ingestion's DLQ and every queue a later ticket
# creates. The first grants logs:* across every log group in the account, which
# is broader in exactly the direction that matters: the logs of every other
# service.

data "aws_caller_identity" "current" {}

locals {
  # Table ARNs are assembled rather than read from the storage stack's outputs,
  # and that is the deliberate coupling ADR 0001 chose: the two stacks share a
  # *naming convention* (`cumulo-<table>-<environment>`, fixed by ADR 0002 and
  # mirrored by storageTableName() in @cumulo/storage), not a remote state
  # reference. A terraform_remote_state data source would make forecast unable
  # to plan while storage's state was mid-apply, and would give this stack read
  # access to the whole of storage's state for two strings it can compute.
  #
  # The account id comes from the caller rather than from a variable, so it
  # never appears in a committed file (infra/README.md convention 7).
  dynamodb_table_arn_prefix = "arn:aws:dynamodb:${var.aws_region}:${data.aws_caller_identity.current.account_id}:table"

  sites_table_arn  = "${local.dynamodb_table_arn_prefix}/cumulo-sites-${var.environment}"
  series_table_arn = "${local.dynamodb_table_arn_prefix}/cumulo-series-${var.environment}"

  # An index ARN is the table ARN plus /index/<name>, and it is a *different*
  # resource for IAM purposes — which is what makes the statement below a real
  # restriction rather than a longer way of writing the table ARN.
  sites_by_location_index_arn = "${local.sites_table_arn}/index/by-location"
}

data "aws_iam_policy_document" "lambda_trust" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "forecast" {
  name               = "cumulo-forecast-${var.environment}"
  assume_role_policy = data.aws_iam_policy_document.lambda_trust.json
}

data "aws_iam_policy_document" "forecast" {
  # Read the location's active sites — through the `by-location` index and
  # nothing else. `listActiveSitePhysicsAtLocation` in @cumulo/storage's site
  # adapter is a Query on that GSI, and it is the grant `infra/ingestion/iam.tf`
  # explicitly says belongs to this service ("it belongs to #12's forecast
  # service, which will carry its own grant"). This is that grant.
  #
  # **The base table ARN is deliberately absent**, and the omission is the
  # interesting half. A grant on `.../table/cumulo-sites-<env>` does not cover
  # its indexes, and a grant on an index does not cover the base table — the
  # implication runs neither way. So this policy permits the one query the
  # forecast path makes and refuses `listFleetSites`, which reads the base
  # table's `FLEET` partition and belongs to ingestion and the API. The other
  # index, `user-sites-by-age`, is absent for the same reason: it is #29's
  # eviction path, not this one's.
  #
  # A projection note, because it is what keeps this grant sufficient rather
  # than merely narrow: `by-location` is an INCLUDE index carrying latitude,
  # longitude, tilt, azimuth and capacity, which is the whole of the physics
  # input. The forecast never needs to follow up with a GetItem on the base
  # table — which is why there is no `dynamodb:GetItem` anywhere in this file.
  statement {
    sid       = "ReadActiveSitesAtLocation"
    actions   = ["dynamodb:Query"]
    resources = [local.sites_by_location_index_arn]
  }

  # Write the forecasts. BatchWriteItem and nothing else: this function produces
  # series rows and never reads them back — reading `series` is the fleet API's
  # job (infra/api/iam.tf carries that `Query`), and ADR 0002 sized this table's
  # provisioned read capacity (owned by infra/storage/tables.tf) on that
  # division. No `dynamodb:Query` on `series`
  # here, so a read path appearing on this side has to be argued in a diff
  # rather than inherited from a wildcard.
  statement {
    sid       = "WriteForecastSeries"
    actions   = ["dynamodb:BatchWriteItem"]
    resources = [local.series_table_arn]
  }

  # Consume. These are the three actions an event source mapping performs on
  # behalf of the function, and Lambda uses the *execution role* to do it — the
  # mapping in event-source.tf does not create the permission, it only relies on
  # it, which is why a missing grant here shows up as a mapping stuck in
  # `Disabled` rather than as an apply failure.
  #
  # `sqs:SendMessage` is deliberately absent, the exact mirror of ingestion's
  # policy having no ReceiveMessage: ingestion produces and never consumes, this
  # function consumes and never produces. Nothing in the platform holds both
  # ends. The DLQ is absent too — SQS moves messages there itself, under the
  # queue's redrive policy, without the consumer's permission.
  statement {
    sid = "ConsumeWeatherReadings"
    actions = [
      "sqs:ReceiveMessage",
      "sqs:DeleteMessage",
      "sqs:GetQueueAttributes",
    ]
    resources = [local.weather_readings_queue_arn]
  }

  # Logs, restricted to this function's own group. No logs:CreateLogGroup: the
  # group is a Terraform resource (lambda.tf), so the function has no business
  # creating one — and a function that cannot create log groups cannot create
  # one outside Terraform's ownership that teardown would then leave behind.
  #
  # The `:*` suffix matches the log *streams* inside the group, which is what
  # CreateLogStream and PutLogEvents actually act on — a grant on the bare group
  # ARN authorises neither.
  #
  # It is appended here rather than inherited: `aws_cloudwatch_log_group.arn`
  # comes back from the provider with its trailing `:*` **stripped**, even though
  # the ARN CloudWatch Logs itself reports carries one. So the interpolation
  # below yields exactly one wildcard, not two. Anyone "tidying" this into
  # `aws_cloudwatch_log_group.forecast.arn` alone would leave the function
  # unable to write its own logs — and the only symptom would be an empty log
  # group, which reads exactly like a function that never ran.
  statement {
    sid = "WriteOwnLogs"
    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = ["${aws_cloudwatch_log_group.forecast.arn}:*"]
  }
}

resource "aws_iam_role_policy" "forecast" {
  name   = "cumulo-forecast-${var.environment}"
  role   = aws_iam_role.forecast.id
  policy = data.aws_iam_policy_document.forecast.json
}
