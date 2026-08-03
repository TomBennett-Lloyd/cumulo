# The forecast function: one location's horizon turned into per-site series,
# per ADR 0001's queue-triggered deployable and ADR 0003's TypeScript runtime.
#
# Unlike ingestion, nothing here is woken by a clock. The trigger is the
# `cumulo-weather-readings-<env>` queue (event-source.tf), so the unit of work
# is a message rather than a cycle, and the timeout below is a per-message bound
# rather than a per-fleet one.

locals {
  function_name = "cumulo-forecast-${var.environment}"

  # Built by `pnpm --filter @cumulo/forecast-service build` before every apply —
  # the path is a contract between this stack and that build script, not a
  # discovery. Terraform does not build it: a `null_resource` running pnpm from
  # a plan is the kind of infrastructure that works on one machine.
  #
  # Consequence worth knowing before the first plan fails: a missing artefact is
  # a *plan* error, by the precondition below, rather than an apply error. That
  # is the intended ordering — the runbook in infra/README.md builds first.
  artifact_path = "${path.module}/../../apps/forecast/dist/handler.zip"
}

resource "aws_lambda_function" "forecast" {
  function_name = local.function_name
  role          = aws_iam_role.forecast.arn

  # nodejs22.x matches the repo's .nvmrc line, so what CI tests and what AWS
  # runs are the same major.
  runtime = "nodejs22.x"

  # `main.handler` — the composition root in apps/forecast, which is the only
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

  # 50 s, and this number is not free to change on its own.
  #
  # `infra/ingestion/transport.tf` sets the weather-readings queue's
  # `visibility_timeout_seconds = 300`, which is exactly 6 × 50. Six times the
  # consumer's function timeout is the floor ADR 0004's Consequences make
  # **non-optional**: below it, a slow invocation causes SQS to redeliver a
  # message that is still being processed. That is harmless duplicate work today
  # — every write on this path is an idempotent Put over a deterministic key —
  # and a correctness bug the moment a non-idempotent effect appears, which is
  # ADR 0004 revisit trigger 4.
  #
  # So: **raising this number requires raising
  # `visibility_timeout_seconds` in `infra/ingestion/transport.tf` in the same
  # change**, to at least 6× the new value. That file's comment states the
  # obligation from the queue's side and names this stack as the owner of the
  # other half; this comment is that other half. Lowering this number is safe on
  # its own — it only widens the margin — but leaves the queue over-provisioned
  # for a redelivery window nothing needs.
  #
  # That pairing is gated, so the obligation above is not left to whoever reads
  # this comment: `pnpm check:infra-mirrors`, in the `verify` composite and so
  # in CI, holds the queue's `visibility_timeout_seconds` at or above a declared
  # factor of six times this attribute — Terraform on both sides, a floor rather
  # than an equality — and fails on a one-sided edit (#133). The pair is
  # declared in .claude/scripts/check-infra-mirrors.sh, which is also where the
  # next such pair goes.
  #
  # Why 50 s is the right size for the work: one message is one location's
  # 48-hour horizon, so the invocation is a `by-location` GSI query for that
  # location's active sites, a pure physics evaluation per site, and one
  # BatchWriteItem run into `cumulo-series`. All of it is I/O against two AWS
  # services in the same region; 50 s is roughly an order of magnitude above the
  # expected duration, which is the margin a cold start plus a retried throttle
  # needs and no more.
  timeout = 50

  # 256 MB. The work is I/O-bound — DynamoDB in, DynamoDB out — with a pure
  # physics evaluation in between that is arithmetic over a few hundred
  # readings, so memory buys CPU this function barely uses; the reason to sit
  # above the 128 MB floor is the AWS SDK clients plus one location's parsed
  # horizon and the series it produces, which is all a single invocation holds.
  # Free-tier compute is measured in GB-seconds, and ~8,760 invocations/month at
  # 256 MB is a rounding error against the always-free 400,000 GB-seconds.
  memory_size = 256

  environment {
    variables = {
      # The suffix that resolves every table name at runtime, via
      # storageTableName() in @cumulo/storage. Passed rather than baked in, so
      # a second environment is a variable change and not a code change.
      #
      # This is the only variable the function needs: unlike ingestion, it has
      # no queue URL to carry. A consumer is *handed* its messages by the event
      # source mapping and never names the queue at runtime — which is also why
      # the IAM policy's SQS grant is the only place the queue name appears in
      # this stack outside event-source.tf.
      CUMULO_ENV = var.environment
    }
  }

  # Lambda creates its own log group on first invocation if one is absent — with
  # never-expiring retention, and outside Terraform's ownership, so
  # `terraform destroy` leaves it behind billing for storage forever. Declaring
  # it explicitly (below) is what makes retention a decision and teardown
  # complete; the dependency is what stops Lambda from winning the race.
  depends_on = [aws_cloudwatch_log_group.forecast]

  lifecycle {
    # Fail at plan, with a sentence that says what to run, rather than at apply
    # with the provider's "unable to load ...: no such file or directory". This
    # is the check `source_code_hash`'s guard above deliberately moved out of
    # `terraform validate`: the artefact's absence is a real error in every
    # context where an apply is intended, and none of the contexts where only
    # the configuration is being checked.
    precondition {
      condition     = fileexists(local.artifact_path)
      error_message = "No Lambda artefact at apps/forecast/dist/handler.zip. Run `pnpm --filter @cumulo/forecast-service build` from the repo root before planning or applying this stack (see the forecast runbook in infra/README.md)."
    }
  }
}

resource "aws_cloudwatch_log_group" "forecast" {
  # The name is fixed by Lambda, not chosen: this is the group Lambda writes to,
  # so it has to be exactly /aws/lambda/<function name>.
  name = "/aws/lambda/${local.function_name}"

  # 30 days, matching every other function in the platform. This function emits
  # a line per message rather than per hour — ~12 an hour for the canonical
  # fleet, still kilobytes a month — so retention is not a cost decision at this
  # volume; it is a decision that the logs are for diagnosing the last few weeks
  # of forecasts, not an archive. `cumulo-series` holds the forecasts themselves
  # (ADR 0002), and the logs are not the record.
  retention_in_days = 30
}
