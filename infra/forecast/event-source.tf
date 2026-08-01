# The trigger, per ADR 0001's queue-woken deployable and ADR 0004's transport:
# `cumulo-weather-readings-<env>` drives this function through a Lambda event
# source mapping. This is the whole of the wiring — there is no rule, no
# schedule, and no `aws_lambda_permission`, because an ESM pulls from the queue
# under the *execution* role rather than being pushed to under a resource
# policy.

locals {
  # Assembled from the naming convention rather than read from ingestion's
  # remote state, for the same reason iam.tf assembles the table ARNs: the two
  # stacks share a name (ADR 0004 fixes it as
  # `cumulo-weather-readings-<environment>`), not a wire. A
  # terraform_remote_state data source would make this stack unable to plan
  # while ingestion's state was mid-apply, and would give it read access to the
  # whole of ingestion's state for one string it can compute.
  #
  # The account id comes from `data.aws_caller_identity` in iam.tf, so it never
  # appears in a committed file (infra/README.md convention 7).
  #
  # Note what this ARN is *not*: a queue URL. Ingestion's function carries a
  # server-assigned `QUEUE_URL` because it publishes; a consumer names the queue
  # by ARN, which is fully determined by region, account and name. That is why
  # hand-assembly is safe here and would not be there.
  weather_readings_queue_arn = "arn:aws:sqs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:cumulo-weather-readings-${var.environment}"
}

resource "aws_lambda_event_source_mapping" "weather_readings" {
  event_source_arn = local.weather_readings_queue_arn
  function_name    = aws_lambda_function.forecast.arn

  # One message per invocation. The unit of work is a location — ADR 0004's
  # granularity, one message carrying that location's full 48-hour horizon — and
  # batching amortises nothing here, because the expensive part of an invocation
  # is a `by-location` GSI query that is per location by construction. Ten
  # messages in a batch would be ten independent queries inside one invocation
  # rather than one query over ten locations.
  #
  # What a batch of one buys instead is isolation: a pathological message cannot
  # starve its batch-mates by consuming the invocation's timeout, and a
  # redelivery redelivers exactly the location that failed.
  batch_size = 1

  # ADR 0004's second non-optional consumer obligation, in one line: "
  # `ReportBatchItemFailures` enabled on the event source mapping, with the
  # handler returning the identifiers of the messages that actually failed.
  # Without it, one bad message redrives its whole batch, silently repeating
  # work that already succeeded."
  #
  # At `batch_size = 1` the two behaviours coincide — a batch of one either
  # succeeds or fails whole — so this line changes nothing today. It is here
  # anyway, and deliberately: it means the handler's contract is already the
  # partial-failure contract, so raising the batch size later is a change to
  # this number alone rather than a change to code that had quietly assumed
  # all-or-nothing. The obligation is honoured at the size where it is free
  # instead of at the size where forgetting it is a bug.
  function_response_types = ["ReportBatchItemFailures"]

  # At most two invocations of this function at a time. This is a write-side
  # bound, not a compute one, and the number it protects is `cumulo-series`'
  # provisioned **14 WCU** (ADR 0002, and the free-tier arithmetic in
  # infra/README.md's cost section).
  #
  # An hourly ingestion cycle publishes its ~12 location messages within a few
  # seconds of each other, and each one produces on the order of 240 series
  # items. Unbounded, Lambda would take all twelve at once and drive ~2,880
  # write units at a 14 WCU table simultaneously — throttling, retries, and the
  # storage stack's own throttle alarm firing on what is really a concurrency
  # decision made three stacks away. At 2, the same work arrives as a short
  # queue-paced stream instead of a burst, and SQS's redelivery absorbs whatever
  # still throttles: the messages are not lost, they are simply processed a
  # moment later, which for an hourly pipeline is indistinguishable from
  # immediately.
  #
  # 2 rather than 1 because one invocation would make the whole fleet's
  # forecasts strictly serial behind the slowest location, and rather than 4+
  # because the point is to sit below the table's sustained rate, not near it.
  scaling_config {
    maximum_concurrency = 2
  }

  # Cost: this mapping is what creates the polling receives ADR 0004 already
  # counted. An ESM holds a floor of five long-polling connections at the
  # queue's 20 s `receive_wait_time_seconds`, which is ~657,000 ReceiveMessage
  # calls a month — the dominant term in the platform's ~675,000 SQS requests
  # against the always-free 1,000,000. So this resource does not add a cost
  # line; it is the cost line, and it was budgeted before it existed. The number
  # to watch is a *second* ESM-driven queue, which crosses the million (ADR 0004
  # revisit trigger 5) — cents in money, but "$0" would stop being literally
  # true.
}
