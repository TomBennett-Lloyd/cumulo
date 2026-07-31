# Unlike the ingestion stack's queue URL, none of these values embeds the AWS
# account id — an API Gateway endpoint is `https://<api-id>.execute-api.
# <region>.amazonaws.com`, and the api id is server-assigned and unrelated to
# the account. They are safe to quote in a PR body or an issue comment.
#
# What the endpoint is *not* is predictable. The api id is assigned at create
# time, so the URL is read from this output after an apply and never assembled
# from a template — ADR 0005 names that explicitly. Anything that needs it (the
# smoke checks in apps/api/README.md, a web app's configuration) takes it from
# here.
#
# ---------------------------------------------------------------------------
# IDLE COST: $0/month. This stack has no resource that bills for existing.
# ---------------------------------------------------------------------------
#   * API Gateway HTTP API — $1.00 per million requests, no per-hour charge, no
#     minimum, no per-stage fee. An idle API costs nothing, and so does one
#     somebody forgets to destroy. This is the property ADR 0005 chose it for,
#     against an ALB's ≈ $16.43/month of standing charge.
#   * Lambda — request-driven, so an idle stack invokes nothing at all. At demo
#     volume (order 10,000 requests/month) both the always-free 1,000,000
#     requests and the 400,000 GB-seconds are untouched; at 256 MB and ~100 ms
#     the compute allowance covers 16 million requests/month.
#   * CloudWatch — two alarms joining storage's four and ingestion's two, inside
#     the always-free ten; API Gateway and Lambda metrics are free; logs at
#     30-day retention are kilobytes a month at demo volume against the free
#     5 GB of ingestion.
#
# The worst case is bounded rather than free, which is the honest version:
# ≈ $36/month with the stage throttle pegged continuously for a month (ADR
# 0005's arithmetic). `terraform destroy` takes all of it to $0 with no ordered
# dependencies and nothing left behind.

output "api_endpoint" {
  description = "Base URL of the deployed fleet API — https://<api-id>.execute-api.<region>.amazonaws.com, with no stage segment because the stage is `$default` (gateway.tf). Server-assigned: the api id is assigned at create time, so capture this after an apply rather than predicting it (ADR 0005). Append /openapi.json, /docs or /v1/sites to reach the routes."

  # The API's own attribute rather than the stage's `invoke_url`. Both resolve
  # to the same string for a `$default` stage, but only this one does so without
  # depending on how the provider special-cases the `$default` name — and a
  # base URL that silently gained a `/$default` segment would break every path
  # in the OpenAPI document at once. The stage is created by the same apply, so
  # there is no window in which this prints a URL that serves nothing.
  value = aws_apigatewayv2_api.api.api_endpoint
}

output "function_name" {
  description = "Name of the fleet API function, for `aws lambda update-function-code` and for `aws logs tail /aws/lambda/<name>`. Echoes the cumulo-api-<environment> convention so an operator reads the value Terraform actually applied instead of retyping it — the deploy workflow hardcodes the same name."
  value       = aws_lambda_function.api.function_name
}

output "environment" {
  description = "Environment suffix this stack was applied with (echoes var.environment). Must match the storage stack's `environment` output: the IAM policy grants access to cumulo-sites-<environment> and cumulo-series-<environment>, and the function resolves the same names from CUMULO_ENV at runtime, so a mismatch is an API with permissions on tables that do not exist."
  value       = var.environment
}
