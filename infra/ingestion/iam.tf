# The function's execution role. ADR 0002 reduced least privilege to a list of
# table ARNs — "ingestion reads `sites` and writes `weather`" — and this file is
# that sentence, plus the queue it publishes to and the log group it writes.
#
# Nothing here is a managed policy. `AWSLambdaBasicExecutionRole` would grant
# logs:* across every log group in the account, which is broader than this
# function needs in exactly the direction that matters: the logs of every other
# service.

data "aws_caller_identity" "current" {}

locals {
  # Table ARNs are assembled rather than read from the storage stack's outputs,
  # and that is the deliberate coupling ADR 0001 chose: the two stacks share a
  # *naming convention* (`cumulo-<table>-<environment>`, fixed by ADR 0002 and
  # mirrored by storageTableName() in @cumulo/storage), not a remote state
  # reference. A terraform_remote_state data source would make ingestion unable
  # to plan while storage's state was mid-apply, and would give this stack read
  # access to the whole of storage's state for two strings it can compute.
  #
  # The account id comes from the caller rather than from a variable, so it
  # never appears in a committed file (infra/README.md convention 7).
  dynamodb_table_arn_prefix = "arn:aws:dynamodb:${var.aws_region}:${data.aws_caller_identity.current.account_id}:table"

  sites_table_arn   = "${local.dynamodb_table_arn_prefix}/cumulo-sites-${var.environment}"
  weather_table_arn = "${local.dynamodb_table_arn_prefix}/cumulo-weather-${var.environment}"
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

resource "aws_iam_role" "ingestion" {
  name               = "cumulo-ingestion-${var.environment}"
  assume_role_policy = data.aws_iam_policy_document.lambda_trust.json
}

data "aws_iam_policy_document" "ingestion" {
  # Read the fleet. `listFleetSites` in @cumulo/storage's site adapter is a
  # Query on the base table's single `FLEET` partition — no index — so the grant
  # is the table ARN alone.
  #
  # The `sites` table carries two GSIs and neither is listed here, deliberately:
  # an index ARN is the table ARN plus /index/<name> and is *not* covered by a
  # grant on the table, so omitting them is a real restriction rather than an
  # oversight. `listActiveSitePhysicsAtLocation` is the caller that reads
  # by-location, and it belongs to #12's forecast service, which will carry its
  # own grant. If ingestion ever queries an index, this statement is what has to
  # change — which is the point.
  statement {
    sid       = "ReadFleetSites"
    actions   = ["dynamodb:Query"]
    resources = [local.sites_table_arn]
  }

  # Write the readings. `putForecastWeather` uses BatchWriteItem and nothing
  # else: ingestion never reads `cumulo-weather` back, which is the premise
  # ADR 0002 sized that table's 3 RCU on before #156 flipped it to on-demand,
  # and which ADR 0004 rejected option E for breaking. The premise outlived the
  # sizing: no dynamodb:Query, no dynamodb:GetItem — if a read path ever appears
  # here, it has to be argued in a diff rather than inherited from a wildcard.
  statement {
    sid       = "WriteWeatherReadings"
    actions   = ["dynamodb:BatchWriteItem"]
    resources = [local.weather_table_arn]
  }

  # Publish. ADR 0004: "an IAM policy granting ingestion `sqs:SendMessage` on
  # the queue only". Ingestion produces and never consumes, so there is no
  # ReceiveMessage and no DeleteMessage here — those belong to #12's consumer
  # role. The DLQ is absent for the same reason: SQS moves messages there
  # itself, under the redrive policy, without the producer's permission.
  statement {
    sid       = "PublishWeatherReadings"
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.weather_readings.arn]
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
  # `aws_cloudwatch_log_group.ingestion.arn` alone would leave the function
  # unable to write its own logs — and the only symptom would be an empty log
  # group, which reads exactly like a function that never ran.
  statement {
    sid = "WriteOwnLogs"
    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = ["${aws_cloudwatch_log_group.ingestion.arn}:*"]
  }
}

resource "aws_iam_role_policy" "ingestion" {
  name   = "cumulo-ingestion-${var.environment}"
  role   = aws_iam_role.ingestion.id
  policy = data.aws_iam_policy_document.ingestion.json
}
