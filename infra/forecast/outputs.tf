# None of these values embeds the AWS account id, so all three are safe to quote
# in a PR body or an issue comment — unlike the ingestion stack's `queue_url`.
# That is a property of what this stack outputs rather than of what it knows:
# the queue ARN it assembles internally does carry the account id, and it is
# deliberately not surfaced here. Nothing outside this stack needs it (ingestion
# owns the queue and outputs its URL), so publishing it would create a
# convention-7 hazard for no consumer.
#
# ---------------------------------------------------------------------------
# IDLE COST: $0.00/month as billed — which is an allowance, not the absence of
# a price. Two lines here bill for merely existing: the log group's stored
# bytes (~$0.0013/month at current volume) and the alarm ($0.10/alarm-month at
# list). Both are absorbed by always-free pools rather than being free.
# ---------------------------------------------------------------------------
#   * CloudWatch Logs — the at-rest line, and the reason the older phrasing here
#     ("no resource that bills for existing") was retired. Retained bytes bill
#     ~$0.03/GB-month whether or not anybody reads them, so a forgotten stack
#     keeps accruing this. What stops it accruing *without bound* is
#     `retention_in_days = 30` in lambda.tf: storage is a rolling month, not an
#     archive — and a group Lambda auto-creates instead would never expire (see
#     the comment on the function's `depends_on`). Size, counted rather than
#     assumed: **five billed lines per invocation** — `forecast.message.outcome`
#     and `forecast.batch.summary` from handler.ts, one of each because
#     `batch_size = 1` (event-source.tf) makes a batch a single record, plus
#     Lambda's own START, END and REPORT. At ~8,760 invocations/month that is
#     ~43,800 lines, so **5 × 8,760 × 1 KB ≈ 44 MB/month** retained —
#     ~$0.0013/month at ~$0.03/GB-month, and $0.00 as billed because it sits
#     inside the account's always-free 5 GB of stored logs. That ~44 MB is a
#     **bound, not a measurement**, and generously so: ADR 0005's own
#     ~6.5 GB/month at 25.92 M requests works out at ~250 bytes per *invocation*,
#     and this prices 1 KB per *line* and then charges all five of them. The
#     honest claim is a ceiling, not a meter reading.
#   * CloudWatch alarms — one alarm, the tenth and last of the always-free ten.
#     An alarm is priced at $0.10/month for existing, fired or not; the ten are
#     a pool the platform has fully spent, not a discount, and infra/README.md's
#     alarm budget owns the count. Lambda metrics are free.
#   * Lambda — invoked only when ingestion publishes: ~12 messages an hour,
#     ~8,760 invocations/month against the always-free 1,000,000 requests. At
#     256 MB (0.25 GiB, the unit AWS bills), even a full 50-second invocation is
#     12.5 GB-seconds, so the whole month is ~110,000 GB-seconds worst case
#     against the always-free 400,000 —
#     and a real invocation is a small fraction of its timeout. The stored
#     deployment package is not a third at-rest line: Lambda code storage
#     carries no charge inside its 75 GB per-Region quota.
#   * SQS — this stack creates no queue, and its event source mapping's polling
#     receives are the ~657,000/month ADR 0004 already counted in the platform's
#     ~675,000 against the always-free 1,000,000. No new cost line, only the
#     resource that realises the one already budgeted. A queue holding messages
#     has no storage charge either — SQS bills requests, not bytes at rest.
#   * IAM — the execution role, its inline policy, and the deploy grant are all
#     free. So is the event source mapping resource itself.
#
# `terraform destroy` takes all of it to $0 with no ordered dependencies: the
# event source mapping is deleted before the function it targets, and the queue
# it reads survives because another stack owns it. A forgotten forecast stack
# costs a fraction of a cent — bounded, because retention is — but, unlike the
# api stack, it is not inert: it keeps draining ingestion's queue, which is
# usually the behaviour you want.

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
