# 0004 — Ingestion transport

- **Status:** accepted
- **Date:** 2026-07-31
- **Issue:** #11

## Context

ADR 0001 split Cumulo by trigger model and, in doing so, named a transport in passing: ingestion "publishes normalised readings to a Kinesis stream (#11)", and its Decision assigns that resource to this ticket — "ingestion (#11) owns its schedule and its Kinesis stream". ADR 0002 inherited the name twice: `weather` gets 3 RCU partly because "#12's forecast service … receives weather on the Kinesis stream rather than reading it back", and DynamoDB Streams are off because "ADR 0001's transport is Kinesis; a second event source would bill for existing and add a trigger surface". Three documents now assume Kinesis, and none of them ever costed it.

That omission is the reason this ADR exists. 0001 was a decision about boundaries, and Kinesis appears in it as the obvious noun for "a thing that carries records between two Lambdas" rather than as a conclusion. 0002 then established a standing cost of exactly $0 for the entire storage layer — four tables, two GSIs, no VPC, no instance — and closed by naming the one charge it could not remove: "The only standing charge in the platform remains ADR 0001's Kinesis stream." A single unexamined noun is now the whole of the platform's monthly bill. Under a ~$100/month ceiling that is not a crisis, but it is precisely the shape of cost this project has committed to arguing rather than inheriting, and 0001 itself flagged it as a live risk: it listed "a standing charge exists that a monolith would avoid — the stream bills for existing" among the genuine downsides of its own chosen option.

Now that #11 is being built, the requirement is concrete enough to cost properly.

### The traffic, measured rather than assumed

The canonical fleet (`docs/design/fleet-simulation.md`) is 60 sites deliberately co-located at **12 distinct weather locations**, on an hourly cadence over a 48-hour horizon. One cycle therefore produces **576 weather readings — 12 locations × 48 hourly readings**.

