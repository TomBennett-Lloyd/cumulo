# The ingestion function: one hourly cycle of the fleet, per ADR 0001's
# cron-triggered deployable.

locals {
  function_name = "cumulo-ingestion-${var.environment}"

  # Built by `pnpm --filter @cumulo/ingestion build` before every apply — the
  # path is a contract between this stack and that build script, not a
  # discovery. Terraform does not build it: a `null_resource` running pnpm from
  # a plan is the kind of infrastructure that works on one machine.
  #
  # Consequence worth knowing before the first plan fails: a missing artefact is
  # a *plan* error, by the precondition below, rather than an apply error. That
  # is the intended ordering — the runbook in infra/README.md builds first.
  artifact_path = "${path.module}/../../apps/ingestion/dist/handler.zip"
}

resource "aws_lambda_function" "ingestion" {
  function_name = local.function_name
  role          = aws_iam_role.ingestion.arn

  # nodejs22.x matches the repo's .nvmrc line, so what CI tests and what AWS
  # runs are the same major.
  runtime = "nodejs22.x"

  # `main.handler` — the composition root in apps/ingestion, which is the only
  # module that constructs AWS clients. Everything beneath it takes its
  # dependencies as arguments (architecture rule 3), which is why the handler
  # itself is testable without a Lambda.
  handler = "main.handler"

  filename = local.artifact_path

  # Without this, Terraform compares only the filename and a rebuilt artefact
  # never deploys — the classic silent no-op deploy.
  #
  # The `fileexists` guard is not defensiveness, it is the seam between two
  # different questions. `terraform validate` evaluates function calls whose
  # arguments are known, so an unguarded `filebase64sha256` makes "is this
  # configuration well-formed?" depend on "has somebody run pnpm build?" — and
  # CI, which validates every stack on every push and never builds an artefact,
  # would fail on a stack that is perfectly correct. The guard separates them,
  # and the precondition below is what keeps the missing-artefact case loud: it
  # is checked at plan time, where the question is legitimate.
  source_code_hash = fileexists(local.artifact_path) ? filebase64sha256(local.artifact_path) : null

  # 300 s, sized against the worst case the cycle can actually take rather than
  # rounded up for comfort. Locations are fetched **sequentially** (a deliberate
  # choice in cycle.ts: the fleet's fetches are one shared draw on Open-Meteo's
  # rate limit), and there are structurally 12 of them — `docs/design/
  # fleet-simulation.md`'s co-location is enforced in @cumulo/shared post-#78,
  # so 12 is a property of the fleet rather than a coincidence of the current
  # seed data. Each location is one 10 s attempt plus at most one retry after up
  # to 1 s of full jitter, so 12 × ~21 s ≈ 252 s of fetching in the worst case,
  # leaving headroom for the DynamoDB batch writes and the SQS sends.
  #
  # This is also the number the queue's visibility timeout is *not* derived
  # from — that one is 6× the #12 *consumer's* timeout (see transport.tf).
  timeout = 300

  # 256 MB. The work is I/O-bound — HTTP, DynamoDB, SQS — so memory buys CPU
  # this function does not use; the reason to sit above the 128 MB floor is that
  # a cycle holds 12 locations' worth of parsed JSON (~576 readings) and the
  # AWS SDK clients at once. Free-tier compute is measured in GB-seconds, and
  # 720 invocations/month at 256 MB is a rounding error against the always-free
  # 400,000 GB-seconds.
  memory_size = 256

  environment {
    variables = {
      # The suffix that resolves every table name at runtime, via
      # storageTableName() in @cumulo/storage. Passed rather than baked in, so
      # a second environment is a variable change and not a code change.
      CUMULO_ENV = var.environment

      # Read from the resource rather than assembled from account id and name:
      # a queue URL is server-assigned, and hand-assembling one is how a
      # configuration ends up pointing at a queue that does not exist.
      QUEUE_URL = aws_sqs_queue.weather_readings.url
    }
  }

  # Lambda creates its own log group on first invocation if one is absent — with
  # never-expiring retention, and outside Terraform's ownership, so
  # `terraform destroy` leaves it behind billing for storage forever. Declaring
  # it explicitly (below) is what makes retention a decision and teardown
  # complete; the dependency is what stops Lambda from winning the race.
  depends_on = [aws_cloudwatch_log_group.ingestion]

  lifecycle {
    # Fail at plan, with a sentence that says what to run, rather than at apply
    # with the provider's "unable to load ...: no such file or directory". This
    # is the check `source_code_hash`'s guard above deliberately moved out of
    # `terraform validate`: the artefact's absence is a real error in every
    # context where an apply is intended, and none of the contexts where only
    # the configuration is being checked.
    precondition {
      condition     = fileexists(local.artifact_path)
      error_message = "No Lambda artefact at apps/ingestion/dist/handler.zip. Run `pnpm --filter @cumulo/ingestion build` from the repo root before planning or applying this stack (see the ingestion runbook in infra/README.md)."
    }
  }
}

resource "aws_cloudwatch_log_group" "ingestion" {
  # The name is fixed by Lambda, not chosen: this is the group Lambda writes to,
  # so it has to be exactly /aws/lambda/<function name>.
  name = "/aws/lambda/${local.function_name}"

  # 30 days. The handler emits one JSON line per location plus a cycle summary —
  # ~13 lines an hour, kilobytes a month — so retention is not a cost decision
  # at this volume; it is a decision that the logs are for diagnosing the last
  # few weeks of cycles, not an archive. `cumulo-weather` holds the data itself
  # for 90 days (ADR 0002), and the logs are not the record.
  retention_in_days = 30
}
