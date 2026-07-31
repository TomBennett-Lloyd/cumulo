# Queue URLs and function names are safe to quote anywhere; the queue URL does
# embed the AWS account id, so per infra/README.md convention 7 do not paste raw
# output into committed files, PR bodies, or issue comments — quote the shape
# (`https://sqs.<region>.amazonaws.com/<account-id>/cumulo-weather-readings-dev`),
# not the digits. It is not marked `sensitive`: the account id is an identifier
# rather than a credential, and marking it would only push every consumer to
# `-raw` while protecting nothing.
#
# ---------------------------------------------------------------------------
# IDLE COST: $0/month. This stack has no resource that bills for existing.
# ---------------------------------------------------------------------------
#   * Lambda — ~720 invocations/month (one an hour) against the always-free
#     1,000,000 requests and 400,000 GB-seconds. At 256 MB and even a full
#     300-second cycle that is ~54,000 GB-seconds, ~13% of the free allowance,
#     and a real cycle is a fraction of it.
#   * EventBridge — scheduled rules and their invocations are not charged at
#     all. $0 by pricing, not by allowance.
#   * SQS — ADR 0004's arithmetic: ~8,760 sends/month plus about as many
#     deletes, plus the consumer's event-source-mapping polling floor of five
#     long-polling connections at a 20 s wait — ~657,000 ReceiveMessage calls a
#     month. ~675,000 total against the always-free 1,000,000 requests, which is
#     the figure to watch: a *second* ESM-driven queue crosses the million
#     (ADR 0004 revisit trigger 5). Beyond it SQS is $0.40/million, so even
#     doubling the polling floor costs ~$0.27/month.
#   * CloudWatch — two alarms inside the free 10; Lambda and SQS metrics are
#     free; ~13 log lines an hour at 30-day retention is pennies at most, and
#     the free tier is 5 GB of ingestion.
#
# `terraform destroy` takes all of it to $0 with no ordered dependencies, no
# final snapshot, and no detaching network interfaces — and, unlike the Kinesis
# stream ADR 0004 replaced, a queue nobody remembers to destroy costs nothing
# either.

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
