# The function's execution role. ADR 0005 reduced least privilege for this
# service to one sentence — "the execution role gets `GetItem, PutItem,
# DeleteItem, Query` on the sites table and `Query` only on the series table;
# the API reads and writes nothing else" — and this file is that sentence, plus
# the log group it writes.
#
# Nothing here is a managed policy. `AWSLambdaBasicExecutionRole` would grant
# logs:* across every log group in the account, which is broader than this
# function needs in exactly the direction that matters: the logs of every other
# service.

data "aws_caller_identity" "current" {}

locals {
  # Table ARNs are assembled rather than read from the storage stack's outputs,
  # and that is the deliberate coupling ADR 0001 chose and ADR 0005 restated:
  # the two stacks share a *naming convention* (`cumulo-<table>-<environment>`,
  # fixed by ADR 0002 and mirrored by storageTableName() in @cumulo/storage),
  # not a remote state reference. A terraform_remote_state data source would
  # make this stack unable to plan while storage's state was mid-apply, and
  # would give it read access to the whole of storage's state for two strings it
  # can compute.
  #
  # The account id comes from the caller rather than from a variable, so it
  # never appears in a committed file (infra/README.md convention 7).
  dynamodb_table_arn_prefix = "arn:aws:dynamodb:${var.aws_region}:${data.aws_caller_identity.current.account_id}:table"

  sites_table_arn  = "${local.dynamodb_table_arn_prefix}/cumulo-sites-${var.environment}"
  series_table_arn = "${local.dynamodb_table_arn_prefix}/cumulo-series-${var.environment}"
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

resource "aws_iam_role" "api" {
  name               = "cumulo-api-${var.environment}"
  assume_role_policy = data.aws_iam_policy_document.lambda_trust.json
}

data "aws_iam_policy_document" "api" {
  # The sites table, read and written. Four actions, one per CRUD route:
  # `Query` is `listFleetSites` (the base table's single `FLEET` partition),
  # `GetItem` is `getFleetSite`, `PutItem` is both create and the write half of
  # PUT's read-modify-write, `DeleteItem` is DELETE.
  #
  # The `sites` table carries two GSIs and neither is listed here, deliberately:
  # an index ARN is the table ARN plus /index/<name> and is *not* covered by a
  # grant on the table, so omitting them is a real restriction rather than an
  # oversight. No route in apps/api reads an index — `listFleetSites` and
  # `listActiveSitePhysicsAtLocation` are different callers, and the second one
  # belongs to #12's forecast service with its own grant. If an API route ever
  # queries an index, this statement is what has to change, which is the point.
  #
  # There is no `BatchWriteItem` and no `UpdateItem`: PUT is a read-modify-write
  # through `putFleetSite` precisely so the whole item is one reviewed shape,
  # and nothing here writes more than one site at a time.
  statement {
    sid = "ReadWriteFleetSites"
    actions = [
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:DeleteItem",
      "dynamodb:Query",
    ]
    resources = [local.sites_table_arn]
  }

  # The series table, read only. `querySeriesRange` is the single caller, behind
  # `GET /v1/sites/{siteId}/forecast` and `GET /v1/sites/{siteId}/series`, and
  # both are reads by construction: the API stores nothing — forecast rows are
  # written by #12 and actuals by #16.
  #
  # No write action of any kind, which is the grant-level statement of that
  # property. It is also where #29's X3 cleanup will surface: range-deleting a
  # deleted site's series rows needs `dynamodb:DeleteItem` here, and until then
  # orphaned rows expire on ADR 0002's 90-day TTL. No GSI ARN, same reason as
  # above.
  statement {
    sid       = "ReadSeries"
    actions   = ["dynamodb:Query"]
    resources = [local.series_table_arn]
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
  # `aws_cloudwatch_log_group.api.arn` alone would leave the function unable to
  # write its own logs — and the only symptom would be an empty log group, which
  # reads exactly like a function that never ran.
  statement {
    sid = "WriteOwnLogs"
    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = ["${aws_cloudwatch_log_group.api.arn}:*"]
  }
}

resource "aws_iam_role_policy" "api" {
  name   = "cumulo-api-${var.environment}"
  role   = aws_iam_role.api.id
  policy = data.aws_iam_policy_document.api.json
}
