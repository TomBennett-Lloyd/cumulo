# None of these values embeds the AWS account id, so all three are safe to quote
# in a PR body or an issue comment — unlike the ingestion stack's `queue_url`.
# That is a property of what this stack outputs rather than of what it knows:
# the queue ARN it assembles internally does carry the account id, and it is
# deliberately not surfaced here. Nothing outside this stack needs it (ingestion
# owns the queue and outputs its URL), so publishing it would create a
# convention-7 hazard for no consumer.
#
# ---------------------------------------------------------------------------
# IDLE COST: $0/month. This stack has no resource that bills for existing.
# ---------------------------------------------------------------------------
#   * Lambda — invoked only when ingestion publishes: ~12 messages an hour,
#     ~8,760 invocations/month against the always-free 1,000,000 requests. At
#     256 MB, even a full 50-second invocation is 12.8 GB-seconds, so the whole
#     month is ~112,000 GB-seconds worst case against the always-free 400,000 —
#     and a real invocation is a small fraction of its timeout.
#   * SQS — this stack creates no queue, and its event source mapping's polling
#     receives are the ~657,000/month ADR 0004 already counted in the platform's
#     ~675,000 against the always-free 1,000,000. No new cost line, only the
#     resource that realises the one already budgeted.
#   * CloudWatch — one alarm, the ninth of the free 10; Lambda metrics are free;
#     ~12 log lines an hour at 30-day retention is pennies at most against the
#     free 5 GB of ingestion.
#   * IAM — the execution role, its inline policy, and the deploy grant are all
#     free.
#
# `terraform destroy` takes all of it to $0 with no ordered dependencies: the
# event source mapping is deleted before the function it targets, and the queue
# it reads survives because another stack owns it. A forgotten forecast stack
# costs nothing — but, unlike the api stack, it is not inert: it keeps draining
# ingestion's queue, which is usually the behaviour you want.

output "function_name" {
  description = "Name of the forecast function, for `aws lambda invoke` and for `aws logs tail /aws/lambda/<name>`. Echoes the cumulo-forecast-<environment> convention so an operator reads the value Terraform actually applied instead of retyping it — the deploy workflow hardcodes the same name."
  value       = aws_lambda_function.forecast.function_name
}

output "log_group_name" {
  description = "Name of the forecast function's CloudWatch log group — /aws/lambda/cumulo-forecast-<environment>. Surfaced because this stack is the one whose output is hardest to see any other way: it has no endpoint to curl and no queue of its own to count, so the log is the primary evidence that a message was processed. Declared in Terraform rather than left for Lambda to create, which is what makes its 30-day retention a decision and `terraform destroy` complete."
  value       = aws_cloudwatch_log_group.forecast.name
}

output "environment" {
  description = "Environment suffix this stack was applied with (echoes var.environment). Must match the storage and ingestion stacks' `environment` outputs: the IAM policy grants access to cumulo-sites-<environment>'s by-location index and cumulo-series-<environment>, the event source mapping targets cumulo-weather-readings-<environment>, and the function resolves the table names from CUMULO_ENV at runtime — so a mismatch is a function wired to resources that do not exist."
  value       = var.environment
}
