# The ingestion → forecast transport, per ADR 0004: one SQS standard queue, one
# consumer, one redrive policy to a dead-letter queue.
#
# ADR 0004 replaced the Kinesis stream that ADRs 0001 and 0002 had assumed. The
# reason is the whole of this stack's cost story: a stream bills ~$10.95/month
# for existing at 0.02% utilisation, and a queue bills per request against an
# always-free million. See the idle-cost note in outputs.tf.
#
# Granularity is fixed by ADR 0004 and by ADR 0002's access pattern F1: **one
# message per location per cycle**, carrying that location's full 48-hour
# horizon — 12 messages a cycle for the canonical fleet, at ~15–20 KB each,
# comfortably inside SQS's 256 KB message limit. Payload size scales with the
# horizon, not with fleet size, so the limit binds only if the horizon grows
# roughly thirteenfold.

resource "aws_sqs_queue" "weather_readings" {
  name = "cumulo-weather-readings-${var.environment}"

  # Long polling. 20 s is the maximum, and the maximum is the right value for a
  # queue that is empty 99.9% of the time: it is what turns the consumer's
  # standing poll into 3 receives/minute/connection instead of a busy loop, and
  # the polling receives — not the sends — are what ADR 0004 costs the free
  # million against (~657,000/month of ~675,000 total).
  receive_wait_time_seconds = 20

  # Six times the 50-second function timeout #12's consumer is expected to take,
  # which is the floor ADR 0004's Consequences make non-optional: below 6×,
  # a slow invocation causes SQS to redeliver a message that is still being
  # processed. That is harmless duplicate work today — every write on the path
  # is an idempotent Put over a deterministic key — and a correctness bug the
  # moment a non-idempotent effect appears, which is ADR 0004 revisit trigger 4.
  #
  # #12 owns the consumer and therefore owns the other half of this coupling: it
  # must not raise its function timeout past 50 s without raising this number in
  # the same change. The constraint lives here as well as there because this is
  # the side that can be read from the queue.
  #
  # That pairing is gated: `pnpm check:infra-mirrors`, in the `verify` composite
  # and so in CI, holds this number at or above the declared factor of six times
  # the consumer's timeout and fails on a one-sided edit (#133); the pair is
  # declared in .claude/scripts/check-infra-mirrors.sh.
  visibility_timeout_seconds = 300

  # maxReceiveCount = 5: a message the consumer cannot process is retried five
  # times and then set aside, rather than blocking the queue or being retried
  # forever. Five because a transient failure (a throttle, a cold dependency)
  # clears well inside five attempts on a 20-second receive cycle, while a
  # genuine poison message reaches the DLQ within a few minutes of the cycle
  # that produced it — comfortably before the next hourly cycle sends a
  # replacement.
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.weather_readings_dlq.arn
    maxReceiveCount     = 5
  })
}

resource "aws_sqs_queue" "weather_readings_dlq" {
  name = "cumulo-weather-readings-dlq-${var.environment}"

  # 14 days, the SQS maximum. The default is 4, which is long enough to lose a
  # dead-lettered message over a holiday weekend — and the whole point of the
  # DLQ is that the message is still there when somebody looks. Retention is
  # free; the alarm in alarms.tf is what makes "somebody looks" happen.
  message_retention_seconds = 1209600
}
