# The topic ARN embeds the AWS account id, so per infra/README.md convention 7
# do not paste raw output into committed files, PR bodies, or issue comments —
# quote the shape (`arn:aws:sns:<region>:<account-id>:cumulo-alerts-dev`), not
# the digits. It is not marked `sensitive`: the account id is an identifier
# rather than a credential, and marking it would only push every consumer to
# `-raw` while protecting nothing.
#
# The subscriber's email address is NOT an output, and must not become one. It
# reaches this stack through a data source and lands in state (the private,
# encrypted, public-access-blocked bucket the bootstrap stack owns); an output
# would put it one `terraform output` away from a terminal transcript, a CI log,
# or a pasted PR body.
#
# ---------------------------------------------------------------------------
# IDLE COST: $0/month. See the arithmetic in topic.tf — SNS bills requests and
# deliveries, not existence, and ten alarms that should each fire zero times
# will not reach either free tier's floor.
# ---------------------------------------------------------------------------

output "topic_arn" {
  description = "ARN of the platform alerts topic. Every alarm stack assembles this same string from the naming convention rather than reading it from here — this output is for the operator's `aws sns list-subscriptions-by-topic` check and for confirming that what Terraform applied matches what the alarms point at. Contains the account id — see the note above."
  value       = aws_sns_topic.alerts.arn
}

output "environment" {
  description = "Environment suffix this stack was applied with (echoes var.environment). Must match the `environment` output of every stack that has alarms: those stacks build the topic ARN as cumulo-alerts-<environment>, so a mismatch is a set of alarms whose action points at a topic that does not exist — which fails silently, by never delivering."
  value       = var.environment
}
