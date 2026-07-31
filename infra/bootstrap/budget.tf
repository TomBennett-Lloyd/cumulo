# The ~$100/month cost ceiling in CLAUDE.md is a convention right up until
# something in the account enforces it. This is that something: a monthly cost
# budget that emails the operator at graduated thresholds on actual spend, and
# once more on forecasted spend.
#
# It costs nothing to run. Notification-only budgets are free of charge; only
# *action-enabled* budgets bill (the first two free, then $0.10/day each), and
# this budget attaches no action — so enforcing the cost ceiling is itself $0,
# which is the only price a cost ceiling should be allowed to have.
#
# Subscribers are direct email addresses rather than an SNS topic. An SNS email
# subscription has to be confirmed by hand from the recipient's inbox, and an
# unconfirmed subscription cannot be deleted for three days — which would put a
# three-day floor under `terraform destroy` and break the clean teardown this
# stack exists to make possible. Budget notifications need no confirmation and
# add no resource to destroy.
#
# The FORECASTED threshold stays silent until AWS has roughly five weeks of
# usage history to forecast from, so a quiet forecast alarm on a young account
# is working as designed, not broken. The three ACTUAL thresholds cover that
# gap from the first dollar.
#
# The recipient address comes from the SSM parameter
# `/cumulo/notification-email`, created out-of-band by the operator (the
# `aws ssm put-parameter` command is in the runbook). Terraform only ever reads
# it: creating it here would be circular, because the value would then have to
# arrive through a variable again, which is the thing the parameter exists to
# avoid. The address therefore lands only in Terraform state — the private,
# encrypted, public-access-blocked bucket in state.tf — and never in a
# committed file, per convention 7: an email address is personal data with no
# business in a public git history.

data "aws_ssm_parameter" "notification_email" {
  name = "/cumulo/notification-email"

  # The parameter is a SecureString, so the plaintext address is only available
  # with decryption requested. It uses the default AWS-managed KMS key, which
  # carries no charge.
  with_decryption = true

  lifecycle {
    # A parameter holding a display name, angle brackets, or a comma-separated
    # list would not fail the apply: AWS accepts a malformed subscriber and
    # then simply never delivers, leaving a budget that looks healthy and
    # alerts nobody — the worst possible failure mode for the one control
    # standing between this project and the cost ceiling. This turns that
    # silence into a loud failure at plan time. The message describes the
    # expected shape rather than echoing the value.
    #
    # The character class excludes `<`, `>`, `,` and `;` as well as whitespace
    # and a second `@`, because those are exactly the characters the malformed
    # shapes are made of: excluding whitespace alone would still admit
    # `<tom@example.com>`, which AWS accepts and never delivers to.
    postcondition {
      condition     = can(regex("^[^@\\s<>,;]+@[^@\\s<>,;]+\\.[^@\\s<>,;]+$", self.value))
      error_message = "SSM parameter /cumulo/notification-email must hold a single plain email address (the user@example.com form) — no display name, no angle brackets, no comma-separated list. Fix it with: aws ssm put-parameter --name /cumulo/notification-email --type SecureString --overwrite --value <address>"
    }
  }
}

resource "aws_budgets_budget" "monthly_cost_ceiling" {
  # Deterministic, no random suffix (convention 3's reasoning applies here too):
  # after a teardown and a fresh spin-up the budget comes back under the same
  # name, so the teardown runbook's `aws budgets describe-budget` check and any
  # later reference to it stay correct.
  name = "cumulo-monthly-cost-ceiling"

  budget_type  = "COST"
  limit_amount = "100"
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  # Four notifications, chosen so the alerts arrive while there is still time
  # to act rather than as a post-mortem. Every one of them is GREATER_THAN on a
  # PERCENTAGE of the limit above, so the thresholds move with the limit if it
  # is ever changed.

  # 50% — half the month's ceiling. Early enough that whatever is burning can
  # be found and turned off before it matters.
  notification {
    comparison_operator        = "GREATER_THAN"
    notification_type          = "ACTUAL"
    threshold                  = 50
    threshold_type             = "PERCENTAGE"
    subscriber_email_addresses = [data.aws_ssm_parameter.notification_email.value]
  }

  # 80% — the "this is not going to be fine" signal.
  notification {
    comparison_operator        = "GREATER_THAN"
    notification_type          = "ACTUAL"
    threshold                  = 80
    threshold_type             = "PERCENTAGE"
    subscriber_email_addresses = [data.aws_ssm_parameter.notification_email.value]
  }

  # 100% — the ceiling has been crossed. Notification only; nothing is stopped
  # automatically, because a budget *action* would attach IAM permissions to
  # this stack and start the $0.10/day meter after the account's first two.
  notification {
    comparison_operator        = "GREATER_THAN"
    notification_type          = "ACTUAL"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    subscriber_email_addresses = [data.aws_ssm_parameter.notification_email.value]
  }

  # Forecast to exceed the ceiling by month end. This is the only alert that can
  # fire before the money is spent, which makes it the most useful of the four —
  # and the one that needs ~5 weeks of history before AWS will produce a
  # forecast at all. Until then the three ACTUAL thresholds are the whole alarm.
  notification {
    comparison_operator        = "GREATER_THAN"
    notification_type          = "FORECASTED"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    subscriber_email_addresses = [data.aws_ssm_parameter.notification_email.value]
  }
}
