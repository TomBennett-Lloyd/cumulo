# `@cumulo/forecast-service`

The queue-woken forecast runtime: one `cumulo-weather-readings-<env>` message is one location's
48-hour weather horizon, and this service turns it into per-site PV forecast rows in
`cumulo-series` (ADR 0001's fourth deployable, ADR 0003's runtime, ADR 0004's trigger).

Two names, on purpose. The **directory** is `apps/forecast`, which is the deployable ADR 0001
names and the artifact path `infra/forecast/lambda.tf` expects. The **package** is
`@cumulo/forecast-service`, because `@cumulo/forecast` is already taken by the pure physics
library in `packages/forecast` — the thing this service is a runtime for. A shared name would
make `workspace:*` ambiguous and the dependency direction unreadable.

## The message path

| Module                  | Responsibility                                                                        |
| ----------------------- | ------------------------------------------------------------------------------------- |
| `sqs-event.ts`          | The platform boundary: the event schema, and the `ReportBatchItemFailures` response.  |
| `location-forecasts.ts` | The fan-out — sites × hours → `Forecast` rows. Pure.                                  |
| `consume-message.ts`    | One record, from `body` to written rows, as a value. Never throws.                    |
| `handler.ts`            | The batch boundary: structured logs, and which messages Lambda must redeliver.        |
| `main.ts`               | The composition root: parses the environment, builds the adapters, exports `handler`. |

Nothing here imports from `apps/ingestion`. The two services share a wire contract, not code:
`weatherMessageSchema` — and the `describeThrown` / `describeZodIssues` renderers their `detail`
strings use — live in `@cumulo/shared`, because an app may not import another app
(`docs/standards/architecture.md` rule 1).

## Correctness properties

- **Idempotency is structural, not checked.** Every row is a Put over the sort key
  `T#<validTime>#FC#physics` (ADR 0002), so a redelivered message rewrites exactly the rows it
  wrote the first time. SQS is at-least-once, so this is what makes redelivery free — and it is
  the property ADR 0004 revisit trigger 4 exists to protect. A future effect that increments,
  appends or notifies would break it silently.
- **A zero forecast is a row, not an absence.** A night hour produces a row with `acPowerKw: 0`.
  The read side (`querySeriesRange`) plots what it finds, so omitting those rows would be the
  difference between a flat night and a hole in the chart.
- **One message is one location.** ADR 0004 publishes per location, so a body carrying readings
  from two `locationId` buckets is a violated contract and is refused. Fanning it out would run
  one location's weather against another location's sites.
- **A partial drain fails the record.** `BatchWriteItem` answers HTTP 200 while handing back the
  items it declined (ADR 0002 Consequence 4), so "the call succeeded" and "the data was written"
  are different facts, and only the second one counts as delivered.
- **No active sites is a success.** A location whose sites were all deactivated between publish
  and delivery has nothing to forecast. Redelivering that message would turn an ordinary fleet
  edit into a DLQ entry.
- **Zero Open-Meteo calls.** The weather arrives on the queue. CLAUDE.md's frugality constraint
  is ingestion's to honour; this service adds no term to it.

## Failure policy

Every record's processing is converted to a `MessageOutcome`, and `handler.ts` reports the id of
any outcome other than `stored` or `no-active-sites` in `batchItemFailures` — so a poison message
is redelivered on its own rather than redriving batch-mates that already succeeded, which is the
obligation ADR 0004 makes non-optional for this consumer.

The one case worth naming is the physically implausible hour. `createPhysicsForecast` classifies
its own result against `forecastSchema`'s bounds and returns an `implausible` value — not a throw —
when it lands outside them, because those bounds are reachable from weather every schema accepts
and no atmosphere produces (the low-sun circumsolar amplification route that package's docstring
documents). Being a value is what lets each consumer answer "who does the operator need to call?"
for itself. This service's answer is: **fail the record and let the queue do the rest.**
`locationForecasts` stops at the first such hour and `consume-message.ts` renders it into a
`failed` outcome whose detail names the site id and the hour. The message is redelivered up to
`maxReceiveCount = 5` and then lands in `cumulo-weather-readings-dlq-<env>`, which is alarmed in
`infra/ingestion/alarms.tf` — so the retry and the operator signal both already exist in
infrastructure, and the blast radius is one location's hour rather than a fleet-wide run.

That value arm makes `locationForecasts` total over _implausibility_ — not over bugs. A genuine
bug inside `@cumulo/forecast` still arrives as a throw, from below that classification, and
`consume-message.ts` catches it at the record boundary for the same reason it catches an adapter's:
uncaught, it would fail the whole invocation and abandon the batch-mates the per-record redrive
exists to protect. It fails the same record by the same route, and the detail says an operation
threw rather than naming an hour, which is the distinction an operator reading the DLQ needs.

## No deadline, and why

Ingestion (#115) carries a deadline, a location cap and a whole `cycle-budget.ts` of arithmetic.
This service builds none of that, and the difference is a design decision rather than an omission:
a cycle killed at its timeout loses the only record of what it did, whereas an invocation killed
here simply does not delete its message. The queue's visibility timeout (300 s, six times the
50 s function timeout, as ADR 0004 requires) redelivers it.

The arithmetic, on the constants actually in the tree today:

| Case                 | Mechanism                                                          | Time                            |
| -------------------- | ------------------------------------------------------------------ | ------------------------------- |
| Healthy              | 1 GSI query + 240 physics evaluations + 10 write pages             | well under 1 s; 1–2 s cold      |
| DynamoDB outage      | first send rejects; the drain does not retry a rejection           | ≈ 14 s → `failed`, logs intact  |
| Throttling, mixed    | each send times out once, then a 200 declines all but one item     | ≈ 223 s, against a 50 s timeout |
| Throttling, pure 200 | each send returns 200 declining all but one item, one attempt each | ≈ 96 s, against a 50 s timeout  |

A canonical five-site location is `5 × 48 = 240` items, so `ceil(240 / 25)` = **10**
`BatchWriteItem` pages. One send's worst case is `2 × 3 s + 1 s` = **7 s**
(`STORAGE_MAX_ATTEMPTS` 2 since #122, `STORAGE_REQUEST_TIMEOUT_MS` 3 s,
`STORAGE_RETRY_BASE_DELAY_MS` 1 s); one page's drain is at most three of those plus its own
backoff — `3 × 7 s + 0.6 s` ≈ **21.6 s**, or six round trips (3 drain × 2 SDK). Ten pages plus the
site query is ≈ **223 s**.

Which failure produces that number is worth being exact about, because the obvious guess is wrong.
An **outage does not grind**: `drainBatches` re-sends only what a _successful_ response reported as
`UnprocessedItems`, and a rejected send propagates out of the drain untouched
(`packages/storage/src/batch.ts`). So an outage rejects on page 1 after ≈ 7 s, the record is
`failed` at ≈ 14 s including the site query, and the outcome entry and batch summary are both
written well inside the timeout.

The ≈ 216 s grind needs the opposite, and specifically a **mixed** regime rather than a purely
declining one: each send's first attempt timing out, and its one SDK retry then answering HTTP 200
with all but one of its 25 items unprocessed. (All but one, not all: a _wholly_ declined batch does
not answer 200 at all — DynamoDB rejects it with `ProvisionedThroughputExceededException`, which the
drain cannot retry, so it takes the outage path above; `packages/storage/src/client.ts` states that
boundary.) That is what the 7 s per-send term prices — `2 × 3 s + 1 s` spends two attempts only
when the first failed _retryably_, which a 200 never is. A **pure** 200-declining
regime is therefore cheaper per send, not dearer: one attempt bounded at 3 s, so `3 × 3 s + 0.6 s`
≈ 9.6 s per page and ≈ **96 s** over ten.

Both are sustained throttling against `cumulo-series`' provisioned write capacity (ADR 0002;
`infra/storage/tables.tf` owns the figure) — a hot enough write burst is how a table both slows
down and declines items — and both blow the 50 s timeout, so the conclusion does not depend on
which one you get. Keeping the fleet out of either is what the mapping's `maximum_concurrency = 2`
is for.

