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

  # 300 s. This number is no longer sized against a fleet size, and #115 is the
  # record of why: the previous rationale multiplied a location count nothing
  # enforced (12, a property of the seed fleet that #17's visitor sites are
  # designed to exceed, and that ADR 0002's own "Assumed scale" already puts at
  # ~30) by a per-location cost that priced two of a location's three effects at
  # zero. Both halves were arithmetic against a model of the system rather than
  # against the system.
  #
  # What replaced it is a bound the code enforces. apps/ingestion/src/
  # cycle-budget.ts multiplies out one location's genuinely worst case from the
  # constants the three effects declare — FETCH_WORST_MS ≈ 21 s, STORE_WORST_MS
  # ≈ 115 s, PUBLISH_WORST_MS ≈ 10.5 s, so LOCATION_WORST_MS ≈ 147 s — and
  # derives
  #
  #   CYCLE_DEADLINE_MS = INGESTION_LAMBDA_TIMEOUT_MS  (300_000, this value)
  #                     - LOCATION_WORST_MS            (≈ 147_000)
  #                     - SHUTDOWN_MARGIN_MS           (5_000)
  #                     ≈ 148_000
  #
  # runCycle checks that deadline before starting each location and never
  # interrupts one in flight, so the last location it can possibly start
  # finishes by 148 + 147 = 295 s, leaving 5 s to flush the summary log line.
  # The function timeout is therefore **unreachable by construction** rather
  # than merely generous — which matters because a Lambda killed at its timeout
  # is the one ingestion failure that produces no CycleFailedError, no summary,
  # and no account of which locations published. A cycle that runs out of budget
  # now reports every location it skipped instead.
  #
  # Note what this value does *not* bound: how many locations a cycle fetches.
  # That is MAX_LOCATIONS_PER_CYCLE, derived from the Open-Meteo daily allowance
  # in CLAUDE.md, because a count and a duration are two different resources.
  # The deadline protects this timeout; the cap protects the quota.
  #
  # Changing this number means changing INGESTION_LAMBDA_TIMEOUT_MS in
  # cycle-budget.ts to match — it mirrors this value and cites this file, as
  # this comment cites it. That pairing is gated: `pnpm check:infra-mirrors`,
  # in the `verify` composite and so in CI, compares the two and fails on a
  # one-sided edit (#123). The pair is declared in
  # .claude/scripts/check-infra-mirrors.sh, which is also where the next such
  # pair goes.
  #
  # A healthy twelve-location cycle finishes in seconds, so if the deadline ever
  # fires in production the constants above are wrong at their source, not the
  # mechanism.
  #
  # This is also the number the queue's visibility timeout is *not* derived
  # from — that one is 6× the #12 *consumer's* timeout (see transport.tf).
  timeout = 300

  # 256 MB. The work is I/O-bound — HTTP, DynamoDB, SQS — so memory buys CPU
  # this function does not use; the reason to sit above the 128 MB floor is the
  # AWS SDK clients plus one location's parsed horizon (48 readings), which is
  # all the cycle holds at once — locations are processed one at a time and only
  # their outcomes are accumulated. Free-tier compute is measured in
  # GB-seconds, and 720 invocations/month at 256 MB is a rounding error against
  # the always-free 400,000 GB-seconds.
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
