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
# bytes (~$0.0003/month at current volume) and the three alarms ($0.10 per
# alarm-month at list). Both are absorbed by always-free pools, not free.
# ---------------------------------------------------------------------------
#   * CloudWatch Logs — the at-rest line, and the reason the older phrasing here
#     ("no resource that bills for existing") was retired. Retained bytes bill
#     ~$0.03/GB-month whether or not anybody reads them, so a forgotten stack
#     keeps accruing this. What stops it accruing *without bound* is
#     `retention_in_days = 30` in lambda.tf: storage is a rolling month, not an
#     archive — and a group Lambda auto-creates instead would never expire (see
#     the comment on the function's `depends_on`). Size: one JSON line per
#     location plus a cycle summary, ~13 an hour, so ~9,400 lines and under
#     ~10 MB/month retained — ~$0.0003/month at list, and $0.00 as billed
#     because it sits inside the always-free 5 GB of stored logs (a separate
#     5 GB covers ingestion of them). That ~10 MB is a **bound, not a
#     measurement**: it takes ADR 0005's own ~6.5 GB/month at 25.92 M requests,
#     which implies ~250 bytes per logged record, and rounds up to 1 KB a line.
#   * CloudWatch alarms — three, alongside storage's four, the api's two and
#     forecast's one: the always-free ten, fully spent. An alarm is priced at
#     $0.10/month for existing, fired or not, so the ten are a pool rather than
#     a discount and the eleventh anywhere in the platform is real money.
#     infra/README.md's alarm budget owns the count. Lambda and SQS metrics are
#     free.
#   * Lambda — ~720 invocations/month (one an hour) against the always-free
#     1,000,000 requests and 400,000 GB-seconds. At 256 MB and even a full
#     300-second cycle that is ~54,000 GB-seconds, ~13% of the free allowance,
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
# nothing. The log group is the part of a forgotten stack that does keep
# spending; retention is what keeps that a fraction of a cent.

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