Only in those regimes can an invocation reach the timeout, and only there is the cost worth naming:
a killed invocation's logs stop mid-batch, so `forecast.batch.summary` is absent rather than
reporting failures. Still diagnosable — `cumulo-forecast-<env>-errors` fires, and the storage stack's throttle
alarm is lit at the same moment — but an absence, which a reader of these logs should know about.
`handler.ts`'s module doc states the same arithmetic beside the code it governs.

## Configuration

`main.ts` parses `process.env` through a zod schema at module scope, so a wrong deployment fails
during initialization rather than mid-message.

| Variable     | Purpose                                                                |
| ------------ | ---------------------------------------------------------------------- |
| `CUMULO_ENV` | Environment suffix of the DynamoDB table names (`cumulo-sites-<env>`). |

There is no `QUEUE_URL`. A consumer is _handed_ its messages by the event source mapping and never
names the queue at runtime, which is also why the queue appears in this stack's IAM policy and
nowhere else. `AWS_REGION` is absent for the same reason it is in ingestion: Lambda sets it and the
SDK reads it directly.

## Build

```sh
pnpm --filter @cumulo/forecast-service build   # → dist/main.mjs, dist/handler.zip
```

The zip is the artifact `infra/forecast/lambda.tf` uploads; the Lambda handler string is
`main.handler`. The script is ingestion's, flag for flag, and the three load-bearing choices are
the same — the AWS SDK is bundled rather than `--external` so the deployed behaviour does not
depend on which SDK the runtime shipped that week; `--main-fields=module,main` bundles the SDK's
ESM build, without which the artifact throws on import; and `rm -rf dist` runs first because `zip`
appends to an existing archive.

## Attribution

Weather data by [Open-Meteo.com](https://open-meteo.com/), used under
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
