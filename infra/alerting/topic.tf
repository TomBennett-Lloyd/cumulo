# Where alarms go.
#
# Every `aws_cloudwatch_metric_alarm` in this repo was created without an
# `alarm_actions` list, and each of the four alarms.tf files said the same
# thing in its header: there is nowhere to send them yet, notification wiring
# arrives with #29. This is that arrival. Until now the alarms were real but
# passive — visible to `aws cloudwatch describe-alarms --state-value ALARM` and
# to nobody who was not already looking, which for a platform whose normal state
# is idle means visible to nobody.
#
# ONE topic for the whole platform, not one per stack. The alarms belong to four
# stacks but to a single operator, and per-stack topics would multiply the one
# genuinely manual step in this repo — an email subscription has to be confirmed
# by hand from the recipient's inbox — by the number of stacks, for no gain in
# routing: there is one recipient. The stacks stay uncoupled the way they always
# have, by *convention* rather than by wire (see the ARN note in each alarms.tf).
#
# ---------------------------------------------------------------------------
# IDLE COST: $0/month.
# ---------------------------------------------------------------------------
#   * A topic has no standing charge — SNS bills requests and deliveries, not
#     existence, so a forgotten topic costs nothing (the property every stack in
#     this repo preserves).
#   * Email deliveries: the first 1,000/month are free, then $2.00 per 100,000.
#     Ten alarms that should each fire zero times will not approach 1,000, and
#     an alarm flapping often enough to would be a much louder problem than its
#     bill.
#   * Publishes: the first 1,000,000 requests/month are free. Ten alarms.

# The recipient address, read exactly as infra/bootstrap/budget.tf reads it, and
# for exactly the reasons documented there and in infra/README.md convention 7:
# the address is personal data with no business in a public git history, so it
# lives in an operator-created SSM parameter and Terraform only ever reads it.
# One copy, in the account, in the region the stacks deploy to. Creating the
# parameter here would be circular — the value would have to arrive through a
# variable again, which is the thing the parameter exists to avoid.
#
# This is the second reader of that parameter. That is deliberate rather than
# duplication: the budget subscribes email addresses *directly* (a budget
# notification needs no topic and no confirmation, and an unconfirmed
# subscription would put a three-day floor under `terraform destroy` — budget.tf
# explains this at length), whereas a CloudWatch alarm action must be an ARN, so
# alarms cannot avoid a topic. The two stacks read one source of truth and reach
# the same inbox by the two different routes their resources require.
data "aws_ssm_parameter" "notification_email" {
  name = "/cumulo/notification-email"

  # SecureString on the default AWS-managed KMS key, which carries no charge —
  # the plaintext address is only available with decryption requested.
  with_decryption = true

  lifecycle {
    # The same postcondition as budget.tf, and it earns its place twice over
    # here. AWS accepts a malformed endpoint and then simply never delivers: an
    # `aws_sns_topic_subscription` with a display name or angle brackets in it
    # applies cleanly, sits in the console looking like a subscription, and
    # silences every alarm in the platform. This turns that silence into a loud
    # failure at plan time. The message describes the expected shape rather than
    # echoing the value.
    #
    # The character class excludes `<`, `>`, `,` and `;` as well as whitespace
    # and a second `@`, because those are exactly the characters the malformed
    # shapes are made of: excluding whitespace alone would still admit
    # `<tom@example.com>`.
    postcondition {
      condition     = can(regex("^[^@\\s<>,;]+@[^@\\s<>,;]+\\.[^@\\s<>,;]+$", self.value))
      error_message = "SSM parameter /cumulo/notification-email must hold a single plain email address (the user@example.com form) — no display name, no angle brackets, no comma-separated list. Fix it with: aws ssm put-parameter --name /cumulo/notification-email --type SecureString --overwrite --value <address>"
    }
  }
}

resource "aws_sns_topic" "alerts" {
  # Deterministic, no random suffix, same reasoning as convention 3 and the
  # bootstrap budget: the alarm stacks assemble this ARN from the name rather
  # than reading it from an output, so the name is an interface. A random
  # component would have to be published somewhere outside Terraform for the
  # other four stacks to find, and "somewhere outside Terraform" is where
  # infrastructure goes to become undocumented. After a teardown and a fresh
  # spin-up the topic comes back at the same ARN and every alarm action is still
  # correct.
  name = "cumulo-alerts-${var.environment}"

  display_name = "Cumulo alerts"

  # Standard topic, not FIFO. FIFO topics do not support the email protocol at
  # all (SQS-only delivery), and ordering has no meaning for an alarm state
  # change.

  # Deliberately NOT encrypted, and this is the trap worth naming. Turning on
  # server-side encryption with the AWS-managed key `alias/aws/sns` breaks
  # CloudWatch alarm delivery: the AWS-managed key's policy does not grant
  # cloudwatch.amazonaws.com the kms:GenerateDataKey it needs, so alarms
  # transition to ALARM, attempt to publish, fail invisibly, and the topic looks
  # healthy. Fixing it properly means a customer-managed key with a key policy
  # for the CloudWatch service principal — ~$1/month plus request charges, added
  # to a platform whose entire standing cost is currently $0 — in order to
  # encrypt an alarm name, a state, and a description that are all public in
  # this repo already. The one piece of personal data in the pipeline is the
  # subscriber's address, and that is held in the subscription, not in a
  # message.

  # No `policy` either. A CloudWatch alarm in the *same account* publishes under
  # the default topic policy, which grants the topic owner's account the SNS
  # actions; an explicit policy is only required for a cross-account publisher
  # or a service principal outside the account. Writing one here would be a
  # policy that grants what is already granted, and one more thing to keep
  # correct as stacks are added.
}

# The one manual step in this repo.
#
# Terraform creates this subscription in `PendingConfirmation` and reports
# success. It cannot do better: an email subscription is confirmed by the
# recipient clicking a link, which is the entire point of the protocol, and
# there is no API for Terraform to do it on the operator's behalf. So a green
# apply is NOT evidence that alerts will be delivered — the runbook's
# `aws sns list-subscriptions-by-topic` check is, and it is written to fail on
# the literal string `PendingConfirmation`.
#
# Confirm it promptly for a second reason, the one budget.tf avoided a topic to
# escape: an *unconfirmed* subscription cannot be deleted for three days, which
# would put a three-day floor under `terraform destroy` of this stack. A
# confirmed one deletes immediately, so the clean-teardown property survives
# exactly as long as the confirmation is not left sitting in an inbox.
resource "aws_sns_topic_subscription" "notification_email" {
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = data.aws_ssm_parameter.notification_email.value

  # No `filter_policy`: every alarm on this topic is one an operator is meant to
  # read. A filter here would be a way to make an alarm quieter than the alarm
  # itself admits to being, which is the failure mode alarms.tf's threshold
  # comments all argue against.
}
