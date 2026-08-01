# The fleet API function: one Node.js Lambda serving every route, per ADR 0005's
# "single Node.js Lambda behind an API Gateway HTTP API". The Swagger UI, the
# OpenAPI document and the API itself are one artefact with one lifecycle —
# that is the decision, and this file is the half of it that runs code.

locals {
  function_name = "cumulo-api-${var.environment}"

  # Built by `pnpm --filter @cumulo/api build` before every apply — the path is
  # a contract between this stack and that build script, not a discovery.
  # Terraform does not build it: a `null_resource` running pnpm from a plan is
  # the kind of infrastructure that works on one machine.
  #
  # Consequence worth knowing before the first plan fails: a missing artefact is
  # a *plan* error, by the precondition below, rather than an apply error. That
  # is the intended ordering — the runbook in infra/README.md builds first.
  artifact_path = "${path.module}/../../apps/api/dist/handler.zip"
}

resource "aws_lambda_function" "api" {
  function_name = local.function_name
  role          = aws_iam_role.api.arn

  # nodejs22.x matches the repo's .nvmrc line, so what CI tests and what AWS
  # runs are the same major.
  runtime = "nodejs22.x"

  # `main.handler` — the composition root in apps/api, which is the only module
  # that constructs AWS clients. Everything beneath it takes its dependencies as
  # arguments (architecture rule 3), which is why the router and the handlers
  # are testable without a Lambda or a gateway.
  handler = "main.handler"

  filename = local.artifact_path

  # Without this, Terraform compares only the filename and a rebuilt artefact
  # never deploys — the classic silent no-op deploy.
  #
  # The `fileexists` guard is not defensiveness, it is the seam between two
  # different questions, and it is copied deliberately from
  # infra/ingestion/lambda.tf rather than reinvented. `terraform validate`
  # evaluates function calls whose arguments are known, so an unguarded
  # `filebase64sha256` makes "is this configuration well-formed?" depend on "has
  # somebody run pnpm build?" — and CI, which validates every stack on every
  # push and never builds an artefact, would fail on a stack that is perfectly
  # correct. The guard separates them, and the precondition below is what keeps
  # the missing-artefact case loud: it is checked at plan time, where the
  # question is legitimate.
  source_code_hash = fileexists(local.artifact_path) ? filebase64sha256(local.artifact_path) : null

  # 15 s, chosen against the gateway rather than against the work. API Gateway's
  # integration timeout is a hard 30 s ceiling (ADR 0005), and every route here
  # is a single DynamoDB call or a static asset read — the widest one, a
  # 336-hour `GET /v1/sites/{siteId}/series`, is one Query of order a thousand
  # small items. Sitting the function's timeout *below* the gateway's ceiling is
  # what makes a hung request diagnosable: Lambda times out first, so the
  # evidence is a Lambda timeout log line and an `Errors` data point rather than
  # a gateway 504 with nothing behind it.
  timeout = 15

  # 256 MB, and this number is load-bearing beyond performance: it is the figure
  # ADR 0005's cost table is computed from. At 256 MB and a 100 ms average
  # duration each request costs 0.025 GB-seconds, so Lambda's always-free
  # 400,000 GB-seconds covers 16 million requests/month — the point the ADR
  # names as revisit trigger 2. Raising this lowers that number proportionally
  # and moves a line in the ADR's arithmetic, so it is a decision rather than a
  # tuning knob.
  memory_size = 256

  environment {
    variables = {
      # The suffix that resolves every table name at runtime, via
      # storageTableName() in @cumulo/storage. Passed rather than baked in, so
      # a second environment is a variable change and not a code change.
      CUMULO_ENV = var.environment

      # Extra browser origins the write routes accept, comma-separated (#29).
      # Empty here and empty by default: the API always allows its own origin,
      # computed per request from the gateway's domain name, so the Swagger UI
      # this function serves needs no entry. variables.tf carries the rest: what
      # this defends against, what it deliberately does not, and why #144's and
      # #21's origins arrive as tfvars rather than as edits to this file.
      #
      # An empty string rather than an absent variable: the value is always
      # present and always this variable, so "not configured" is one shape at
      # runtime instead of two.
      CUMULO_WEB_ORIGINS = var.web_origins
    }
  }

  # Lambda creates its own log group on first invocation if one is absent — with
  # never-expiring retention, and outside Terraform's ownership, so
  # `terraform destroy` leaves it behind billing for storage forever. Declaring
  # it explicitly (below) is what makes retention a decision and teardown
  # complete; the dependency is what stops Lambda from winning the race.
  depends_on = [aws_cloudwatch_log_group.api]

  lifecycle {
    # Fail at plan, with a sentence that says what to run, rather than at apply
    # with the provider's "unable to load ...: no such file or directory". This
    # is the check `source_code_hash`'s guard above deliberately moved out of
    # `terraform validate`: the artefact's absence is a real error in every
    # context where an apply is intended, and none of the contexts where only
    # the configuration is being checked.
    precondition {
      condition     = fileexists(local.artifact_path)
      error_message = "No Lambda artefact at apps/api/dist/handler.zip. Run `pnpm --filter @cumulo/api build` from the repo root before planning or applying this stack (see the api runbook in infra/README.md)."
    }
  }
}

resource "aws_cloudwatch_log_group" "api" {
  # The name is fixed by Lambda, not chosen: this is the group Lambda writes to,
  # so it has to be exactly /aws/lambda/<function name>.
  name = "/aws/lambda/${local.function_name}"

  # 30 days, the same decision as the ingestion stack's: the logs are for
  # diagnosing the last few weeks of requests, not an archive. Unlike ingestion,
  # this function's log volume is not a known constant — it scales with traffic,
  # and the traffic is unauthenticated. ADR 0005 costs that: ~6.5 GB/month at
  # the throttle ceiling held continuously, which is the one CloudWatch line in
  # the worst case that is not free. At demo volume it is kilobytes. Retention
  # is the lever that bounds *storage* on that; the throttle is what bounds
  # ingestion.
  retention_in_days = 30
}
