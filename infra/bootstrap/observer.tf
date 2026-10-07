# The observer identity (#604): the one long-lived AWS credential this project
# holds, read-only, for the orchestrating session's incident watch
# (.claude/skills/incident-watch/SKILL.md). Terraform creates the user and its
# policy and never the access key, so no secret reaches state or the repo; the
# operator creates the key by hand straight into a local CLI profile (the
# observer runbook in infra/README.md).
#
# Account-level like the GitHub Actions role in oidc.tf, but the log-group
# grant names one environment's Lambdas, so the user carries that suffix.

locals {
  observer_user_name = "cumulo-observer-${var.observed_environment}"

  # The policy's whole vocabulary. .claude/scripts/incident-watch.test.sh holds
  # the Allow statements to exactly this list and fails on a write action.
  observer_actions = [
    "cloudwatch:DescribeAlarms",
    "cloudwatch:DescribeAlarmHistory",
    "cloudwatch:GetMetricData",
    "logs:FilterLogEvents",
  ]

  observed_log_group_arns = [
    for service in ["api", "ingestion", "forecast"] :
    "arn:aws:logs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:log-group:/aws/lambda/cumulo-${service}-${var.observed_environment}:*"
  ]
}

resource "aws_iam_user" "observer" {
  name = local.observer_user_name

  # The access key is created outside Terraform, and IAM refuses to delete a
  # user that still has one; this lets `terraform destroy` remove it too.
  force_destroy = true
}

data "aws_iam_policy_document" "observer" {
  statement {
    sid    = "ReadAlarms"
    effect = "Allow"
    actions = [
      "cloudwatch:DescribeAlarms",
      "cloudwatch:DescribeAlarmHistory",
    ]
    resources = ["arn:aws:cloudwatch:${var.aws_region}:${data.aws_caller_identity.current.account_id}:alarm:*"]
  }

  statement {
    sid     = "ReadMetrics"
    effect  = "Allow"
    actions = ["cloudwatch:GetMetricData"]
    # GetMetricData takes no alarm or metric ARN, so `*` is the only form IAM
    # accepts for it.
    resources = ["*"]
  }

  statement {
    sid       = "ReadLambdaLogs"
    effect    = "Allow"
    actions   = ["logs:FilterLogEvents"]
    resources = local.observed_log_group_arns
  }

  # An explicit Deny outranks any Allow, so a policy attached to this user by
  # mistake later cannot widen it past the four reads.
  statement {
    sid         = "DenyEverythingElse"
    effect      = "Deny"
    not_actions = local.observer_actions
    resources   = ["*"]
  }
}

resource "aws_iam_user_policy" "observer" {
  name   = "cumulo-observer-read-only"
  user   = aws_iam_user.observer.name
  policy = data.aws_iam_policy_document.observer.json
}
