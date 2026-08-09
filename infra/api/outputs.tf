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
# IDLE COST: $0.00/month as billed — which is an allowance, not the absence of
# a price. Two lines here bill for merely existing: the log group's stored
# bytes (~$0.0001/month at demo volume) and the two alarms ($0.10 per
# alarm-month at list). Both are absorbed by always-free pools, not free.
# ---------------------------------------------------------------------------
#   * CloudWatch Logs — the at-rest line, and the reason the older phrasing here
#     ("no resource that bills for existing") was retired. Retained bytes bill
#     ~$0.03/GB-month whether or not anybody reads them, so a forgotten stack
#     keeps accruing this. What stops it accruing *without bound* is
#     `retention_in_days = 30` in lambda.tf: storage is a rolling month, not an
#     archive — and a group Lambda auto-creates instead would never expire (see
#     the comment on the function's `depends_on`). Unlike ingestion's and
#     forecast's, this volume is not a constant — it tracks traffic, and the
#     traffic is unauthenticated. What the application itself writes is the part
#     a log estimate gets wrong, so what this comment owes you is the property
#     rather than a tally: **no application line rides on a request that goes
#     well**, read or write — every sink is a failure path, reached only by a
#     request that is already going wrong. The sinks themselves are the exported
#     `*Event` name constants under `apps/api/src`, one beside each handler that
#     emits it and one at main.ts's error boundary; that declaration set is the
#     census, and reading it is what a count restated here cannot substitute for,
#     because the count is wrong from the next route onwards. So the unit
#     CloudWatch bills is Lambda's own START, END and REPORT, **three lines per
#     invocation** (a cold start adds an INIT_START), and the failure-path lines
#     ride on top of it. That is sound at demo volume rather than merely
#     convenient: the traffic is dominated by reads and Swagger UI assets, so the
#     handful of failure-path lines is a rounding error against 10,000 requests.
#     Those three platform lines are exactly what ADR 0005's ~250 bytes per
#     *invocation* measures; it was never a per-application-record figure. At
#     demo volume (order 10,000 requests/month)
#     **10,000 × ~250 B ≈ 2.5 MB/month** retained, ~$0.00008/month at list and
#     $0.00 as billed inside the account's always-free 5 GB of stored logs.
#     This stack is quoted at that measured size rather than at the 1 KB-per-line
#     ceiling ingestion and forecast use, and infra/README.md's cost preamble
#     states the rule: with no application line on the dominant path there is
#     nothing to cushion against, and the same figure feeds the ≈ $36 bound, which
#     a 4× cushion would overstate rather than bound. At the bound itself the same line
#     is ~1.5 GB past the free 5 GB of storage — ~$0.05/month, immaterial beside
#     the ≈ $36 the bound is made of, and bounded only because retention is
#     30 days.
#   * CloudWatch alarms — two, joining storage's four, ingestion's three and
#     forecast's one: the always-free ten, fully spent. An alarm is priced at
#     $0.10/month for existing, fired or not, so the ten are a pool rather than
#     a discount and the eleventh anywhere in the platform is real money.
#     infra/README.md's alarm budget owns the count. API Gateway and Lambda
#     metrics are free.
#   * API Gateway HTTP API — $1.00 per million requests, no per-hour charge, no
#     minimum, no per-stage fee. An idle API costs nothing, and one somebody
#     forgets to destroy costs only its log group's fraction of a cent. This is
#     the property ADR 0005 chose it for, against an ALB's ≈ $16.43/month of
#     standing charge. There are no access logs on the stage to add a second
#     log group — gateway.tf says why at the point of temptation.
#   * Lambda — request-driven, so an idle stack invokes nothing at all. At demo
#     volume (order 10,000 requests/month) both the always-free 1,000,000
#     requests and the 400,000 GB-seconds are untouched; at 256 MB and ~100 ms
#     the compute allowance covers 16 million requests/month. The stored
#     deployment package is not a third at-rest line: Lambda code storage
#     carries no charge inside its 75 GB per-Region quota.
#   * IAM — the execution role, its inline policy, the Lambda permission and the
#     deploy grant are all free.
#
# The worst case is bounded rather than free, which is the honest version:
# ≈ $36/month with the stage throttle pegged continuously for a month (ADR
# 0005's arithmetic). `terraform destroy` takes all of it to $0 with no ordered
# dependencies and nothing left behind — including the log group, which is
# Terraform's here precisely so that teardown is complete.

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
