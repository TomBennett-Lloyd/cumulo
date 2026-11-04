# 0009 — Fleet forecast roll-up: partials at write, sum at read

- **Status:** accepted
- **Date:** 2026-09-11
- **Issue:** #494

**Supersedes ADR 0002 in part**: the `### Fleet-wide aggregation (A5): fan-out, chosen at this scale` decision, for the fleet **forecast** read only. Everything else in 0002 — the table split, the key design, the capacity mode, the TTL posture — stands untouched, and the fan-out remains how a fleet **actuals** read is served until the fast-follow ticket ([#506](https://github.com/TomBennett-Lloyd/cumulo/issues/506)) lands.

> **Amended 2026-10-07 (#506)**: the fast-follow has landed, so A5's fan-out is now superseded for the fleet actuals read as well, and survives only as both reads' fallback. See `## Amendments`.

> **Amended 2026-10-21 (#507)**: the fan-out is gone from both reads, so it no longer survives as anything. See the 2026-10-21 (#507) entry in `## Amendments`.

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

> **Amended 2026-10-07 (#506)**: `GEN` now has its producer, with no change to this key. See `## Amendments`.

> **Amended 2026-10-14 (#615)**: `GEN` gains a third key shape in this partition, `GEN#TOTAL#T#<validTime>#FLEET`, one fleet total per settled hour. See `## Amendments`.

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

> **Amended 2026-10-05 (#531)**: the "latent double-count" this paragraph names is not the mechanism the code has. The decision stands and the amendment strengthens it; see `## Amendments`.

### The fallback, and its removal trigger

For **one release**, a `#FLEET` window that is missing — or that is missing any location the active fleet has sites at, or that was read short by a page budget — falls back to the fan-out plus a server-side aggregate, and logs exactly one line:

```
{ event: 'api.fleet-forecast.rollup-fallback', reason: 'absent' | 'incomplete',
  expectedLocations: n, presentLocations: m, hours: h }
```

**Incomplete is treated exactly like absent**, which is the only judgement call in the fallback. Eleven of twelve locations sums to a fleet total that looks like a plausible number from a quieter fleet: the missing site does not read as missing, it reads as less generation. That is the half-truth the fan-out already refuses for itself.

> **Amended 2026-10-07 (#602)**: a location that has written is also checked for membership and vintage, and the event gains `reason: 'stale'` and a `staleLocations` count. See `## Amendments`.

Both arms end in the same `@cumulo/shared` functions, so this is a second _path_ and not a second owner of the numbers. **Removal trigger:** the event absent from the logs for 24 hours after the first post-deploy cycle. Tracked as [#507](https://github.com/TomBennett-Lloyd/cumulo/issues/507), which states the condition in the form a log query can answer.

> **Amended 2026-10-07 (#602)**: as it stood before `stale`, which fires in steady state after any site add, delete or edit at a bucket, so the event's absence is no longer the whole condition. See `## Amendments`.

> **Amended 2026-10-21 (#507)**: this section is as it stood. The arm, the event and the 24-hour trigger are spent: the arm is deleted and the trigger was met, with the evidence in the entry. The one judgement call survives in a different form: neither `absent` nor `incomplete` is refused, and neither is summed as whole. The response is served short, labelled by `contributingSiteCount`, and logged once as `api.fleet-forecast.rollup-short`. See the 2026-10-21 (#507) entry in `## Amendments`.

### The client seam moves up

`FleetDataSource.fleetForecasts` returns the aggregate rather than raw rows. The HTTP source reads the summed points off the wire; the demo source computes the identical shape with `fleetForecastAggregate` over its fixtures. One definition of the fleet total, two ways of arriving at the shape. The forecast's per-hour capacity divisor travels on the point, so the `%`-of-capacity view no longer re-derives it from rows the app no longer receives.

### Step Functions is the planned evolution, not a rejected alternative

An orchestrated cycle — a state machine that fans out the locations and has a real terminal state — is the right shape **once several consumers need a genuine end-of-run event**: the actuals roll-up (#506), off-cycle forecasts for add-a-site (#498), and anything that wants to publish "the fleet is fresh as of T". It is not taken now because this design needs no such event at all, and buying an orchestration layer to get one would be paying for a signal nothing currently reads. **The trigger is the second consumer**: when a second thing needs to know a cycle finished, Step Functions is the answer, and this roll-up becomes one of its steps rather than a thing bolted to the end of a message handler.

## Options considered

**A — Precomputed per-location partials, summed at read (chosen).** Zero extra reads on the producer; no end-of-run event needed; no last-writer race, because each invocation writes only its own keys. Costs one more item kind in the key design, and a read that is a sum rather than a fetch. Its real downside is the one 0002 named against the denormalised item generally and which stands here: the fleet total now has a second _representation_. The mitigation is that it has no second _definition_ — every kilowatt is computed by `aggregateFleetForecast` / `contributingCapacityKwByHour` and by nothing else, in the producer, in the fallback and in the demo source alike.

**B — Recompute the whole fleet row from storage on every message.** Simple and self-healing; the last message of a cycle leaves a complete row. Rejected on cost: it spends the ~25 read units the API was spending, **twelve times per cycle**, so below a few dashboard loads per cycle it _increases_ total reads — and it re-reads rows it has just written. It also has a last-writer race that A does not.

**C — One fleet-sum row, written after the partials.** The read becomes a single GetItem instead of a Query. Rejected because it reintroduces exactly the race A removes: twelve concurrent invocations each summing and rewriting one key, where the loser's write is a stale fleet. The Query it avoids is one round trip either way.

> **Amended 2026-10-14 (#615)**: the race this option rejects does not arise for a _settled_ hour, which no later invocation writes (residual 1 below is the exception). A fleet total is kept for those hours alone. See `## Amendments`.

**D — A time-bucketed GSI** (0002's own stated alternative). Turns a single-bucket fleet read into one Query, but turns a week-long window into one Query per bucket, and duplicates the entire forecast write volume into an index. Rejected for the reason 0002 gave, unchanged.

**E — API Gateway response caching.** ~$14/month for the smallest cache, on a platform whose entire storage bill is a dollar or two, and the first reader of every cache period still pays the full fan-out. Rejected on cost and on the part of the problem it does not solve.

**F — A TTL'd cache row, or an in-memory cache in the Lambda.** Both leave the first reader paying; the in-memory one leaves the first reader _per container_ paying, which on a low-traffic demo is close to every reader. Rejected.

**G — Do nothing; raise the function's memory instead.** A real and much cheaper experiment, and it is not foreclosed: if residual latency remains after this change, more memory is the next thing to try. It is rejected as the _primary_ answer because the fan-out's cost is round trips to DynamoDB, which CPU does not buy back.

## Consequences

**What gets easier.** The fleet read is one round trip instead of eight batched ones, and its cost stops growing with the fleet: more sites at existing locations add nothing to the read at all, and more locations add one item per hour each. The browser stops holding every site's rows to compute a total, and the `%` view's divisor arrives evidenced by the server.

**What gets harder.** There is one more item kind, one more thing that can be stale, and a fallback path to carry for a release. A reader of `cumulo-series` now has to know that one partition is not a site.

> **Amended 2026-10-21 (#507)**: "a fallback path to carry for a release" is as it stood; the path is gone. See the 2026-10-21 (#507) entry in `## Amendments`.

**What we accept.** A roll-up written mid-cycle mixes this cycle's locations with last cycle's. That is exactly what the per-site series did before it and what the fan-out read before it; the roll-up inherits the staleness and does not introduce it.

**Cost, stated because 0002's cost sections are what a reader will check this against.** Writes: one partial per location-hour, `12 × 48 = 576` items a cycle at the canonical fleet, on top of the ~2,880 forecast items — a term that grows with **locations**, not sites. That is ~2.52 M write units a month at $0.705/M, ≈ **$1.78/month** against ≈ $1.48 before. Reads: a 48-hour fleet forecast is ~576 items of ~250 B ≈ 144 KB, ≈ **18 eventually-consistent read units** against the ~25 the forecast fan-out was sized at — a modest unit saving, and **the units were never the problem**. The whole point is the round trips: `infra/storage/tables.tf`'s `series` section owns the current per-load figure.

> **Amended 2026-10-07 (#602)**: the read figures above (~250 B, 144 KB, ~18 units) are as they stood before each item carried its provenance. The write line is unchanged. See `## Amendments`.

> **Amended 2026-10-07 (#506)**: the write line above (~2.52 M units, ≈ $1.78/month) is as it stood before the actuals slices. See `## Amendments`.

**Zero Open-Meteo calls** on either side. This path reads and writes stored rows only, as both fleet routes' docblocks already state.

**What would make us revisit.**

1. A second consumer needing a real end-of-run event → Step Functions, as above.
2. The fallback event still appearing 24 hours after the first full post-deploy cycle → the roll-up is not being written, and the producer is wrong. _(As it stood before #602: an `absent` or `incomplete` line still means this; a `stale` line can mean a site changed.)_
3. A fleet-aggregate field that is _not_ an additive per-hour total → the partial cannot carry it, and the additivity test will say so before anything ships.
4. The `#FLEET` partition becoming hot enough to be a partition-throughput concern — a single partition key is a single physical partition's worth of throughput, which at a demo's traffic is orders of magnitude away.

> **Amended 2026-10-21 (#507)**: trigger 2 is as it stood. Its event is now `api.fleet-forecast.rollup-short` (and `api.fleet-actuals.rollup-short`), and it means this only for reason `absent` or `incomplete` persisting past one cycle; `stale` can mean a site changed. See the 2026-10-21 (#507) entry in `## Amendments`.

## Amendments

No stated value has moved. The 2026-10-05 entry below records two corrections that are not value moves, and the two 2026-10-07 entries and the 2026-10-14 entry move only quotations of figures `infra/storage/tables.tf` owns (the 2026-10-14 entry also records a new mechanism). This section opens with a **restatement ledger**, which `docs/standards/architecture.md` rule 9 owes beside a value an ADR owns, and this ADR owns one.

**The value: the fan-out's measured latency, 1,753.9 ms p50 / 2,998.9 ms p95 warm** at the canonical 12-location × 5-site fleet. It is stated in `## Context` above, it is the whole reason ADR 0002's revisit trigger 4 is met, and it is quoted by five sites that argue from it rather than merely citing it:

- `packages/shared/src/fleet-rollup.ts` — the module docblock's "Why this module exists at all".
- `apps/api/src/forecast/fleet-rollup-read.ts` — "What this replaces".
- `apps/forecast/src/fleet-rollup-write.ts` — "Why it lives in the producer at all".
- `docs/adr/0002-storage-split.md` — its 2026-09-11 (#494) Amendments entry, an immutable carrier owed an as-it-stood annotation and its own entry rather than an inline true-up.
- `docs/review-feedback.md` — the 2026-09-11 (#494) entry.

Mutable carriers are trued up in the same change as the value (rule 11); the ADR carrier is not. The list is a **floor, not a census**: it is what a sweep found, so the sweep is stated — `command grep -rn` over `docs/`, `apps/`, `packages/` and `infra/` (excluding `node_modules`) on two arms, run 2026-09-11: the literal `1,753.9|2,998.9`, and a claim-shaped arm `p50|p95` for a carrier that paraphrases the measurement without repeating either figure. The second arm's hits were read; outside the five above they are unrelated latency prose. A carrier that neither repeats a figure nor uses those words is unsearched by this sweep rather than shown absent.

**A note on what this value is not.** The figure is a _measurement of what was replaced_, so it cannot move under this document the way a parameter can — nothing in the repo can re-measure a fan-out that no longer serves this route. What can happen is that it is re-measured on the fallback arm before #507 removes it, which would be a new measurement of a different thing and belongs in that ticket, not here.

### 2026-10-05 (#531) — the completeness check's granularity, and the model hazard it was wrong about

Two corrections, no change to the decision. Both came out of #494's own review, were logged as `docs/tech-debt.md` entries, and were raised as [#531](https://github.com/TomBennett-Lloyd/cumulo/issues/531).

**1. Completeness is per location, deliberately, and not per hour.** `### The fallback, and its removal trigger` above compares location _sets_: a `#FLEET` window missing any location the active fleet has sites at falls back. A location that wrote _some_ of its hours and not others is therefore summed, and the hours it is short of are summed over the remaining locations. That is one dimension in from the half-truth the fallback exists to refuse, and the state is reachable — `writeFleetRollup`'s `store-partial` outcome is a logged-and-retried policy, not an impossibility.

It stays per location, for three reasons the route cannot argue its way out of:

- **An expected-_hours_ notion is not this route's to hold.** A cycle is twelve independent invocations with no end-of-run event (`## Context` above), so mid-cycle the locations legitimately hold _different_ hour sets — the mixing `## Consequences` already accepts. Any within-read agreement test therefore fires on normal operation, once per cycle, and falls back to the fan-out this ADR exists to stop paying for.
- **The two candidates both cost more than the gap.** A per-location hour count written beside the partials is the second _representation_ option A above argues against; a producer that failed the record on a partial drain trades a missing hour for a whole location's horizon redelivered, which `apps/forecast/src/fleet-rollup-write.ts` refuses by design and says why.
- **The residual is labelled, not silent**, which is the half that makes it acceptable under `docs/standards/error-handling.md` rule 5 rather than merely cheap. `contributingSiteCount` travels on every point, `minimumContributingSites` (`apps/web/src/dashboard/fleet-series.ts`) folds it to the thinnest hour, and `partialAggregateNotice` (`apps/web/src/dashboard/state-copy.ts`) renders it. A short hour reads as a fleet whose sites did not all report, because that is what it is. The fan-out arm has the same property, so the two arms agree about this too. `apps/api/src/forecast/fleet-rollup-read.test.ts` pins it as a case rather than as this paragraph.

What would reopen it: [#507](https://github.com/TomBennett-Lloyd/cumulo/issues/507), which removes the fan-out arm and so removes the fallback the gap currently hides behind, and any consumer that needs the fleet total without a count beside it.

> **Amended 2026-10-21 (#507)**: #507 has removed the arm, so the gap no longer hides behind a fallback: a location short of an hour is summed and labelled, as this entry decided, and so is a location short of its whole horizon. See the 2026-10-21 (#507) entry in `## Amendments`.

**2. The "latent double-count" in `### One model, named once` was wrong when written.** `aggregateFleetForecast` does not sum two models' views of one site-hour: `groupOnePerSitePerHour` keeps one entry per `siteId` per hour and `forecastSupersedes` is `>=` on `issuedAt`, so same-cycle physics and ML rows collapse to whichever arrived last in input order. An unfiltered fleet total is therefore not inflated — it is a total whose _model_ was decided by row order, and the sort key orders `FC#ml` before `FC#physics`, so the model that survives today is luck rather than design. That is a better reason for naming one model, not a worse one, so the decision is unchanged; what moves is which failure it prevents. `packages/shared/src/fleet-rollup.test.ts` asserts the collapse so the claim has a test under it.

The filter also moved, which is what #531 changed in code: `fleetForecastAggregate` and `fleetRollupPartials` now **take** the forecast kind, so the producer, this ADR's fallback arm and the browser's demo source are held to one model selection by the compiler rather than by three call sites each remembering to filter.

**Known quoters of the corrected claim** — a floor, not a census. Sweep run 2026-10-05 from the worktree root, **three** arms over `docs apps packages infra`: `command grep -rnE 'double-count|double count'` for the literal, `command grep -rnE 'two models|second model|physics and (an )?ML'` for a carrier that paraphrases it, and — added in review cycle 1, which found two carriers the first two arms could not see — `command grep -rnE 'twice the fleet|as twice'` for a carrier that states the consequence without naming the mechanism. Positive control for the third arm: it returns `apps/api/src/forecast/fleet-rollup-read.test.ts`'s trued comment, which holds the string. All three arms' hits were read; the ones that carry _this_ claim are:

- `packages/shared/src/aggregation.ts` — the root carrier every other site cites, and the only one that stated the mechanism. Trued up in the same change (rule 11).
- `packages/shared/src/fleet-rollup.ts` — `FLEET_ROLLUP_FORECAST_KIND`'s docblock. Trued up.
- `apps/forecast/src/fleet-rollup-write.ts` — `rolledUpForecasts`'s docblock, deleted with the helper the shared filter replaces.
- `apps/api/src/forecast/fleet-rollup-read.ts` — `aggregateFromFanOut`'s docblock. Trued up.
- `apps/api/src/forecast/fleet-rollup-read.test.ts` — the model case's comment, which said an unfiltered fan-out arm "would read as twice the fleet". Trued up: on that fixture it reads the _other model's_ number.
- `docs/tech-debt.md`'s #494 entry — "the demo chart would read as twice the fleet". Not trued here and nothing is owed: the 2026-10-05 triage replaced that entry with a redirect row to #531, so the claim is already absent from `main` (`git show origin/main:docs/tech-debt.md` returns no occurrence) and present only in this branch's older base.
- `docs/review-feedback.md`'s 2026-09-11 (#494) entry — a past-tense record of what that PR claimed, left as written: the entries are the record.
- `### One model, named once` above — immutable, annotated inline rather than reworded.

Everything else both arms returned is unrelated: `apps/ingestion/src/cycle-budget.test.ts` (visit hours), `packages/storage/scripts/smoke/series-checks.ts` (a window boundary), `infra/README.md` (cross-stack cost rows), and the `two models` hits in ADR 0002, `docs/tech-debt.md` and the storage fixtures, which count models rather than claiming anything about summing them.

### 2026-10-07 (#602) — completeness by membership and vintage, not by location set only

**What changed.** `### The fallback` compares location _sets_, but the fleet changes one _site_ at a time. A delete, an eviction, a delete-plus-add in one bucket, or a `PUT /v1/sites/{siteId}` that resizes or re-angles a site leaves its location expected. That location's slices keep summing the old sites until its next cycle ([#579](https://github.com/TomBennett-Lloyd/cumulo/issues/579)). Each slice now carries a provenance (`fleetRollupProvenanceSchema`, `packages/shared/src/fleet-rollup-provenance.ts`). It sits beside `locationId` and outside the additive partial, because neither of its two fields adds:

- `members`: a digest of the sorted `(siteId, capacityKw, tiltDegrees, azimuthDegrees, locationId)` tuples of the sites the producer listed;
- `issuedAt`: the forecast run the slice was summed from.

The read computes the same digest per location from the active fleet it already lists. If any of a written location's slices carries a different digest, no provenance (an item written before this change), or a second `issuedAt`, the read falls back with `reason: 'stale'`. `apps/api/src/forecast/fleet-rollup-read.test.ts` pins each case.

**Vintage is compared within a location, never across locations.** The first reason the 2026-10-05 entry gives against an expected-hours notion applies here too: locations are written by independent invocations on their own schedule, so they legitimately differ by a run. The 2026-10-05 entry's per-location, not per-hour, decision is untouched: a location short of an hour is still summed and labelled.

**What it does not catch.** `issuedAt` is the instant the message was consumed (`apps/forecast/src/consume-message.ts`), so a redriven dead letter is stamped as the newest run. A location it leaves holding two runs falls back, but the fan-out serves the same replayed per-site rows: [#587](https://github.com/TomBennett-Lloyd/cumulo/issues/587)'s replay is detected at most, never repaired, by this entry. A coordinate edit that stays inside one bucket is not in the tuple either: the tuple carries the bucket, not the coordinates.

**What it costs.** Two attributes, about 50 B an item, still one write unit at every fleet size, so the write line is unchanged. The roll-up read grows from ~18 to ~22 read units at the canonical fleet; `infra/storage/tables.tf`'s `series` section owns that figure and is trued up in the same change. The larger cost is the fallback rate. Any membership change at a location now sends reads down the fan-out until that location's next cycle, and that includes an _add_ at an existing bucket, because a digest cannot tell an add from a delete-plus-add. A new bucket already fell back this way. A read racing a location's write, or a run missing a mid-horizon hour, also shows two runs; both fall back to an answer the fan-out agrees with.

> **Amended 2026-10-21 (#507)**: the fallback-rate cost above is as it stood. An add no longer reads as stale (membership is judged as of the run), and a location that does read stale is left out of the sum and labelled instead of sending the read down the fan-out. See the 2026-10-21 (#507) entry in `## Amendments`.

**Rejected** (priced on #579, 2026-10-07). A `siteIds` set costs a second Query page at the site cap. A per-site contributions map would let the read subtract a departed site instead of falling back, at roughly three times the item size and two pages. Refusing an older vintage at write needs a condition `BatchWriteItem` cannot carry: either a conditional Put per hour (a round trip each) or a transaction per location (double the write units).

**What would reopen it.** [#507](https://github.com/TomBennett-Lloyd/cumulo/issues/507) removes the fan-out arm, and with it the answer `stale` falls back to. Before that, #507 has to decide what a stale location gets instead, given that an add now produces one.

> **Amended 2026-10-21 (#507)**: #507 decided what a stale location gets: it is left out of the sum and labelled. See the 2026-10-21 (#507) entry in `## Amendments`.

**Quoters of the moved read figure.** This is a floor, not a census. The sweep was run 2026-10-07 from the worktree root with `command grep -rnE` over `docs infra apps packages`, on the arm `≈ 45|~43|~18( |$)|144 KB|~250 B|read units? (a|per) load|per-dashboard-load|roll-up read`, and every hit was read. Trued up in the same change: `infra/storage/tables.tf`'s `series` section (the owner) and its header ledger, `infra/README.md`'s storage `series` cost row, and the fleet-vs-poll comment in `apps/web/src/data/use-first-forecast.test.tsx`. Annotated as-it-stood: `## Consequences` above, and ADR 0002's 2026-09-11 (#494) entry, through ADR 0002's own 2026-10-07 entry. `docs/review-feedback.md`'s entries are records and are left as written. The remaining hits are other quantities that share a literal (ADR 0005's log bytes, `infra/api/outputs.tf`'s warmer) or prose that names the read without a figure.

### 2026-10-07 (#506) — the actuals producer, and what "complete" means for a look-back

**What landed.** The `GEN` kind has its producer, with no change to the key or the partial schema. `fleetActualsRollupPartials` (`packages/shared/src/fleet-actuals-rollup.ts`) writes a reading as a partial with the degenerate band and `hasUncertainty: false`. `packages/shared/src/fleet-rollup-additivity.test.ts` extends the additivity proof to that path.

The forecast service sums each location's slices from the readings its trailing-actuals step already holds, so it does zero extra reads. It re-Puts every hour of the `TRAILING_ACTUALS_HOURS` window on every run, which is what lets a slice pick up a membership change at its next cycle. If any site's window is unknown (a failed read, or a write that did not fully land), nothing is written. A partial slice would read as a quieter fleet.

`GET /v1/fleet/actuals` reads the slices with one Query _(as it stood before #615; see the 2026-10-14 entry)_ (`apps/api/src/forecast/fleet-actuals-rollup-read.ts`) and keeps the fan-out as its fallback. ADR 0002's A5 fan-out is therefore superseded for the actuals read as well, and #507 removes it from both reads.

> **Amended 2026-10-21 (#507)**: "keeps the fan-out as its fallback" is as it stood; the fan-out is removed from this read too. See the 2026-10-21 (#507) entry in `## Amendments`.

**Completeness, decided by the owner on 2026-10-07.** The #602 rule cannot be reused as written, because a look-back is written by many runs:

- **No vintage check.** A 24-hour window carries 24 runs' `issuedAt`s by construction.
- **Membership is checked only on the hours the producer still rewrites**: the last `TRAILING_ACTUALS_HOURS` before the read's `to`. Older settled hours are summed as written. After an add, this agrees with the fan-out, because a new site has no earlier readings. After a delete or a capacity edit, it does not. Historical hours keep the departed site's generation and the capacity it had then, where the fan-out, which reads only today's sites, drops or reprices them. That is accepted. Checking every hour would send every actuals read down the fan-out for a whole look-back after any change, including every add-a-site.
- **One check the forecast read does not need.** A location whose oldest site predates the window by `TRAILING_ACTUALS_HOURS` must hold a slice for the window's first hour, or the read falls back as `incomplete`. Without this check, for the first week after deploy, a history the producer has not yet written would be served as a whole one. That is the half-truth this ADR's fallback exists to refuse. The same check also sends a window that opens inside an idle-schedule gap down the fan-out, which answers with the same gap. [#629](https://github.com/TomBennett-Lloyd/cumulo/issues/629) removed the `PUT` bucket move that was this check's one known cost case.

`apps/api/src/forecast/fleet-actuals-rollup-read.test.ts` pins each case.

> **Amended 2026-10-21 (#507)**: the first-hour check in the bullet above is retired with the fan-out it fed. Its gap is per hour and labelled by `contributingSiteCount`. See the 2026-10-21 (#507) entry in `## Amendments`.

**What it costs.** Writes: up to three slices per location per cycle, `12 × 3 = 36`. That moves `infra/storage/tables.tf`'s write line to ≈ $1.80/month (≈ $6.36 at the 100-site cap) _(as it stood before #615; see the 2026-10-14 entry)_, and the `## Consequences` write line is annotated as-it-stood. Reads: the default 24-hour actuals window is 288 items, about 11 units, where the fan-out it replaces cost about 25. The per-load figure falls to ≈ 35, and `infra/storage/tables.tf` owns it _(as it stood before #615; see the 2026-10-14 entry)_. A 168-hour window is about 74 units at the canonical fleet and about 320 at the 52-location cap _(as it stood before #615; see the 2026-10-14 entry)_. Both are above the 30-unit request that ADR 0010 prices its burn-rate projection on. ADR 0010 had priced the same read at ≈ 270, using the pre-#602 item size; its 2026-10-08 amendment trues that figure to this one, and records that the move fires its revisit trigger 2 ([#630](https://github.com/TomBennett-Lloyd/cumulo/issues/630)). Compacting settled hours is [#615](https://github.com/TomBennett-Lloyd/cumulo/issues/615).

**Quoters of the moved figures.** This is a floor, not a census. The sweep was run 2026-10-07 with `git grep -nE` over `docs infra apps packages`, on five arms:

- `1\.78|6\.28|2\.52 ?M|3,456|12,196|2\.79|5,426|2\.08`: the write line.
- `≈ ?\$(1\.8|2\.1)|[0-9.]+% of the ~\$100|between them|two together|two cliffs|this stack('s)? (≈|costs)`: the storage stack total. In review, the first arm's literal replacement had re-minted these as the `series` line.
- `≈ 49|~47|~25 covering|read units? (a|per) load|per-dashboard-load|per-load read`: the per-load read.
- `(ten|eleven|[0-9]+) billed lines|[0-9]+ lines per invocation|[0-9]+ ?MB`: the forecast log census, which grows by one line per invocation.
- `fan(s|-)? ?out|only path|one caller|not yet produce|future actuals|per-site Queries`: prose describing the old actuals path.

Every hit was read. Trued up in the same change:

- `infra/storage/tables.tf`: the owner, plus its header ledger.
- `infra/README.md`: the storage `series` row, the three-fleet-sizes note, the running total and the stack-total prose around it, the forgotten-stack and teardown notes, the forecast DynamoDB driver row, and the forecast log row and census.
- `infra/forecast/outputs.tf` (DynamoDB driver and log census) and `infra/forecast/event-source.tf`.
- `infra/ingestion/outputs.tf`.
- The fleet-vs-poll comment in `apps/web/src/data/use-first-forecast.test.tsx`.
- `apps/api/src/request-budget.ts`'s per-route ungated-prefix ledger: the actuals route now has the forecast route's shape, 4 on the roll-up path and 5 on fallback.
- Old-path prose in `apps/api/src/forecast/fleet-series-read.ts`, `apps/api/src/forecast/get-fleet-actuals.ts`, `apps/web/src/data/use-first-forecast.ts`, `docs/design/dashboard-composition.md`, `packages/shared/src/storage-key.ts` and `packages/storage/src/adapters/series/fleet-rollup-item.ts`.

Annotated as-it-stood: `## Consequences` above. The remaining hits are ADR 0002's historical entries, `docs/review-feedback.md`'s records, and unrelated numbers that share a literal (fixture data, `apps/web/src/map/clustering.test.ts`).

### 2026-10-14 (#615) — settled actuals hours compacted into one fleet total per hour

The decision and reasoning above are untouched. This entry records a new mechanism and the values it moves. The owner approved it on 2026-10-15.

**What landed.** A third key shape in `#FLEET`: `GEN#TOTAL#T#<validTime>#FLEET` (`fleetActualsTotalSortKey`), holding `fleetActualsAggregatePointSchema` — no band, no provenance, no `locationId`. The forecast service, after writing its location's slices, Queries the latest totals before `issuedAt − TRAILING_ACTUALS_HOURS`, sums the slices of every hour settled since (at least the last `TRAILING_ACTUALS_HOURS` settled hours, and the whole retention reach when no total exists yet), and Puts a total for each hour lacking one (`apps/forecast/src/fleet-actuals-compaction.ts`). The key reuses the partition and `fleetActualsAggregatePointSchema`, so there is still no new table, GSI, attribute definition, IAM grant or credential: the owner read it as a producer change within this ADR's "a producer, never a schema", not a key-design change.

**Why option C's race does not apply.** C rejected one fleet-sum row because twelve concurrent invocations would sum hours still being written. A settled hour has no later writer. Within one invocation the slice window and the compaction window are disjoint (`[issuedAt − 3 h, issuedAt)` versus `< issuedAt − 3 h`), and a later invocation's `issuedAt` is no earlier, so, bar residual 1 below, the invocations compute the same item for an hour and the Put is idempotent with no last-writer.

**The read.** `GET /v1/fleet/actuals` issues two Queries: the totals over the window, then the slices from the hour after the last total. The 2026-10-07 (#506) completeness rule is inherited unchanged in its three parts, with two consequences the owner approved:

- **A total is summed as written.** A site deleted or re-sized, or a whole location decommissioned, keeps its generation and capacity in every hour that was settled when the change happened. Today's read drops a decommissioned _location's_ settled hours; after this it keeps them, which is the #506 site-level rule applied at the location level ("the total should be real").
- **The first-hour check is satisfied by a total**, since a total exists only where slices did.

Expected locations must appear in the slices read (about the last four hours). That is stricter than today's whole-window presence only for a location that has produced nothing for three or more consecutive cycles, a state in which the fan-out answers the same, at its price. Membership is still checked only on the trailing hours, and there is still no vintage check. `apps/api/src/forecast/fleet-actuals-rollup-read.totals.test.ts` pins each case.

**Migration.** No backfill script. Until the first post-deploy cycle the read finds no totals and is today's read exactly. That cycle's invocations each compact every settled hour in retention (the slices present since #506, one Query of their volume, once), and the read shrinks from the next request. Hours with no slices (idle gaps, the pre-#506 past) get no total and are absent from the result exactly as today.

**Accepted residuals.** The owner accepted all three without the per-cycle re-Put:

1. A total written while a slice for its hour was still in flight (two invocations straddling an hour boundary and overlapping in time; the schedule fires at HH:07) is never re-summed. The hour is short by that slice, labelled only by `contributingSiteCount`.
2. A partial drain that lands a later hour's total and declines an earlier one leaves that hour uncompacted once it is older than `TRAILING_ACTUALS_HOURS`. Its slices sit between totals and neither Query reads them: a chart gap, like an idle gap, which the compaction's `store-partial` log line reports when it happens.
3. The read is two Queries. The second is admitted through the deadline gate, so `apps/api/src/request-budget.ts`'s ungated prefix stays at 4.

**Rejected.** A (cap the window) and C (stay on the billing leg), from #506's Q1: A is a product regression that still fails at the cap. Re-Putting every settled hour's total each cycle: 36 writes per cycle, which moves the write line, and it buys only residual 1. A one-off backfill script in the shape the repo already has (`apps/forecast/scripts/backfill-actuals.ts`, run as `pnpm --filter @cumulo/forecast-service backfill-actuals`): it is an operator-credentialed run with a runbook step, the read must cope until it runs anyway, and that script writes per-site `GEN` readings only (`putGenerationReadings`), never `#FLEET` slices or totals, so running it before or after this change cannot leave a total stale. A fixed 24-hour read-side split (falls back for most of every hour). A time-bucketed GSI (option D, unchanged).

**What it costs.** Writes: up to one total per location's invocation per cycle, `locations × 52` items a cycle with the slices (owner: `infra/storage/tables.tf`); the write line is unchanged at the stated precision. Reads: the default 24-hour window is about 3 units at the canonical fleet and a 168-hour window about 14 at the 52-location cap (owner: `infra/storage/tables.tf`, which prices a total at a slice's size; `packages/storage/src/adapters/series/fleet-actuals-total-item.test.ts` shows a total is the smaller). The producer spends two small reads per invocation, and the forecast log census grows by one line per invocation (owner: `infra/forecast/outputs.tf`).

**What would reopen it.** [#507](https://github.com/TomBennett-Lloyd/cumulo/issues/507)'s fallback removal has to decide what an hour with slices but no total gets. A `store-partial` from the compaction observed in the logs reopens the per-cycle re-Put this entry declined. A second total kind (forecast) would generalise the `TOTAL` segment.

> **Amended 2026-10-21 (#507)**: #507 decided it: an hour with slices but no total is a slice hour like any other, summed from the slices read and labelled by its count. The first-hour check that a total satisfied (the bullet above) is retired. See the 2026-10-21 (#507) entry in `## Amendments`.

**Quoters of the moved figures.** This is a floor, not a census. Three sweeps were run 2026-10-15 from the worktree root with `git grep -nE` over the whole tree, at `git rev-parse --short HEAD` = `d30ab3b` (this change's tree before its figures were edited), and every hit was read:

- The write census, `1\.80|6\.36|2\.55 ?M|2,652|52 × 51|locations × 51|12 × 3 = 36|36 actuals slices`: 24 hits. A fourth literal, `3,492`, found three carriers that arm misses (`infra/forecast/outputs.tf` and `event-source.tf`, and the forecast DynamoDB row).
- The per-load read, `≈ 35|~33|read units? (a|per) load|per-dashboard-load|per-load read|~11 for|288 items|~74\b|≈ 320|about 320`: 39 hits. This claim is now ledgered: `.claude/ledgers/series-per-load-read.ledger` replaces the prose list in `infra/storage/tables.tf`'s header, and `pnpm check:ledgers` re-runs its sweep.
- The forecast log census, `(twelve|thirteen|[0-9]+) billed lines|[0-9]+ lines per invocation|105 MB|105,100`: 8 hits.

Trued up in the same change: `infra/storage/tables.tf` (the owner, and its header); `infra/README.md` (the storage `series` row, the three-fleet-sizes note, the forecast DynamoDB row, and the forecast log row and its census); `infra/forecast/outputs.tf`, `infra/forecast/event-source.tf` and `infra/forecast/iam.tf`; `apps/forecast/src/main.ts`; `apps/api/src/request-budget.ts`; `apps/web/src/data/use-first-forecast.test.tsx`; `docs/design/dashboard-composition.md`. Annotated as-it-stood: this ADR's own #506 entry above (its one-Query read, its ≈ $6.36 at the cap, and its 11-unit window, ≈ 35 load, 74 and 320 figures). Left as written: ADR 0002's historical entries, `docs/review-feedback.md`'s records, and `infra/README.md`'s ingestion log row, which is a different function's census and which nothing the compaction emits lands in.

### 2026-10-21 (#507) — the fallback removed; a short partition is served labelled; what a stale location gets

The decision above stands: partials at write, one Query at read. This entry removes the second path and answers the question the 2026-10-07 (#602) entry left to this ticket, what a stale location gets instead of the fan-out.

**What came out.** Both reads' fan-out arm; `apps/api/src/forecast/fleet-series-read.ts` and its test; `querySeriesRange` from both reads' dependencies, so neither fleet route issues a per-site Query any more; the events `api.fleet-forecast.rollup-fallback` and `api.fleet-actuals.rollup-fallback`; the unstamped arm of `FleetRollupRow.provenance` (an item with no provenance now fails the parse, a violated invariant under `docs/standards/error-handling.md` rule 1); and the actuals read's first-hour check. Every item written since #602 (merged before #506) is stamped, so no unstamped item can sit in a read window.

**What replaced it.** #507's body proposed a 500 for a missing or incomplete partition. That is withdrawn: `stale` fires in steady state after every add-a-site (a digest cannot tell an add from a delete-plus-add), and a new 0.01° bucket is not written until the next `:07` cycle, so a 500 would blank the fleet chart for every visitor for up to an hour after normal demo use. Instead the read sums the locations whose slices are fresh, leaves the rest out, and the wire contract labels the gap. That is `docs/standards/error-handling.md` rule 5's first sentence, not its second: the contract has the field (`contributingSiteCount` travels on every point, `minimumContributingSites` folds it, `partialAggregateNotice` renders it), so a refusal is not the honest answer. It is the argument the 2026-10-05 (#531) entry makes for a location short of an hour, applied to a location short of its whole horizon.

- **The three reasons are kept** as one line per short response under new events, `api.fleet-forecast.rollup-short` and `api.fleet-actuals.rollup-short`, each with `reason: 'absent' | 'incomplete' | 'stale'`, the expected, present and stale location counts, and `hours`. A line now means the response was served short of what it names.
- **Membership is judged as of the run.** A slice is fresh when its digest equals the digest of the sites at that location that existed when it was issued (`createdAt <= issuedAt`). An add alone is therefore not stale: the producer had not been told about the site, so it has no forecast ([#286](https://github.com/TomBennett-Lloyd/cumulo/issues/286)), and the slice is exactly the right sum for every site that has one. The mismatches left are a delete, an eviction, a delete-plus-add and a physics edit (the [#579](https://github.com/TomBennett-Lloyd/cumulo/issues/579) cases), which are left out and labelled.
- **No path makes a stale slice read fresh.** The producer lists its sites before it reads the clock that becomes `issuedAt` (`apps/forecast/src/consume-message.ts`), so every site in a slice's digest was created at or before `issuedAt`. The as-of digest equals the stored one only when the two site sets are equal. Skew between the API's clock and the producer's can only move a site across the `issuedAt` line in the direction that makes the digests differ, so it reads stale and never fresh.
- **A read cut short by the deadline is the one 500** (`complete: false` from a page walk), answered with the route's own deadline event as the per-site routes do, because a window missing its tail is labelled by no count.
- **`absent` is `points: []` on the forecast read**, the route's already-documented answer for a fleet with nothing forecast yet, and is not cached. On the actuals read it means no slice in the tail window, and the settled totals are still served.
- **The actuals first-hour check is retired.** It existed to send an unwritten history down the fan-out. With the fan-out gone its gap is per hour, and labelled by the same count.

**The removal evidence**, from the deployed environment on 2026-10-21 as the read-only observer identity (`cumulo-observer`, [#604](https://github.com/TomBennett-Lloyd/cumulo/issues/604)): `aws logs filter-log-events --log-group-name /aws/lambda/cumulo-api-dev --filter-pattern '"rollup-fallback"'` over the 30 days to 2026-10-21T10:50Z returned no events, for both arms and every reason. Positive controls on the same group: `REPORT` returned lines, and a quoted term matched inside a token. #603's canary has invoked `GET /v1/fleet/forecast?hours=48` every five minutes since 2026-10-07 20:55Z. Producer side, `/aws/lambda/cumulo-forecast-dev` over 26 hours held 364 `forecast.fleet-rollup.outcome` lines: 26 consecutive hourly cycles, each writing all 14 locations with `status: written`. The actuals arm's log evidence is weaker (only visitors hit that route); the producer-side figure carries it, the slices being written by the same invocation. A 24-hour re-run of the first query is a merge precondition recorded on the issue.

**What it costs.** Nothing on the per-load figure: `infra/storage/tables.tf`'s `series` section is unchanged. The fallback double read that ADR 0010's entries price no longer exists. After an add-a-site at a new bucket the fleet chart reads one location short, labelled, until that bucket's next cycle: the residual [#286](https://github.com/TomBennett-Lloyd/cumulo/issues/286) owns. A delete at a location now leaves that whole location out of the sum until its next cycle, where the fan-out would have dropped only the deleted site; that is the price of not reading per site, and it is labelled the same way.

**Rejected.** The 500 as the body wrote it (above). A fan-out scoped to the stale locations: it keeps `querySeriesRange`, the module, and the worst case ADR 0010's trigger 2 is still open on. The per-site contributions map priced on #579: it cannot synthesise a forecast for an added site, so it solves only the delete case, at three times the item size.

**What would reopen it.** A `rollup-short` line with reason `absent` or `incomplete` persisting past one cycle: the producer is wrong, as revisit trigger 2 says. A consumer needing the total without its count beside it.

**Quoters.** This is a floor, not a census. The sweep, run 2026-10-21 from the worktree root, was `git grep -nE '#507|rollup-fallback|fallback arm|first-hour|uncovered' -- ':/docs/adr'`, plus a second arm over the whole tree for prose that argues from the fallback in the present tense, `git grep -niE "(api|api's|0009's|read's|reads'|fleet|roll-?up) fallback|fallback'?s? (arm|path|sums|treats|does|own)|fan-?out (fallback|arm)" -- ':/'`; every hit was read. Trued up from the second arm: `packages/storage/src/adapters/series/series-adapter.ts`, `packages/shared/src/fleet-rollup.ts` and `fleet-actuals-rollup.ts`, `apps/web/src/data/demo-fleet-data-source.ts` and `apps/forecast/src/fleet-rollup-write.ts`. Annotated as-it-stood in the same change: the ten sites above that carry the fallback, and ADR 0010's 2026-10-08 and 2026-10-14 entries (its own amendment below). Left as written: ADR 0002's 2026-10-07 entry ("survives only as both fleet reads' fallback, until #507"), a dated entry that remains true.
