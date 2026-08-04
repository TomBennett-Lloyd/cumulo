# Queue URLs and function names are safe to quote anywhere; the queue URL does
# embed the AWS account id, so per infra/README.md convention 7 do not paste raw
# output into committed files, PR bodies, or issue comments — quote the shape
# (`https://sqs.<region>.amazonaws.com/<account-id>/cumulo-weather-readings-dev`),
# not the digits. It is not marked `sensitive`: the account id is an identifier
# rather than a credential, and marking it would only push every consumer to
# `-raw` while protecting nothing.
#
# ---------------------------------------------------------------------------
# IDLE COST: $0.00/month as billed — which is an allowance, not the absence of
# a price. Two lines here bill for merely existing: the log group's stored
# bytes (~$0.0004/month at current volume) and the three alarms ($0.10 per
# alarm-month at list). Both are absorbed by always-free pools, not free.
# ---------------------------------------------------------------------------
#   * CloudWatch Logs — the at-rest line, and the reason the older phrasing here
#     ("no resource that bills for existing") was retired. Retained bytes bill
#     ~$0.03/GB-month whether or not anybody reads them, so a forgotten stack
#     keeps accruing this. What stops it accruing *without bound* is
#     `retention_in_days = 30` in lambda.tf: storage is a rolling month, not an
#     archive — and a group Lambda auto-creates instead would never expire (see
#     the comment on the function's `depends_on`). Size, counted rather than
#     assumed: **seventeen billed lines per cycle** — `ingestion.cycle.started`
#     from cycle.ts, one `ingestion.location.outcome` per location (12 in the
#     canonical fleet), `ingestion.cycle.summary` from handler.ts, plus Lambda's
#     own START, END and REPORT. At ~730 cycles/month (a 730-hour month, the
#     convention infra/README.md's cost preamble fixes) that is ~12,400 lines, so
#     **17 × 730 × 1 KB ≈ 12 MB/month** retained — ~$0.0004/month at
#     ~$0.03/GB-month, and $0.00 as billed because it sits inside the account's
#     always-free 5 GB of stored logs (a separate 5 GB covers ingestion of them).
#     That ~12 MB is a **bound, not a measurement**, and generously so: ADR
#     0005's own ~6.5 GB/month at 25.92 M requests works out at ~250 bytes per
#     *invocation*, and this prices 1 KB per *line* and then charges all
#     seventeen. The honest claim is a ceiling, not a meter reading.
#   * CloudWatch alarms — three, alongside storage's four, the api's two and
#     forecast's one: the always-free ten, fully spent. An alarm is priced at
#     $0.10/month for existing, fired or not, so the ten are a pool rather than
#     a discount and the eleventh anywhere in the platform is real money.
#     infra/README.md's alarm budget owns the count. Lambda and SQS metrics are
#     free.
#   * Lambda — ~730 invocations/month (one an hour) against the always-free
#     1,000,000 requests and 400,000 GB-seconds. At 256 MB and even a full
#     300-second cycle that is 730 × 300 s × 0.25 GB = 54,750 — ~55,000
#     GB-seconds, ~14% of the free allowance,
#     and a real cycle is a fraction of it. The stored deployment package is not
#     a third at-rest line: Lambda code storage carries no charge inside its
#     75 GB per-Region quota.
#   * EventBridge — scheduled rules and their invocations are not charged at
#     all. $0 by pricing, not by allowance.
#   * SQS — the queue and its DLQ bill requests, not bytes at rest: an idle or
#     backed-up queue has no storage charge, which is why neither appears above.
#     ADR 0004's arithmetic: ~8,760 sends/month plus about as many
#     deletes, plus the consumer's event-source-mapping polling floor of five
#     long-polling connections at a 20 s wait — ~657,000 ReceiveMessage calls a
#     month. ~675,000 total against the always-free 1,000,000 requests, which is
#     the figure to watch: a *second* ESM-driven queue crosses the million
#     (ADR 0004 revisit trigger 5). Beyond it SQS is $0.40/million, so even
#     doubling the polling floor costs ~$0.27/month.
#
# `terraform destroy` takes all of it to $0 with no ordered dependencies, no
# final snapshot, and no detaching network interfaces — and, unlike the Kinesis
# stream ADR 0004 replaced, a queue nobody remembers to destroy really does cost
# nothing. Within this stack the log group is the one thing that keeps spending,
# and retention keeps that a fraction of a cent; a schedule left *enabled* also
# meters the weather table's on-demand writes (#156, ~$0.30/mo at the canonical
# fleet), billed under the storage stack it writes into.

output "queue_url" {
  description = "URL of the weather-readings queue ingestion publishes to. This is the value #12's event source mapping consumes and the value the function's QUEUE_URL environment variable carries — server-assigned, so read it from here rather than assembling it from an account id. Contains the account id — see the note above."
  value       = aws_sqs_queue.weather_readings.url
}

output "function_name" {
  description = "Name of the ingestion function, for `aws lambda invoke` and for `aws logs tail /aws/lambda/<name>`. Echoes the cumulo-ingestion-<environment> convention so an operator reads the value Terraform actually applied instead of retyping it."
  value       = aws_lambda_function.ingestion.function_name
}

output "environment" {
  description = "Environment suffix this stack was applied with (echoes var.environment). Must match the storage stack's `environment` output: the IAM policy grants access to cumulo-sites-<environment> and cumulo-weather-<environment>, so a mismatch is a function with permissions on tables that do not exist."
  value       = var.environment
}
