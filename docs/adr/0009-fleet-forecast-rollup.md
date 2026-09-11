# 0009 — Fleet forecast roll-up: partials at write, sum at read

- **Status:** accepted
- **Date:** 2026-09-11
- **Issue:** #494

**Supersedes ADR 0002 in part**: the `### Fleet-wide aggregation (A5): fan-out, chosen at this scale` decision, for the fleet **forecast** read only. Everything else in 0002 — the table split, the key design, the capacity mode, the TTL posture — stands untouched, and the fan-out remains how a fleet **actuals** read is served until the fast-follow ticket ([#506](https://github.com/TomBennett-Lloyd/cumulo/issues/506)) lands.

## Context

`GET /v1/fleet/forecast` is on the visitor's first paint, and it answers by reading every site's `cumulo-series` partition and summing the result: **1,753.9 ms p50, 2,998.9 ms p95 warm** at the canonical 12-location × 5-site fleet. That is most of the time between opening the demo and seeing a chart.

ADR 0002 chose that fan-out deliberately and named the condition that reopens it — revisit trigger 4, verbatim: "The aggregate endpoint becoming hot enough that fan-out latency or cost is visible: a time-bucketed GSI, or a cached aggregate." The trigger is met and it is met on latency, which is measured rather than argued. So this is not a decision fighting an ADR; it is the ticket that ADR wrote the trigger for.

Two facts about the pipeline shape everything below, and both were established by reading the code rather than assumed:

**The producer is per-location, not per-fleet, so "the end of a forecast run" does not exist as an event.** ADR 0004 makes one SQS message one location's whole horizon, and `apps/forecast/src/consume-message.ts` refuses a body naming two. One cycle is therefore twelve independent Lambda invocations with no last-one signal, and nothing in the tree can tell a message it is the last of its cycle.

**The dashboard's client-side aggregation cannot simply be deleted.** `apps/web/src/data/demo-fleet-data-source.ts` has no API behind it — it generates the fleet in the browser — so some consumer of the aggregation functions has to survive wherever the numbers come from.

## Decision

**Each per-location message writes its own location's partial; the read sums whatever partials are there.**

At the end of a forecast run for one location, the forecast service computes that location's contribution to each hour of the fleet aggregate — from the forecasts already in its hand, with no re-query and no re-sum — and writes one item per hour. `GET /v1/fleet/forecast` issues **one Query** of that partition over the requested window and sums the partials in process, through the same `@cumulo/shared` functions the browser used to call.

### Where the partials live

A **`#FLEET` sentinel partition in `cumulo-series`**. No fifth table, no GSI, no attribute definition, no IAM change: the forecast service already writes this table and the API already reads it, so `infra/` needs nothing for this design beyond the cost figures it states.

```
pk  siteId = '#FLEET'
sk  <kind>#T#<validTime>#L#<locationId>
      kind = 'FC#<model>'   forecast — this ticket
           | 'GEN'          actuals — the fast-follow ticket; shape defined here, no producer yet
```

Three things about that key are decisions rather than formatting:

1. **The segment order is the inverse of the per-site series key's**, and for the opposite reason. A site's partition is read _by time_, with both models and the actual interleaved (0002's access pattern A4), so time leads there. This partition holds every location and every kind, and the only read is "one kind, over one window", so **kind leads and time follows**: a Query for the forecast kind never reads past a single actuals item, and the established bare-bound `BETWEEN` trick expresses `[from, to)` exactly.
2. **The location trails the hour** because it is not a dimension any read selects on. It is what makes a _partial_ addressable, so twelve locations write twelve items for an hour instead of overwriting one.
3. **One item per location-hour, not one per location-horizon.** This is what makes the actuals ticket "a producer, never a schema": a whole-horizon-per-location item would force that producer into read-modify-write over a 168-hour list, while per-hour items make it a pure additive Put as each hour settles.

The cost of the sentinel is stated rather than hidden: `siteId` stops meaning "a site's id" for one kind of item. Collision is structural rather than hoped-for — `siteSchema.id` is `z.uuid()` and `#` is not a character a UUID contains, so no site can ever own this partition.

### Additivity is the load-bearing claim, and it is proved rather than asserted

A partial can only carry a field that is an **additive per-hour total**, because the read adds partials and nothing else. Every field the fleet aggregate reports is one:

| Field                          | Additive across locations?                                                                                                                                                                                           |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `acPowerKw`                    | **Yes.** A sum over a partition of the sites is the sum over all of them.                                                                                                                                            |
| `p10AcPowerKw`, `p90AcPowerKw` | **Yes.** The degenerate-band rule is applied _per site_, so each partial already carries the same per-site terms the whole-fleet sum would.                                                                          |
| presence of `uncertainty`      | **Yes**, as a boolean OR — associative, commutative, identity `false`. Carried as a `hasUncertainty` flag because the quantile sums alone cannot tell "no band anywhere" from "every band happens to be degenerate". |
| `contributingSiteCount`        | **Yes**, given disjointness.                                                                                                                                                                                         |
| `contributingCapacityKw`       | **Yes**, on the same disjointness.                                                                                                                                                                                   |
| `minimumContributingSites`     | **Not additive, and does not need to be** — it is a `min` over hours of the _already-summed_ counts, computed at the consumer, exactly as before.                                                                    |

**Disjointness is structural.** A site's `locationId` is a pure function of its own coordinates, so a site belongs to exactly one location and appears in exactly one partial. Per-site de-duplication therefore never has cross-partial work to do.

`packages/shared/src/fleet-rollup-additivity.test.ts` makes the claim executable over the canonical 12 × 5 fleet, because `generateFleet`'s clusters _are_ the `locationId` buckets the producer's messages are keyed by.

**The one way the two paths differ, stated rather than absorbed.** IEEE-754 addition is not associative, so adding a fleet's terms grouped by location and adding them in one pass land a bit or two apart — measured on the canonical fleet at **~2e-14 kW**, worst case `2.1e-14` on a `50.9` kW hour, with the contributing-capacity sum differing by `1.1e-13` kW. That is the _entire_ discrepancy: no field is lost and nothing is approximated. It is some **eleven** orders of magnitude below the watt precision a power value here claims, and the microwatt (`1e-9` kW = `1e-6` W) the proof bounds it at is itself six orders below a watt. Rounding partials to watt precision at the write boundary was considered for exactly this reason and **rejected**: a watt of precision is half a watt of error per partial, so twelve of them can put the summed fleet **6 W** from the unrounded one — eleven orders of magnitude worse than the error it would be fixing.

### One model, named once

The roll-up is keyed by kind, and a kind names a model, so `FLEET_ROLLUP_FORECAST_KIND` declares **physics** once for the producer and the reader both. That also closes a latent double-count: today's route returns every model it finds and lets the client sum them, which `aggregateFleetForecast`'s own docblock warns against, and which is harmless only because `packages/forecast` emits physics alone. When the ML correction layer lands, _which_ model the fleet chart shows becomes a product decision made in one place rather than one decided by what happens to be in the table.

### The fallback, and its removal trigger

For **one release**, a `#FLEET` window that is missing — or that is missing any location the active fleet has sites at, or that was read short by a page budget — falls back to the fan-out plus a server-side aggregate, and logs exactly one line:

```
{ event: 'api.fleet-forecast.rollup-fallback', reason: 'absent' | 'incomplete',
  expectedLocations: n, presentLocations: m, hours: h }
```

**Incomplete is treated exactly like absent**, which is the only judgement call in the fallback. Eleven of twelve locations sums to a fleet total that looks like a plausible number from a quieter fleet: the missing site does not read as missing, it reads as less generation. That is the half-truth the fan-out already refuses for itself.

Both arms end in the same `@cumulo/shared` functions, so this is a second _path_ and not a second owner of the numbers. **Removal trigger:** the event absent from the logs for 24 hours after the first post-deploy cycle. Tracked as [#507](https://github.com/TomBennett-Lloyd/cumulo/issues/507), which states the condition in the form a log query can answer.

### The client seam moves up

`FleetDataSource.fleetForecasts` returns the aggregate rather than raw rows. The HTTP source reads the summed points off the wire; the demo source computes the identical shape with `fleetForecastAggregate` over its fixtures. One definition of the fleet total, two ways of arriving at the shape. The forecast's per-hour capacity divisor travels on the point, so the `%`-of-capacity view no longer re-derives it from rows the app no longer receives.

### Step Functions is the planned evolution, not a rejected alternative

An orchestrated cycle — a state machine that fans out the locations and has a real terminal state — is the right shape **once several consumers need a genuine end-of-run event**: the actuals roll-up (#506), off-cycle forecasts for add-a-site (#498), and anything that wants to publish "the fleet is fresh as of T". It is not taken now because this design needs no such event at all, and buying an orchestration layer to get one would be paying for a signal nothing currently reads. **The trigger is the second consumer**: when a second thing needs to know a cycle finished, Step Functions is the answer, and this roll-up becomes one of its steps rather than a thing bolted to the end of a message handler.

## Options considered

**A — Precomputed per-location partials, summed at read (chosen).** Zero extra reads on the producer; no end-of-run event needed; no last-writer race, because each invocation writes only its own keys. Costs one more item kind in the key design, and a read that is a sum rather than a fetch. Its real downside is the one 0002 named against the denormalised item generally and which stands here: the fleet total now has a second _representation_. The mitigation is that it has no second _definition_ — every kilowatt is computed by `aggregateFleetForecast` / `contributingCapacityKwByHour` and by nothing else, in the producer, in the fallback and in the demo source alike.

**B — Recompute the whole fleet row from storage on every message.** Simple and self-healing; the last message of a cycle leaves a complete row. Rejected on cost: it spends the ~25 read units the API was spending, **twelve times per cycle**, so below a few dashboard loads per cycle it _increases_ total reads — and it re-reads rows it has just written. It also has a last-writer race that A does not.

**C — One fleet-sum row, written after the partials.** The read becomes a single GetItem instead of a Query. Rejected because it reintroduces exactly the race A removes: twelve concurrent invocations each summing and rewriting one key, where the loser's write is a stale fleet. The Query it avoids is one round trip either way.

**D — A time-bucketed GSI** (0002's own stated alternative). Turns a single-bucket fleet read into one Query, but turns a week-long window into one Query per bucket, and duplicates the entire forecast write volume into an index. Rejected for the reason 0002 gave, unchanged.

**E — API Gateway response caching.** ~$14/month for the smallest cache, on a platform whose entire storage bill is a dollar or two, and the first reader of every cache period still pays the full fan-out. Rejected on cost and on the part of the problem it does not solve.

**F — A TTL'd cache row, or an in-memory cache in the Lambda.** Both leave the first reader paying; the in-memory one leaves the first reader _per container_ paying, which on a low-traffic demo is close to every reader. Rejected.

**G — Do nothing; raise the function's memory instead.** A real and much cheaper experiment, and it is not foreclosed: if residual latency remains after this change, more memory is the next thing to try. It is rejected as the _primary_ answer because the fan-out's cost is round trips to DynamoDB, which CPU does not buy back.

## Consequences

**What gets easier.** The fleet read is one round trip instead of eight batched ones, and its cost stops growing with the fleet: more sites at existing locations add nothing to the read at all, and more locations add one item per hour each. The browser stops holding every site's rows to compute a total, and the `%` view's divisor arrives evidenced by the server.

**What gets harder.** There is one more item kind, one more thing that can be stale, and a fallback path to carry for a release. A reader of `cumulo-series` now has to know that one partition is not a site.

**What we accept.** A roll-up written mid-cycle mixes this cycle's locations with last cycle's. That is exactly what the per-site series did before it and what the fan-out read before it; the roll-up inherits the staleness and does not introduce it.

**Cost, stated because 0002's cost sections are what a reader will check this against.** Writes: one partial per location-hour, `12 × 48 = 576` items a cycle at the canonical fleet, on top of the ~2,880 forecast items — a term that grows with **locations**, not sites. That is ~2.52 M write units a month at $0.705/M, ≈ **$1.78/month** against ≈ $1.48 before. Reads: a 48-hour fleet forecast is ~576 items of ~250 B ≈ 144 KB, ≈ **18 eventually-consistent read units** against the ~25 the forecast fan-out was sized at — a modest unit saving, and **the units were never the problem**. The whole point is the round trips: `infra/storage/tables.tf`'s `series` section owns the current per-load figure.

**Zero Open-Meteo calls** on either side. This path reads and writes stored rows only, as both fleet routes' docblocks already state.

**What would make us revisit.**

1. A second consumer needing a real end-of-run event → Step Functions, as above.
2. The fallback event still appearing 24 hours after the first full post-deploy cycle → the roll-up is not being written, and the producer is wrong.
3. A fleet-aggregate field that is _not_ an additive per-hour total → the partial cannot carry it, and the additivity test will say so before anything ships.
4. The `#FLEET` partition becoming hot enough to be a partition-throughput concern — a single partition key is a single physical partition's worth of throughput, which at a demo's traffic is orders of magnitude away.

## Amendments

No stated value has moved. This section opens with a **restatement ledger**, which `docs/standards/architecture.md` rule 9 owes beside a value an ADR owns, and this ADR owns one.

**The value: the fan-out's measured latency, 1,753.9 ms p50 / 2,998.9 ms p95 warm** at the canonical 12-location × 5-site fleet. It is stated in `## Context` above, it is the whole reason ADR 0002's revisit trigger 4 is met, and it is quoted by five sites that argue from it rather than merely citing it:

- `packages/shared/src/fleet-rollup.ts` — the module docblock's "Why this module exists at all".
- `apps/api/src/forecast/fleet-rollup-read.ts` — "What this replaces".
- `apps/forecast/src/fleet-rollup-write.ts` — "Why it lives in the producer at all".
- `docs/adr/0002-storage-split.md` — its 2026-09-11 (#494) Amendments entry, an immutable carrier owed an as-it-stood annotation and its own entry rather than an inline true-up.
- `docs/review-feedback.md` — the 2026-09-11 (#494) entry.

Mutable carriers are trued up in the same change as the value (rule 11); the ADR carrier is not. The list is a **floor, not a census**: it is what a sweep found, so the sweep is stated — `command grep -rn` over `docs/`, `apps/`, `packages/` and `infra/` (excluding `node_modules`) on two arms, run 2026-09-11: the literal `1,753.9|2,998.9`, and a claim-shaped arm `p50|p95` for a carrier that paraphrases the measurement without repeating either figure. The second arm's hits were read; outside the five above they are unrelated latency prose. A carrier that neither repeats a figure nor uses those words is unsearched by this sweep rather than shown absent.

**A note on what this value is not.** The figure is a _measurement of what was replaced_, so it cannot move under this document the way a parameter can — nothing in the repo can re-measure a fan-out that no longer serves this route. What can happen is that it is re-measured on the fallback arm before #507 removes it, which would be a new measurement of a different thing and belongs in that ticket, not here.
