# The function's execution role. ADR 0005 reduced least privilege for this
# service to one sentence — "the execution role gets `GetItem, PutItem,
# DeleteItem, Query` on the sites table and `Query` only on the series table;
# the API reads and writes nothing else" — and this file was that sentence, plus
# the log group it writes.
#
# #29 widens it in three named places, and ADR 0006 is where each is argued:
# `UpdateItem` on the sites table for the cap counter, `Query` on the
# `user-sites-by-age` index for oldest-first eviction, and the three item
# actions on the new abuse table. Each is one statement below with the caller
# named. The sentence is longer; the property it states is the same one.
#
# It widened it in a fourth — deletes on the series table, for the cleanup pass
# that followed a delete or an eviction — and ADR 0007 retired that one by
# deleting the pass. This table's grant is ADR 0005's original `Query` again.
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

  # The abuse table (#29): per-IP request windows and blocks, on-demand, TTL'd.
  # Same naming convention as the four above, resolved at runtime by
  # storageTableName('abuse', …) in @cumulo/storage.
  abuse_table_arn = "${local.dynamodb_table_arn_prefix}/cumulo-abuse-${var.environment}"

  # An index ARN is the table ARN plus /index/<name>, and a grant on the table
  # does not cover it — which is why this is a separate statement below rather
  # than a wildcard on the sites table. The name mirrors the
  # `global_secondary_index` block in infra/storage/tables.tf and
  # `USER_SITES_INDEX` in @cumulo/storage; all three are the same string, and a
  # typo here is an AccessDenied at eviction time, not a plan error.
  user_sites_index_arn = "${local.sites_table_arn}/index/user-sites-by-age"
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
  # The sites table, read and written. `Query` is `listFleetSites` (the base
  # table's single `FLEET` partition), `GetItem` is `getFleetSite`, `PutItem` is
  # both create and the write half of PUT's read-modify-write, `DeleteItem` is
  # DELETE.
  #
  # `UpdateItem` is #29's addition, and it is not an update to a *site*: it is
  # the `ADD userSiteCount :one` half of the cap transaction on the counter item
  # at (`FLEET`, `#META#counters`), which lives in this same table (ADR 0002).
  # TransactWriteItems carries no IAM action of its own — each item in the
  # transaction is authorised as the plain action it performs — so the create,
  # evict-and-create and counted-delete transactions in @cumulo/storage need
  # exactly Put, Update and Delete here and nothing more. Still no
  # `BatchWriteItem`: PUT stays a read-modify-write through `putFleetSite` so
  # the whole item is one reviewed shape, and nothing writes more than one site
  # at a time.
  #
  # The `sites` table's two GSIs are still not covered by this statement — an
  # index ARN is the table ARN plus /index/<name>, and a grant on the table is
  # not a grant on its indexes. `user-sites-by-age` gets its own statement
  # below; `by-location` deliberately gets none, because
  # `listActiveSitePhysicsAtLocation` belongs to #12's forecast service with its
  # own grant and no API route reads it.
  statement {
    sid = "ReadWriteFleetSites"
    actions = [
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
      "dynamodb:DeleteItem",
      "dynamodb:Query",
    ]
    resources = [local.sites_table_arn]
  }

  # The eviction index, read only. `oldestUserSite` queries
  # `user-sites-by-age` — partition `gsiUserSites`, sorted by `gsiCreatedAt`,
  # ascending, Limit 1 — to find the oldest *user* site when a create hits the
  # cap. The index is sparse by construction (ADR 0002): seed sites carry no
  # `gsiUserSites` attribute, so they are not in it, and eviction cannot reach
  # them however the query is written. That structural exemption is the reason
  # this is a Query on an index and not a scan-and-filter on the table.
  #
  # `Query` only. Nothing writes through an index — a write to the base table is
  # what maintains it — so a write action here would be meaningless as well as
  # broader.
  statement {
    sid       = "QueryUserSitesByAge"
    actions   = ["dynamodb:Query"]
    resources = [local.user_sites_index_arn]
  }

  # The series table, read only — ADR 0005's original sentence for this table,
  # restored. `querySeriesRange` is the only caller, behind
  # `GET /v1/sites/{siteId}/forecast`, `GET /v1/sites/{siteId}/series`,
  # `GET /v1/fleet/actuals` and `GET /v1/fleet/forecast`; the API creates no
  # series row, because forecast rows are written by #12 and the generation
  # readings beside them by the forecast service's simulated-actuals producer
  # (#264, `apps/forecast/src/simulate-actuals.ts`, which carries its own grants
  # in infra/forecast/iam.tf). There is deliberately no `PutItem` and no
  # `UpdateItem`, which is the grant-level statement of that.
  #
  # No write action of any kind, and that is a decision rather than an omission.
  # #29 briefly held deletes here for a pass that drained a departed site's
  # partition on the request path; ADR 0007 deleted the pass, so the rows a
  # deleted or evicted site leaves behind now expire on this table's own 90-day
  # TTL instead (ADR 0002's `expiresAt`, enabled in infra/storage/tables.tf).
  # That TTL is the sole deletion mechanism for series rows, and it is
  # deliberately not punctual — an expired row is gone eventually, not at a
  # named moment — which is affordable precisely because nothing reads a
  # departed site's series. Nothing this role can do removes a series row: the
  # API cannot destroy history it does not write. No GSI ARN; the series table
  # has none.
  statement {
    sid       = "ReadSeries"
    actions   = ["dynamodb:Query"]
    resources = [local.series_table_arn]
  }

  # The abuse table (#29), the per-IP limiter's whole state. Three actions and
  # no more:
  #
  #   * `UpdateItem` — `ADD requestCount :one` on the current 60-second window
  #     item, which is the counting itself: an atomic increment that returns the
  #     new count, so two concurrent requests from one IP cannot both read the
  #     same number.
  #   * `GetItem` — the block lookup on the request path.
  #   * `PutItem` — writing a block when a window overflows.
  #
  # No `DeleteItem`: blocks expire on the table's TTL rather than being cleared
  # by the function, so nothing this role can do shortens a block. Lifting one
  # early is an operator action with operator credentials (the runbook's
  # `aws dynamodb delete-item`), which is the right place for it. No `Query`
  # either — every access is by the exact `pk`.
  statement {
    sid = "ReadWriteAbuseState"
    actions = [
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
    ]
    resources = [local.abuse_table_arn]
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