Those readings cross the wire as **one message per location**, not one per reading. That granularity is not a choice made here: ADR 0002's access pattern F1 is already stated per location — "on a stream record for location _L_, read the physics parameters of every active site at _L_" — because the forecast service's unit of work is a location, and the sites at that location are looked up from GSI1 once per message rather than once per reading. So a cycle is **12 messages carrying 576 readings**, at roughly **15–20 KB per location payload** (48 readings of ten-odd numeric fields, JSON, with the schema's explicit field names).

At ADR 0002's deliberately pessimistic sizing scale — ~50 sites over ~30 locations — the same cycle is **1,440 readings/hour** in 30 messages. Payload size per message does not move with fleet size at all; it is a function of horizon length. Only message count grows.

Three properties of that traffic decide this ADR, and all three are structural rather than incidental:

- **Exactly one consumer.** ADR 0001 fixes four deployables, and only the forecast service (#12) is woken by ingestion. There is no second reader now, and 0001's fifth-deployable bar makes one unlikely to appear without its own ADR.
- **No ordering requirement.** Readings are idempotent upserts. ADR 0002 keys `cumulo-weather` at PK `locationId`, SK `FORECAST#T#<validTime>`, so a reading delivered twice, or out of order, is a Put over an identical key with an identical value. The same holds downstream: `cumulo-series` collapses the issue-time axis, so "each cycle overwrites the point for a valid time it re-forecasts". Duplicate or reordered delivery is structurally harmless from the wire to the last write.
- **No replay requirement.** The transport is not the record. Ingestion writes to `cumulo-weather` (0002's pattern I2, and its least-privilege line: "ingestion reads `sites` and writes `weather`"); the message is a trigger that happens to carry its own payload. If a cycle is lost, the next hourly cycle re-fetches the same 48-hour horizon and rewrites the same keys — recovery is 60 minutes of staleness, not a replay. Kinesis's 24-hour default retention would in any case be the _shortest_-lived copy of data the store already holds for 90 days.

### The cost frame

Figures below are AWS list prices, us-east-1, **verified 2026-07-31**, on the same basis as ADR 0002 (Ireland runs roughly 10–15% higher; nothing here turns on that margin). Standing cost is what matters: this is a demo that idles between hourly cycles, and 0002's governing posture — **idle cost is the steady state** — applies unchanged.

The usage-driven component is immaterial in every option and can be set aside honestly rather than ignored. 8,760 messages a month at ~20 KB is ~175 MB/month: Kinesis PUT payload units cost fractions of a cent, on-demand data-in at $0.08/GB is about a penny, EventBridge charges $1.00 per million events. **Every option's bill is dominated by whether the resource charges for existing.** That single axis is the decision.

## Decision

**Ingestion publishes to an SQS standard queue, and the forecast service consumes it through a Lambda event source mapping.** One queue, one consumer, one redrive policy to a dead-letter queue. Decided by the owner on 2026-07-31 at plan review.

`cumulo-weather-readings-<env>` is owned by #11's Terraform, per ADR 0001's rule that a resource only one service provisions is service-owned — which is unchanged by this ADR, since only ingestion produces to it.

**The message granularity is one message per location per cycle**, carrying that location's full horizon, matching 0002's F1. The consumer's event source mapping batches messages; #12 chooses the batch size.

This supersedes the transport _resource_ named in ADR 0001 and ADR 0002. It does not touch either document's decision: 0001's four deployables, its trigger-model split, and its infrastructure-ownership rule all stand, and 0002's storage design is untouched. Per this repo's convention — ADRs are "immutable once **merged** (supersede rather than edit)", restated inside 0001 and 0002 as "any change supersedes this one with a new ADR and never edits it" — neither file is amended, and neither has its Status changed. ADR 0002 amended 0001's cost picture the same way, by reference from its own text. What each document said remains readable as what was believed when it was written; the Consequences section below states precisely which sentences no longer hold.

## Options considered

| Option                                                  | Standing $/month                                                                                 | Fit                                                                                                              |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| Kinesis on-demand (the ADR-chain default)               | ≈ $29.20 ($0.04/stream-hour)                                                                     | bills for existing; every capability unused; dominated by the shard option                                       |
| Kinesis provisioned, 1 shard                            | ≈ $10.95 ($0.015/shard-hour)                                                                     | ~0.02% shard utilisation; buys ordering, replay, and multi-consumer that nothing needs                           |
| **SQS standard + Lambda event source mapping — chosen** | **$0** (~9K sends/month plus the mapping's polling receives, inside the always-free 1M requests) | keeps 0001's "forecast runs on data arriving" trigger model; native DLQ and batching; cheapest teardown          |
| EventBridge bus                                         | ~$0.01 (8,760 events at $1.00/M)                                                                 | a router, not a buffer — weaker retry and backpressure, no batched delivery                                      |
| No transport (direct async invoke, or read-back)        | $0                                                                                               | couples ingestion to forecast's function identity across a service boundary; erodes 0002's `weather` read sizing |

Against a ~$100/month ceiling, $29.20 is 29% of the platform's entire budget and $10.95 is 11% — spent, in both cases, on a resource that would be idle 99.98% of the time.

### A. Kinesis on-demand

The path of least resistance: it is what three ADRs already say, it needs no capacity decision, and it absorbs any spike without sizing.

Rejected because **it is dominated**. At $0.04/stream-hour it costs ≈ $29.20/month to do strictly less, for this workload, than a single provisioned shard at ≈ $10.95 — on-demand's value is elastic capacity, and there is no elasticity to buy when the load is 0.02% of one shard and known in advance from a clock. An option that is beaten by a sibling on both cost and fit does not need the rest of the argument. It is worth naming as an option only because it is the default a reader would assume from ADR 0001's wording, and leaving the assumption uncosted is what got the platform here.

### B. Kinesis provisioned, 1 shard

The genuinely strong Kinesis option, and the fair one to argue against.

What it buys is real: strict per-shard ordering, 24-hour replay by default (up to 365 days for a charge), multiple independent consumers each reading the full stream at their own offset, and — unlike SQS — **no per-request polling charge at all**, since a Lambda event source mapping's `GetRecords` calls against a stream are not billed as requests. That last point is a genuine advantage over the chosen option and it should not be glossed over.

Rejected because:

- **≈ $10.95/month standing, forever, to move 175 MB.** That is 11% of the ceiling for a transport, against a storage layer that ADR 0002 got to $0 by arguing every line item.
- **~0.02% shard utilisation.** A shard sustains 1,000 records/second. Taking the framing least favourable to this argument — 576 individual records per cycle rather than 12 batched messages — the sustained rate is `576 ÷ 3,600 ≈ 0.16` records/second, **0.016% of one shard**. On the batched granularity actually being used it is 0.0033/second. By bytes it is worse still: ~180 KB/hour against 1 MB/second is **0.005%**. Even 0002's pessimistic 30-location scale, and 0001's ceiling of a fleet several times larger, move none of those figures out of the third decimal place.
- **Every capability it buys is one this workload has argued it does not need.** Ordering: the keys are idempotent upserts. Replay: `cumulo-weather` is the durable record and holds the same data for 90 days, where the stream's default retention is 24 hours. Multiple consumers: there is exactly one, and ADR 0001's fifth-deployable bar is what stands between that and a second.
- **Poison-record handling is worse.** A record the consumer cannot process blocks its shard until the record expires, unless bisect-on-function-error and an on-failure destination are configured — machinery that exists to recover the ordering guarantee nothing here wants. SQS's redrive policy moves the offending message aside and the rest keep flowing.
- **It is the resource most likely to be left running.** A stream that bills for existing is exactly the "idle billable resource" ADR 0001 warned per-service Terraform multiplies the hiding places for.

### C. SQS standard + Lambda event source mapping — chosen

**$0/month standing.** SQS has no per-hour charge; it bills per request, and the always-free tier is 1 million requests/month with no twelve-month expiry — the same shape of allowance ADR 0002 built the storage layer on.

The request arithmetic, stated fully rather than as "~9K", because the sends are not the interesting half. Sends are 12/cycle × 730 cycles ≈ **8,760/month**, and deletes on successful processing add about as many again. The figure that actually consumes the allowance is the event source mapping's polling: Lambda holds a floor of **five parallel long-polling connections** while a mapping is enabled, and at a 20-second receive wait that is 15 `ReceiveMessage` calls/minute ≈ **657,000/month**, billed against the queue. Total ≈ **675,000 requests/month — about two-thirds of the free million.** So the answer is $0, but with roughly a third of the allowance in reserve rather than an order of magnitude, and that is the number to watch rather than the send count. If it is wrong, it is wrong cheaply: beyond the free tier SQS is $0.40 per million requests, so even doubling the polling floor costs about **$0.27/month**. The conclusion is robust to the uncertainty in its own weakest figure, which is the reason to state the figure rather than the rounder one.

It also fits the shape of the system, not just the bill:

- **ADR 0001's trigger model survives intact.** Forecast still "runs on data arriving" — not on a clock, not on a request. That is the property the boundary argument rested on, and a queue delivers it exactly as a stream did.
- **Native DLQ and batching.** A redrive policy is two Terraform lines; batching, partial-batch reporting, and concurrency control are event-source-mapping settings rather than consumer code.
- **Cheapest teardown, and it does not depend on teardown discipline.** `terraform destroy` removes the queue in one step with no ordered dependencies — but the stronger point is that a _forgotten_ queue costs nothing either.

Genuine downsides, and they are not trivial:

- **At-least-once delivery makes idempotency load-bearing permanently.** Today it is free — every write on the path is a Put over a deterministic key. A future consumer that increments a counter, appends, or sends a notification is a correctness bug rather than a configuration change, and nothing in the type system will say so.
- **No ordering, at all.** SQS standard makes a best effort and guarantees nothing. Should lead-time-stratified scoring (ADR 0002's revisit trigger 3) or any order-dependent consumer arrive, this is a migration to FIFO or back to a stream, not a setting.
- **No replay.** Once a message is deleted it is gone. In an incident the recovery paths are waiting for the next hourly cycle, re-fetching from Open-Meteo against the 10,000/day quota, or reading `cumulo-weather` back — and that last one is precisely the read path option E is rejected for introducing. The tension is real and worth naming: the fallback available in an incident is the design declined as a default. It is acceptable because it is a manual recovery action taken knowingly, not a per-cycle read path sitting inside #17's ~60-second budget.
- **The second consumer is a migration.** Kinesis would fan out for free; here it means SNS in front of two queues, or an EventBridge bus. ADR 0001's fifth-deployable bar makes that unlikely, not impossible.
- **Polling requests are the one place this can start to bill.** A second ESM-driven queue roughly doubles ~657K and crosses the free million. The cost of crossing it is cents, but "$0" stops being literally true, and this ADR's headline claim should not quietly depend on nobody adding a queue.
- **Two configuration couplings the consumer must honour**, neither of which Kinesis has: the queue's visibility timeout must be at least **six times** the consumer's function timeout, or a slow invocation causes redelivery of a message still being processed; and the mapping must enable **partial batch failure reporting** (`ReportBatchItemFailures`), or one bad message in a batch redrives the whole batch — a silent multiplier on work already done, and the shape of swallowed failure `docs/standards/error-handling.md` rule 2 exists to prevent. Both belong to #12's ticket and are recorded in Consequences.
- **The 256 KB message limit is a real ceiling**, currently with wide margin: 15–20 KB per message is under a tenth of it. Because payload size scales with _horizon_, not fleet, the limit binds only if the 48-hour horizon grows roughly thirteenfold. Worth knowing; not worth designing around today.

### D. EventBridge custom bus

Deserves a fairer hearing than the cost column suggests, because on pure request economics it is the cheapest option here: **~$0.01/month**, no standing charge, and — unlike SQS — **no polling cost at all**, since delivery is push. Measured only by allowance consumed, it beats the chosen option.

Rejected because it is a **router, not a buffer**, and what this path needs is the buffer:

- **No batched delivery.** Each event invokes the target separately: 12 invocations per cycle instead of one or two batches, and no way for the consumer to amortise a GSI1 lookup or a `BatchWriteItem` across a cycle.
- **Weaker backpressure and retry.** Targets are invoked asynchronously with retries and an optional DLQ, but there is no queue depth to observe, no visibility timeout, no in-flight count, and no natural place for a slow consumer to push back. With SQS, a stalled consumer is a rising `ApproximateNumberOfMessagesVisible` and an alarmable number; with EventBridge it is retries dissolving into a DLQ.
- **Content-based routing is the feature being paid for, and there is exactly one destination.** A bus whose rule set has one rule pointing at one target is a queue with worse operational instrumentation.
- **It would also need a second schema-ish surface** — a detail-type and source convention, plus a rule pattern — that is one more place the ingestion-to-forecast contract can be expressed and drift, against architecture rule 2's single-schema posture.

If a second or third consumer ever appears, this becomes the strong option, and it is named as a revisit trigger below.

### E. No transport — direct async invoke, or write-then-read-back

$0, and the fewest resources: ingestion either calls `Invoke` on the forecast function with `InvocationType: Event`, or writes `cumulo-weather` and lets a schedule prompt forecast to read it back.

Rejected because both variants trade a billed noun for an unbilled coupling:

- **Direct invoke couples ingestion to forecast's function identity across a service boundary.** ADR 0001's whole argument is that boundaries are cheap per invocation and expensive per coupling; a hard-coded function ARN plus `lambda:InvokeFunction` makes ingestion's IAM policy and deploy depend on forecast's _name_, which is the one thing a service should be free to change. It also erases the trigger asymmetry the boundary was drawn on: forecast stops running on data arriving and starts running because ingestion decided to run it. Retry, DLQ, and backpressure become ingestion's problem, implemented in code, rather than a queue's.
- **Read-back erodes ADR 0002's `weather` read sizing** — not arithmetically, but at the level of the reasoning. 0002 allocates `weather` 3 RCU on an explicit premise: "its only read paths are offline … and #12's forecast service, which receives weather on the stream rather than reading it back. Nothing on `weather`'s read path sits in front of a user." Read-back makes that false. The added volume is modest — twelve Queries of ~15 KB each is roughly 24 read units per cycle — but it puts a read on the 3-RCU table inside #17's ~60-second add-a-site path, which is exactly the class of claim 0002 sized against. Changing a premise another ADR provisioned capacity on, in order to save $0 against an option that also costs $0, is a bad trade at any price.
- It also loses the cheapest correctness property the chosen option has for free: a failed forecast invocation has nowhere to land, where a failed queue message lands in the DLQ.

## Consequences

**The platform's total standing cost is now $0.** Not a rounding error and not "cents" — no resource in Cumulo bills for existing outside an always-free allowance (amended 2026-08-10; see Amendments). ADR 0002 got storage to zero (four DynamoDB tables inside the permanently free 19 WCU / 24 RCU and 25 GB, no VPC, no NAT Gateway, no instance, no proxy, no PITR, no customer-managed key); Lambda invocations at this volume sit inside the always-free tier, as ADR 0001 already established; and the transport is now a queue whose ~675,000 requests/month sit inside the always-free 1 million. The ~$100/month ceiling is met with the whole ceiling unspent.

**Superseding ADR 0002's standing-charge line.** Its Consequences, under "Standing cost", end: "The only standing charge in the platform remains ADR 0001's Kinesis stream." **That sentence no longer holds.** There is no Kinesis stream and there is no standing charge. Everything else in that paragraph — the free-tier capacity split, the storage figure, the levers if write volume ever matters — stands unchanged. Per the immutability convention, 0002 is not edited; this paragraph is the amendment of record, and 0002's Status stays `accepted` because its decision, the single-store DynamoDB design, is untouched by a change of transport.

0002 names the resource in three further places, and in each the substance survives the rename. Its `weather` read sizing holds because the premise holds: the forecast service still "receives weather on the [transport] rather than reading it back", which is exactly what option E below is rejected for breaking. Its #17 add-a-site latency argument — that ingestion's and forecast's writes are "pipelined through [the transport] rather than strictly serial" — is a property of asynchronous delivery, not of Kinesis, and a queue provides it identically. Its table-settings line on DynamoDB Streams is addressed on its own below.

**Superseding the transport clause in ADR 0001.** Two of its statements name the resource: its Context sentence that ingestion "publishes normalised readings to a Kinesis stream (#11)", and its Decision clause "ingestion (#11) owns its schedule and its Kinesis stream". Read those as _its schedule and its transport_. The rule the clause illustrates — a resource only one service provisions is owned by that service's ticket — is what 0001 actually decided, and it is confirmed here rather than changed: only ingestion produces to the queue, so #11 owns it. ADR 0001's Status therefore stays `accepted`; it is amended in one noun, not superseded.

Two smaller consequences follow inside 0001, and both are in its favour:

- **One of its recorded downsides is now void.** Its chosen option listed "a standing charge exists that a monolith would avoid — the stream bills for existing … which under a $100 ceiling is a real risk rather than a theoretical one." That risk is removed, not mitigated. The four-deployable split now costs nothing per boundary in dollars — only in the surface area 0001 said was the real price all along.
- **One of its rejection arguments is genuinely weaker, and should be said out loud.** It rejected further fragmentation partly on "every split needs a transport, and transports bill for existing." Transports need not bill for existing, so that argument no longer carries weight. It was not the load-bearing one: the reasons that decided it — no independent scaling or failure need at this size, a second un-normalised wire format violating architecture rule 2, and a runtime seam not requiring a deployment seam — are untouched. The fifth-deployable bar is evidence-based, not cost-based, and nothing here lowers it.

**One vocabulary correction.** ADR 0001 summarised the split as "Three trigger models (cron, stream, HTTP)". Read _queue_ for _stream_. The distinction the boundary rests on — that forecast is woken by data arriving rather than by a clock or a request — is exactly preserved; only the noun changes.

**DynamoDB Streams stay off, and the reason is now stronger.** ADR 0002's table settings say: "**DynamoDB Streams: off.** ADR 0001's transport is Kinesis; a second event source would bill for existing and add a trigger surface." The first clause is void; the second is the load-bearing one and it survives intact. It is worth answering the obvious follow-up directly, because a reader will ask it: now that ingestion writes `cumulo-weather` anyway, why not let a stream on that table _be_ the transport, and delete the explicit publish? Because it would make the forecast trigger an implicit consequence of a storage write, coupling #12 to the storage adapter's **item** shape — which ADR 0002 deliberately keeps distinct from the domain schema, since "no key attribute is a schema field" — instead of to a published payload the shared schema owns. It would also fire on archive-cache writes (#16) that must not trigger live forecasting, and it is a second event source on a table whose read allocation is sized for offline paths only. The explicit queue keeps ingestion's output a decision rather than a side effect.

**Teardown stops being load-bearing for the transport.** `terraform destroy` removes the queue and its DLQ in one step with no ordered dependencies, no final snapshot, and no detaching network interfaces — and, unlike a stream, a queue nobody remembers to destroy costs nothing while it sits there. This is the first resource in the platform where forgetting teardown has no price, which removes one of the places ADR 0001 warned an idle billable resource could hide.

**What #11 owns.** `cumulo-weather-readings-<env>` and `cumulo-weather-readings-dlq-<env>` in ingestion's Terraform, with a redrive policy carrying an explicit `maxReceiveCount`; an IAM policy granting ingestion `sqs:SendMessage` on the queue only; and a CloudWatch alarm on the DLQ's `ApproximateNumberOfMessagesVisible`, since a dead-letter queue nobody watches is a silently broken pipeline. Per `docs/standards/error-handling.md` rule 3, send timeout and retry behaviour are set at the call site rather than inherited from SDK defaults.

**What #12 must honour**, both consequences of choosing a queue over a stream, and neither optional:

1. **Visibility timeout at least six times the function timeout.** Below that, a slow invocation causes the message to be redelivered while it is still being processed — which today is harmless duplicate work and tomorrow, on any non-idempotent addition, is a bug.
2. **`ReportBatchItemFailures` enabled on the event source mapping**, with the handler returning the identifiers of the messages that actually failed. Without it, one bad message redrives its whole batch, silently repeating work that already succeeded — the swallowed-failure shape `docs/standards/error-handling.md` rule 2 exists to prevent.

**Idempotency is now a documented property, not a happy accident.** It holds because of ADR 0002's key design — `cumulo-weather` at (`locationId`, `FORECAST#T#<validTime>`) and `cumulo-series` with the issue-time axis collapsed — and this ADR is what makes it load-bearing. Any future change that puts a non-idempotent effect on this path has to reopen this document.

**What would make us revisit.** ADRs are immutable: any change supersedes this one with a new ADR and never edits it. Concrete triggers:

1. **A second consumer of ingestion's output.** SNS fan-out to two queues, or the EventBridge bus of option D — which becomes the strong option the moment its content-based routing has more than one destination to route to.
2. **Any ordering requirement**, most plausibly ADR 0002's revisit trigger 3 (lead-time-stratified skill scoring). SQS FIFO or a return to a stream, argued on the requirement.
3. **A genuine replay requirement** — a consumer whose output cannot be reconstructed from `cumulo-weather` plus a pure function. Architecture rule 3 currently guarantees it can.
4. **A non-idempotent effect anywhere on the consumer path.** At-least-once delivery stops being free the moment a write is not an overwrite.
5. **A second ESM-driven queue**, which pushes polling requests past the free million. The bill is cents; the reason to name it is that this ADR's headline "$0" would stop being literally true.
6. **A horizon extension of roughly an order of magnitude**, which is the only way the per-location payload approaches SQS's 256 KB message limit.
7. **Throughput that makes a shard's 1,000 records/second a real number.** At 0.02% today, this is a note for completeness rather than a live concern — but it is the trigger that would make option B correct rather than merely expensive.

## Amendments

Per `docs/adr/README.md`: amendments true up stated values that have legitimately moved; the decision and its rationale are immutable.

- **2026-08-10 — "no resource in Cumulo bills for existing" made precise (#200, after #179/#188's audit).** The absolute was shown imprecise rather than wrong: log groups bill for retained bytes, CloudWatch alarms bill per alarm metric, and DynamoDB bills for stored bytes — all charges for existing, all at $0 because always-free allowances absorb them (5 GB of log storage, ten alarm metrics, 25 GB of table storage), not because no meter runs. The headline now reads "outside an always-free allowance". What this document actually bought is untouched: no per-hour resource exists anywhere in the platform, and the $0 standing cost is real. The per-resource precise statement lives in `infra/README.md` ("What it costs" notes, per stack — the ingestion stack's note states this ADR's relationship to it explicitly).
