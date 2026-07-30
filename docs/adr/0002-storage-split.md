# 0002 — Storage split

- **Status:** accepted
- **Date:** 2026-07-30
- **Issue:** #3

## Context

Cumulo stores two shapes of data. There is low-volume, relational-looking site metadata — a location, a panel tilt and azimuth, a nameplate capacity, whether the site is part of the seed fleet or was added by a visitor — and there is high-volume, append-only time series: weather readings, per-site forecasts, generation actuals, and error metrics. The intuition that these want different stores is what issue #3's title assumes, and it is a reasonable intuition. This ADR exists because the intuition has to survive contact with the cost constraint, and it does not.

ADR 0001 fixes the frame. Storage is platform-owned rather than service-owned, precisely because ingestion, forecast, and the fleet API all read or write it, and 0001's Consequences delegate "what forecast and the fleet API read and write" to this decision. (0001 refers to this decision by issue number, as "ADR #3"; this document is ADR 0002 and carries `Issue: #3`. Nothing is renumbered.) Architecture rule 2 constrains the design directly: one zod schema per domain concept in `@cumulo/shared`, serving API validation, stream payloads, and frontend types, so whatever split is chosen must be servable by those single schemas with no per-store duplicate types.

The governing cost posture is free-tier-first AWS under a hard ceiling of roughly $100/month, with **idle cost treated as the steady state** — the demo mostly sits there, and a charge that accrues while nobody is looking is the expensive kind. Clean Terraform spin-up and tear-down is a requirement, not an aspiration, which makes teardown friction a first-class comparison axis rather than an operational footnote.

### Access-pattern inventory

Every pattern the platform needs, from the tickets that need it. The Decision maps each of these to a key or an index; an unmapped pattern would be a defect in this document.

| ID  | Pattern                                                                                          | Consumer          |
| --- | ------------------------------------------------------------------------------------------------ | ----------------- |
| I1  | Enumerate the distinct locations of all **active** sites, once per ingestion cycle               | Ingestion (#11)   |
| I2  | Append a location's forecast weather readings for the horizon                                    | Ingestion (#11)   |
| F1  | On a stream record for location _L_, read the physics parameters of every active site at _L_     | Forecast (#12)    |
| F2  | Write per-site forecast points for a named model variant                                         | Forecast (#12/20) |
| F3  | Write per-site generation actuals                                                                | Forecast (#19)    |
| A1  | Create, read, update, delete one site by id                                                      | Fleet API (#14)   |
| A2  | List the whole fleet (map markers)                                                               | Fleet API (#17)   |
| A3  | Latest forecast for a site — for every site on dashboard load, including one created seconds ago | Fleet API (#17)   |
| A4  | Forecast and actual for one site over an arbitrary time range                                    | Fleet API (#19)   |
| A5  | Fleet-wide aggregate over a time window, with an uncertainty band                                | Fleet API (#19)   |
| A6  | Physics and ML forecasts plus their metrics for one site and period, side by side                | Fleet API (#20)   |
| H1  | Read archive weather for a location over a past date range                                       | Hindcast (#16)    |
| H2  | Decide whether a given location-day of archive weather has **already been fetched**              | Hindcast (#16)    |
| H3  | Write archive weather for a location-day                                                         | Hindcast (#16)    |
| H4  | Write per-site error metrics for a model, period, and named baseline                             | Hindcast (#16)    |
| H5  | Read error metrics for a site and period                                                         | Hindcast (#16)    |
| X1  | Count user-generated sites, to enforce the cap on create                                         | Abuse (#29)       |
| X2  | Find the **oldest user-generated** site for eviction — never a seed site                         | Abuse (#29)       |
| X3  | Delete an evicted site and stop its series growing                                               | Abuse (#29)       |

Two of these carry more weight than their line length suggests. **H2** is a hard constraint wearing the clothes of a cache: Open-Meteo's free tier is 10,000 calls/day, archive fetches draw on the same quota as live ingestion, and #16 requires each site-period to be fetched at most once — so "have we already got this?" must be answered exactly, not approximately. **A5** is the one pattern a relational store would serve better than anything else here, and it is where this decision pays its largest price.

### Assumed scale

The numbers everything below is sized against, from #9 and #11: roughly **50 sites** — bounded by #29's cap, not by hope — spread over roughly **30 distinct weather locations** after #9's deliberate co-location, an **hourly** ingestion cadence, a **48-hour horizon at hourly resolution**, **two model variants** (physics and ML, per #20), and **90-day retention** on live series.

That gives 30 calls per cycle, 720/day, against the 10,000/day quota. Per cycle it gives `30 × 48 = 1,440` weather items, `50 × 48 × 2 = 4,800` forecast items, and 50 generation actuals — **6,290 writes per cycle** and, at 730 cycles a month, **≈ 4.6 M writes/month**. Items are a few hundred bytes, so one write request unit each. Retained at 90 days that is ~13.7 M items ≈ **3.5 GB** before per-item overhead.

Divided through by fleet size, one site costs `48 × 2 + 1 = 97` write units of its own plus its share of the weather fetch (`30 ÷ 50 = 0.6` locations per site, `× 48 = 28.8`) — **≈ 125.8 write units per site per cycle**. That per-site figure is what the capacity section scales.

### Cost forces

Figures are AWS list prices for us-east-1, **verified 2026-07-30**. Ireland (eu-west-1) — the likely region for a UK/Ireland fleet — runs roughly 10–15% higher; no conclusion below turns on that margin.

**DynamoDB.** The always-free tier is 25 GB of standard-class storage plus 25 provisioned WCU and 25 provisioned RCU per Region per payer account, and it **does not expire after twelve months**. The capacity portion applies to provisioned mode only; on-demand bills from the first request at **$0.625 per million write request units and $0.125 per million read request units**. Those are the post-November-2024 prices — the on-demand cut halved the older $1.25/$0.25 figures, which several third-party pricing summaries still quote, and the difference is large enough to matter to this comparison. Beyond the free allowance, provisioned capacity itself lists at **$0.00065 per WCU-hour and $0.00013 per RCU-hour** (verified 2026-07-30); those numbers do not appear on this project's bill, but they are what makes the honest cost comparison in the capacity section come out the way it does.

A capacity fact the sizing below leans on: DynamoDB **retains up to 300 seconds of unused capacity as burst**, so a provisioned table that has been idle can absorb a spike far above its sustained rate. AWS documents this as best-effort — burst capacity may be consumed by background maintenance and the behaviour may change without notice — so everything below is sized against the **no-burst** case and treats burst as margin. For a demo that idles between hourly cycles, that margin is always there in practice.

**RDS.** The free tier is 750 hours/month of a Single-AZ `db.t2/t3/t4g.micro` plus 20 GB of storage, for MySQL, MariaDB, or PostgreSQL — **for twelve months from account creation**. This project's AWS account is old and barely used, so **that window has already expired** (owner-confirmed, 2026-07-30). Any RDS resource therefore bills from hour one: `db.t4g.micro` PostgreSQL at ~$0.016/hour ≈ $11.70/month, plus 20 GB of gp3 at ~$0.115/GB-month ≈ $2.30, so **≈ $14/month standing** before backups or data transfer. There is no free period to spend and no dated cliff to plan for — the cliff is behind us.

**Lambda talking to PostgreSQL is where the bill actually lands.** Three facts compound:

- RDS lives in a VPC. The ingestion Lambda needs the VPC to reach the database _and_ the public internet to reach Open-Meteo, and a VPC Lambda has no public address — so it needs a **NAT Gateway at $0.045/hour ≈ $32.85/month** plus $0.045/GB processed. The alternative is a publicly accessible instance whose security group must admit Lambda's non-static egress addresses, which in practice means the internet.
- Lambda opens a connection per execution environment, and `db.t4g.micro` derives `max_connections` from 1 GiB of memory — about 112. The standard fix is **RDS Proxy at $0.015 per vCPU-hour with a two-vCPU minimum and no free tier ≈ $21.90/month standing**.
- Summed: **≈ $69/month, accruing while completely idle, to hold about fifty rows** — roughly 69% of the ceiling spent on plumbing that moves no data.

**Aurora Serverless v2** appears to solve the idle-instance problem and does not. It bills $0.12/ACU-hour on Aurora Standard, a minimum capacity of 0 ACUs enables auto-pause, and instance charges do go to zero while paused (storage does not). But per the Aurora User Guide, retrieved 2026-07-30: an associated **RDS Proxy holds a connection open to every instance in the cluster, so a cluster with a proxy never auto-pauses**. Scale-to-zero and Lambda connection pooling are mutually exclusive. Without pooling the resume latency lands in the request path — typically about 15 seconds, and **30 seconds or more once the instance has been paused for over 24 hours** and Aurora moves it into a deeper sleep. An idle portfolio demo is paused for days, so the first visitor of the week pays the deep-sleep resume, inside #17's ~60-second forecast-visible budget and in front of a public endpoint. And the floor is only zero if it genuinely pauses: minimum non-zero capacity is 0.5 ACU ≈ $0.06/hour ≈ **$43.80/month**, the minimum auto-pause interval is five minutes, and any poller, health check, or forgotten session keeps the cluster awake — which, given #29's abuse surface, makes "nothing touches it for five minutes" an assumption rather than a guarantee.

**Teardown friction.** A DynamoDB table is one resource and destroys in seconds with no residue. An RDS or Aurora teardown is ordered and failure-prone: final snapshots, deletion protection, subnet groups, parameter groups, security groups, and a VPC that cannot be destroyed while Lambda's elastic network interfaces are still detaching. `terraform destroy` stops being a single step, and #13 has to exercise it rather than document it.

**Whether any data deserves to survive teardown.** The one real candidate is the hindcast archive cache, because it embodies spent Open-Meteo quota; everything else is refetchable or, since the models are pure functions per architecture rule 3, recomputable. The owner resolved this (2026-07-30): tearing the project down means deprecating it, so removing the cache with it is the desirable outcome. **No data has a cross-teardown persistence requirement**, which removes the only argument for a durable store sitting outside the Terraform lifecycle.

## Decision

**All of Cumulo's data lives in DynamoDB. There is no relational store.** This ADR concludes against its own issue title: the split is not chosen, because the relational half of it costs roughly $69/month standing — under a $100 ceiling, while idle, from day one — to hold about fifty rows of site metadata, and every cheaper relational shape fails on a different axis.

### Concept ownership

| Concept                        | Store    | Table                  |
| ------------------------------ | -------- | ---------------------- |
| Site (metadata, fleet member)  | DynamoDB | `cumulo-sites-<env>`   |
| Forecast (per site, per model) | DynamoDB | `cumulo-series-<env>`  |
| Generation reading (actual)    | DynamoDB | `cumulo-series-<env>`  |
| Weather reading (forecast)     | DynamoDB | `cumulo-weather-<env>` |
| Weather reading (archive)      | DynamoDB | `cumulo-weather-<env>` |
| Error metrics                  | DynamoDB | `cumulo-metrics-<env>` |
| — (nothing)                    | Postgres | —                      |

### Table strategy: four tables, not one, and not one per schema

Tables follow **partition-key identity** — the fleet, a site, a location, an evaluation run — and items that are read together share a table.

Against a **single table**: the canonical reason for single-table DynamoDB design is heterogeneous item collections retrieved in one Query. This inventory contains exactly one such collection — a site's forecasts and its actuals over a time range (A4) — and it is served inside `series`. No pattern reads a site record together with its series. A single table would therefore buy generic `pk`/`sk` attribute names that obscure meaning, a CloudWatch view aggregated across entity types so it cannot show which one is hot, `dynamodb:LeadingKeys` IAM conditions where table ARNs would do, and a data set nobody can interpret without this document open beside them. Single-table design is the most cargo-culted pattern in DynamoDB, and the honest test for it fails here.

Against **one table per schema** (six): forecasts and generation readings genuinely are read together (A4), and forecast weather and archive weather are the same concept at the same partition key (I2, H1) — separating either pair would split one Query into two and buy nothing.

The cost of four tables is four Terraform resources inside #13's single module and one `terraform destroy`. One consequence is worth naming, and the capacity section below acts on it: four tables plus two GSIs are six separately capacity-managed entities, and anything provisioned among them draws from one Region-wide pool of 25 WCU / 25 RCU. Fewer tables would avoid that coupling. What makes it tractable here is that the two GSIs both sit on `sites` — so the split below can leave `sites` on-demand and provision only the two GSI-free tables, and the pool is shared between two entities rather than six.

### Key design

Timestamps are **fixed-width ISO-8601 UTC to the second** (`2026-07-30T14:00:00Z`) so lexicographic order is chronological. Fixed width is load-bearing, not cosmetic: a variable-width timestamp silently breaks every range query below. Time ranges are half-open `[from, to)` — expressed as `sk >= 'T#<from>' AND sk < 'T#<to>'` — so no sentinel suffix character is ever needed.

**1. `cumulo-sites-<env>` — the control plane.** PK `pk` = the literal `FLEET`; SK `siteId` (the `siteSchema.id` uuid). Attributes: the `siteSchema` fields, plus `origin` (`seed` | `user`), `createdAt`, `active`, and `locationId`. No TTL — a site's lifetime is #29's business rule, not a clock.

- **GSI1 `by-location`**: PK `gsiLocation`, SK `siteId`, projection INCLUDE (`latitude`, `longitude`, `tiltDegrees`, `azimuthDegrees`, `capacityKw`). Sparse: `gsiLocation` is set to the site's `locationId` only while the site is active, so an inactive site is structurally absent from the index the forecast service reads.
- **GSI2 `user-sites-by-age`**: PK `gsiUserSites`, SK `gsiCreatedAt` (`<createdAt>#<siteId>`), projection KEYS_ONLY. Sparse: both attributes are written **only for `origin = user`**, so the seed fleet is invisible to eviction _structurally_ rather than by a filter a future change could forget. That is the point — #29's "never evict a seed site" becomes a property of the data model, not of the code path.
- A **counter item** at (`FLEET`, `#META#counters`) holds `userSiteCount`. Site creation is a `TransactWriteItems` of the site Put plus an `ADD` on the counter under the condition `userSiteCount < :cap`, so the cap is enforced atomically instead of read-then-write, which a race would otherwise defeat. Eviction and deletion decrement in the same transaction. GSI2's `Select=COUNT` query remains available as a reconciliation path.

Serves **A1** (GetItem/PutItem/UpdateItem/DeleteItem on `FLEET` + `siteId`), **A2** and **I1** (one Query on `FLEET`, then #11's own pure de-duplication over `locationId`), **F1** (Query GSI1 on the location), **X1** (the counter, or GSI2 with `Select=COUNT`), **X2** (Query GSI2 ascending, `Limit=1`), **X3** (DeleteItem plus a range delete on `series`).

Putting the whole fleet in one partition makes A2 and I1 single Queries rather than Scans. The partition-throughput limits (3,000 RCU / 1,000 WCU) are irrelevant at fifty sites, and the partition is bounded by #29's cap — a business rule that already exists — rather than by optimism. It is still a ceiling, and it is a revisit trigger.

**2. `cumulo-series-<env>` — per-site time series.** PK `siteId`; SK `T#<validTime>#<kind>` where `kind` is `FC#physics`, `FC#ml`, or `GEN`. Attributes: the forecast or generation-reading schema fields, plus `issuedAt` and `expiresAt` (TTL, `validTime` + 90 days). No GSI.

Serves **F2**/**F3** (PutItem), **A3** (Query `sk >= 'T#<current hour>'` ascending with a small `Limit`), **A4** (one Query over the range, returning physics, ML, and actual **interleaved by time** — exactly what #19's chart plots), and **A5** (that same Query per site, in parallel, feeding #19's pure aggregation function).

Interleaving by time before kind is what makes A4 a single Query; the cost is that A3 reads a few adjacent kinds and picks the one it wants, which is one Query and under one read unit either way.

**A3 needs no snapshot and no index**, which is what makes #17's ~60-second path fall out for free: a site created seconds ago has its forecast items written into its own partition, and the identical per-site Query that serves every other site sees them immediately. A denormalised fleet-latest item was considered and rejected — it is a second representation of a concept the schema already owns, it must be rebuilt on every partial write including #17's off-cycle single-site fetch, and it caps the fleet at a 400 KB item.

**The issue-time axis is deliberately collapsed.** The sort key carries _valid_ time, not issue time, so each cycle overwrites the point for a valid time it re-forecasts and `issuedAt` records the surviving vintage. This forfeits lead-time-stratified skill scoring ("how good is the 24-hour-ahead forecast specifically?"). #16's skill score compares a forecast series against actuals over a past period, which this serves, and #16's hindcast replays the pure physics model over stored archive weather for anything historical. If lead-time stratification is ever needed, a superseding ADR adds `#I#<issuedAt>` to the sort key at the cost of roughly 48× the forecast item count.

**3. `cumulo-weather-<env>` — per-location weather.** PK `locationId`; SK `<source>#T#<validTime>` where `source` is `FORECAST` or `ARCHIVE`, plus one marker item per fetched archive day at SK `ARCHIVE#DAY#<YYYY-MM-DD>`. Attributes: the weather-reading schema fields including Open-Meteo provenance, and `expiresAt` on `FORECAST` items only. TTL is per item, so one table holds both 90-day-expiring forecast weather and permanently retained archive weather without a second table.

`locationId` is the de-duplication key — latitude and longitude rounded to two decimal places (~1.1 km) — computed from the site's own coordinates by a pure function in `@cumulo/shared`. Ingestion's de-duplication rule (#11) and this partition key are therefore the same function call and cannot drift.

Serves **I2** (Put/BatchWrite), **H1** (Query `sk` between `ARCHIVE#T#<from>` and `ARCHIVE#T#<to>`), **H2** (BatchGetItem of the `ARCHIVE#DAY#<day>` markers for the requested days — the missing markers are exactly the days to fetch), and **H3** (a `TransactWriteItems` of the day's 24 hourly items plus its marker, so a partial fetch can never leave a marker claiming coverage it does not have).

Day granularity is what makes H2 exact. Keying the cache by requested _range_ instead would make "is this sub-range covered?" unanswerable for arbitrary ranges, and a wrong answer spends quota. Inferring coverage by counting hourly items would misread a genuine gap in the data as an unfetched day and refetch it. The marker is the cache-hit test; the readings are the payload. Transactions bill double write units, which at a few hundred location-days per experiment is cents. Caching by location rather than by site means co-located sites share the cache, so the quota saving compounds with ingestion's de-duplication.

Putting the archive cache in S3 instead was considered — the day blob suits object storage — and rejected: S3's 5 GB free tier is 12-month, the data fits inside DynamoDB's permanently free 25 GB, and it is retrieved by the same `(location, day)` key, so a second adapter family and IAM surface would buy nothing.

**4. `cumulo-metrics-<env>` — evaluation results.** PK `siteId`; SK `<periodStart>#<periodEnd>#<model>#<baseline>`. No TTL, no GSI.

Serves **H4** (PutItem) and **H5**/**A6** (one Query with `begins_with(sk, '<periodStart>#<periodEnd>#')`, returning both models' metrics for the same period in a single call — precisely the payload #20's comparison endpoint returns). Period before model in the sort key is what makes the side-by-side comparison one Query rather than two. The named baseline is part of the key because #16 requires a skill score to carry its reference; two baselines over the same period are two distinct results, not a collision. No TTL: metrics are small, few, and are the evidence #20 must publish either way.

### Fleet-wide aggregation (A5): fan-out, chosen at this scale

A5 is served by **one range Query per site, issued in parallel, aggregated by the pure function #19 already requires in `@cumulo/shared`.** The alternative is a time-bucketed GSI — PK `<model>#<bucket>`, SK `siteId` — which turns a single-bucket fleet read into one Query but turns a week-long window into one Query per bucket, and duplicates the entire forecast write volume into an index, roughly doubling write cost. At tens of sites, fan-out reuses the exact Query A4 already needs and costs nothing extra. The crossover is a fleet in the hundreds, or an aggregate endpoint hot enough that fan-out latency shows up; both are revisit triggers below.

### Capacity mode: hybrid — provisioned where the load is batch-shaped, on-demand where it is request-shaped

| Table                                | Mode        | WCU | RCU |
| ------------------------------------ | ----------- | --- | --- |
| `cumulo-series-<env>`                | provisioned | 14  | 21  |
| `cumulo-weather-<env>`               | provisioned | 5   | 3   |
| `cumulo-sites-<env>` (and both GSIs) | on-demand   | —   | —   |
| `cumulo-metrics-<env>`               | on-demand   | —   | —   |

**Total against the free tier: 19 WCU / 24 RCU of 25 / 25.** The standing DynamoDB capacity bill is **$0**.

The rule is one line: **a table whose load is batch-shaped — driven by a clock, with a volume this document can compute — is provisioned; a table whose load is request-shaped, driven by whoever happens to be looking, is on-demand.** `series` and `weather` are written by the hourly cycle and read by paths whose size is a function of fleet size. `sites` and `metrics` are touched by human-triggered CRUD and by #29's abuse surface, where the arrival rate is exactly the thing that cannot be predicted.

**The write path fits with an order of magnitude to spare.** One cycle is 6,290 write units (§ Assumed scale). The free 25 WCU delivers `25 × 3,600 = 90,000` write units per hour, so ingestion runs at **7% utilisation**. Against the allocation actually taken, `series` drains its 4,850 units in `4,850 ÷ 14 ≈ 347 s` and `weather` its 1,440 in `1,440 ÷ 5 = 288 s` — concurrently, on independent capacity, inside a 3,600-second cycle, **with zero burst assumed**. Burst makes both near-instant but is not required for correctness.

**There is no GSI write amplification on the hourly path at all**, and this is the single strongest fact for provisioning. A GSI consumes write capacity from its own pool every time a projected attribute changes on the base table, which is what usually makes provisioned sizing treacherous for a write-heavy workload. Here both GSIs are on `sites` — a table the ingestion and forecast cycle never writes — and `series`, `weather`, and `metrics` are GSI-free by the key design above. The hourly write volume is therefore exactly the item count, with no multiplier hiding behind an index. Leaving `sites` on-demand keeps it that way permanently: no future GSI on `sites` can ever draw on the provisioned pool.

**The read side fits too, and this is where the earlier reasoning needs correcting.** A dashboard load is ~50 per-site Queries on `series`, each returning a handful of small adjacent items; Queries are eventually consistent by default, so each costs the 0.5-unit minimum — **25 read units on `series`** — plus one Query over the ~50-item `FLEET` partition, roughly 2 units, which lands on `sites` and is billed on-demand. Call it **≈ 27 read units per load, ~25 of them against provisioned capacity**.

An earlier draft of this ADR read that as "the entire free read allowance is consumed by roughly one dashboard load per second" and rejected provisioned capacity on it. The arithmetic was right; the conclusion did not follow. One load per second _sustained_ is 86,400 loads a day, indefinitely — not a rate a portfolio demo is in danger of. At the 21 RCU allocated to `series` it is **~50 dashboard loads per minute sustained**, and the 300-second burst reserve holds `21 × 300 = 6,300` read units, so **~250 loads are absorbed instantly** before the sustained rate binds at all. An idle demo always has that reserve. A sustained-rate figure was used where a burst-inclusive one belonged.

`weather` gets 3 RCU because its only read paths are offline: #16's hindcast Query over an archive date range (a 90-day range is ~81 read units — 27 seconds at 3 RCU with no burst, instant with it) and #12's forecast service, which receives weather on the Kinesis stream rather than reading it back. Nothing on `weather`'s read path sits in front of a user.

#### Fleet headroom

The question this decision has to survive is what happens when the fleet grows. At **125.8 write units per site per cycle** (§ Assumed scale), holding the co-location ratio constant:

| Sites | Locations | Write units/cycle | % of free 25 WCU-hour | Ingest drain at this allocation, zero burst | Sustained dashboard loads/min at 21 RCU |
| ----- | --------- | ----------------- | --------------------- | ------------------------------------------- | --------------------------------------- |
| 10    | 6         | 1,258             | 1.4%                  | 69 s                                        | 252                                     |
| 25    | 15        | 3,145             | 3.5%                  | 173 s                                       | 101                                     |
| 50    | 30        | 6,290             | 7.0%                  | 347 s                                       | 50                                      |
| 100   | 60        | 12,580            | 14.0%                 | 693 s                                       | 25                                      |
| 200   | 120       | 25,160            | 28.0%                 | 1,386 s                                     | 13                                      |

**Writes are not the constraint at any fleet size this project will see** — 200 sites, four times #29's cap, is 28% of the free write allowance and still drains inside 40% of an hourly cycle. Reads degrade linearly because the fan-out is per site, so the read allocation is what a growing fleet spends first. That is already revisit trigger 1, which replaces the fan-out with a time-bucketed GSI or a snapshot for reasons that have nothing to do with capacity mode.

**#17's add-a-site path is not the risk.** A new site at a new location writes ~48 weather items and `48 × 2 = 96` forecast items — **~150 write units worst case**. With zero burst that is `48 ÷ 5 ≈ 10 s` on `weather` and `96 ÷ 14 ≈ 7 s` on `series`; the two stages are pipelined through Kinesis rather than strictly serial, so the contribution to #17's ~60-second forecast-visible budget is between 10 and 17 seconds in the pathological no-burst case, and effectively zero with the burst reserve an idle demo always holds. The site record itself goes to `sites`, on-demand, and is not rate-limited at all.

#### The failure mode, stated honestly

Provisioned capacity can throttle, and the counter-argument deserves its weight. Throttling surfaces as `ProvisionedThroughputExceededException`, which the AWS SDK's DynamoDB clients retry automatically with exponential backoff and full jitter — 4 attempts, 1,000 ms throttling base delay. That is the 2026 default retry set and it requires `AWS_NEW_RETRIES_2026=true`, so #13 must pin it explicitly rather than inherit whatever the runtime supplies, per `docs/standards/error-handling.md` rule 3: timeout, retry count, and backoff are visible at the call site, not implicit in library defaults.

On the write path a retried throttle is invisible — ingestion has an hour and needs six minutes. **The only genuinely user-visible throttle path is the synchronous dashboard fan-out**: one path, on one table, with ~250 loads of burst in front of it and a CloudWatch alarm behind it. That is a bounded, named risk rather than the "whole class of failure" the earlier draft believed it was removing.

The earlier draft also claimed an asymmetry that does not exist: that provisioned capacity throttles while on-demand only bills. On-demand tables accept `MaxReadRequestUnits` and `MaxWriteRequestUnits`, and a request above that ceiling throttles exactly like a provisioned one. Whether a runaway read costs money or availability is a **configuration choice available in both modes**, not a property of either. #29's gateway throttling and the billing alarms remain the right backstop either way.

#### Reversibility is what makes this cheap to get wrong

`billing_mode` is a table attribute, not an architectural commitment. Provisioned → on-demand is available up to **4 times per 24-hour rolling window**, and a table's first switch to on-demand instantly sustains at least 4,000 WCU / 12,000 RCU — roughly 200× and 500× the allocations above. On-demand → provisioned carries no such limit. If the demo is posted somewhere and the read allocation binds, the fix is a one-attribute Terraform change that takes effect without a migration, without downtime, and without touching a key, an index, or a line of adapter code. Nothing else in this ADR is that reversible, which is why the decision should turn on the merits of the common case rather than on insurance against the tail.

#### Cost, including the part that argues against this

Hybrid costs **$0/month**. All-on-demand would cost **≈ $2.88/month** (4.6 M write units at $0.625/M; reads well under $1 at plausible demo traffic).

The honest inversion: **provisioned capacity wins here only because the tier is free.** At list price the same 19 WCU / 24 RCU would cost `19 × $0.00065 × 730 ≈ $9.02` plus `24 × $0.00013 × 730 ≈ $2.28` — **≈ $11.30/month, roughly four times the on-demand bill** — because a 7% duty cycle is precisely the workload on-demand pricing exists to serve. Reserving capacity that sits idle 93% of the time is the wrong shape for this load on the merits, and it is chosen anyway because the first 25 units are free and this project's binding constraint is the bill. Saying so costs less than pretending provisioned is the better engineering answer.

#### The standing rule, so the shared pool is never renegotiated

The 25 units are one Region-wide pool, and the earlier draft was right that a shared budget can become a cross-ticket coupling. The rule that prevents it: **a new table defaults to on-demand unless its load is batch-shaped.** A ticket adding a request-shaped table takes no capacity and needs no conversation. Only a ticket adding another clock-driven batch table touches the pool, and such a ticket arrives with a computable volume — the one case where the budget can be divided on evidence rather than by negotiation. The 6 WCU / 1 RCU left unallocated is deliberately not a growth reserve; it is slack, and the rule is what stops it being needed.

#### What this costs, stated without softening

- **Two capacity modes in one Terraform module** must be explained to every reader of #13; the module is no longer four uniform resources.
- **Auto-scaling must be explicitly absent.** Any `aws_appautoscaling_target` attached to these tables will scale past 25 units under load and start billing silently — the single easiest way to get this wrong, and the reason #13 carries an explicit non-resource with a comment rather than a mere omission.
- **Throttle alarms become required work.** `ReadThrottleEvents` and `WriteThrottleEvents` on both provisioned tables are the difference between a bounded known risk and an unnoticed broken demo. On-demand would not have needed them.
- **The regional-pool coupling this ADR already named survives.** It is bounded by the standing rule above, not eliminated.

### Table settings — each one an idle-billing decision

- **Point-in-time recovery: off.** $0.20/GB-month to recover data the owner has decided is disposable. Every stored fact is refetchable from Open-Meteo or recomputable by a pure function.
- **DynamoDB Streams: off.** ADR 0001's transport is Kinesis; a second event source would bill for existing and add a trigger surface.
- **Deletion protection: off.** Clean teardown is a project requirement and #13 must exercise `destroy`.
- **Encryption: the AWS-owned key** (no charge), not a customer-managed KMS key ($1/month plus request charges). There is no compliance requirement here to justify the second one.
- **Standard table class.** Standard-IA trades request price for storage price, and storage is free at this volume.
- **Application Auto Scaling: absent, and absent on purpose.** An `aws_appautoscaling_target` on either provisioned table would raise capacity above 25 units under load and begin billing without anyone deciding to — the quietest way this decision could fail. #13 records the absence with a comment, so a later reader does not "fix" the omission.

### Architecture rule 2: one schema per concept, both stores derivable

The schemas are `siteSchema` (already in `packages/shared/src/site.ts`), plus `weatherReadingSchema`, `forecastSchema`, and `generationReadingSchema` from #10 and `errorMetricsSchema` from #16. One each. There is no `DynamoSite`, no `SiteItem` type declared field by field, and no `SiteRow`.

**No key attribute is a schema field.** `pk`, `sk`, `gsiLocation`, `gsiUserSites`, `gsiCreatedAt`, and `expiresAt` exist only inside the adapter's item type, never in the zod schema. That single rule is what keeps the schemas store-agnostic and answers #3's requirement that both a DynamoDB item shape and a Postgres row shape derive from one schema: a row mapping, should a superseding ADR ever need one, is the same schema with a different set of computed columns, and the schema itself does not change.

**Keys are computed from schema fields by named pure functions** in `@cumulo/shared` — `locationId(latitude, longitude)`, `seriesSortKey(validTime, kind)`, `metricsSortKey(period, model, baseline)`. They are unit-testable with no AWS involved, and ingestion's de-duplication key and the weather partition key are literally the same call.

**Adapters (#13) are a pair per concept.** `toItem` takes a validated domain object and adds computed key attributes; `fromItem` strips them and returns `schema.parse(rest)`, so a drifted item fails loudly at the boundary instead of flowing onward as `unknown`. Per architecture rule 3 they do mapping and query construction only, with no business logic and no suppressions.

**The physics-versus-ML discriminator is a `model` field on `forecastSchema`** — a zod enum — not a second forecast schema. That is how one schema serves #20's comparison, and the same value appears in both the `series` and `metrics` sort keys. Likewise **Open-Meteo provenance is a field on `weatherReadingSchema`** and round-trips as a plain attribute, so the CC BY 4.0 attribution obligation cannot be lost inside the storage layer.

## Options considered

### A. DynamoDB for time series + RDS PostgreSQL for site metadata — the issue's title

The upside is real. Site metadata is genuinely relational: SQL gives `CHECK` constraints on tilt and azimuth, uniqueness on names, a transactional create-and-evict for #29, a one-line `count(*)` for the cap, and the natural home for #22's fleet-topology graph if it ever becomes a feature. It is also the answer a reviewer expects, which has some value in a portfolio.

Rejected because:

- **It bills ~$69/month standing, while idle, from hour one**, for about fifty rows: ~$14 for the instance and storage, ~$21.90 for the RDS Proxy that Lambda's connection churn against a ~112-connection micro instance requires, and ~$32.85 for the NAT Gateway the ingestion Lambda needs because it must reach both the VPC and Open-Meteo. That is ~69% of the ceiling spent on plumbing that moves no data — and, because the account's free window has expired, there is not even a twelve-month grace period to defer it.
- **The cheap way out is a security posture this repo should not ship.** Skipping the NAT Gateway means a publicly accessible database whose security group admits Lambda's non-static egress addresses — effectively the internet. In a repo whose process is the deliverable, that trade is worse than the bill.
- **Teardown stops being one step**: final snapshots, deletion protection, subnet and parameter and security groups, and a VPC that will not destroy while Lambda's network interfaces detach.
- **Two adapter families and two failure vocabularies** for #13, and two places a domain concept can drift.
- **Cross-store writes have no transaction.** A site created in PostgreSQL and its first forecast written to DynamoDB can disagree, and nothing rolls back.

### B. DynamoDB + Aurora Serverless v2 for site metadata

This is the option that looks like it fixes A, and it deserves a fair hearing: real scale-to-zero, no instance charge while paused, $0.12/ACU-hour when awake, and SQL plus #22's future preserved.

Rejected because:

- **Scale-to-zero and connection pooling are mutually exclusive.** An associated RDS Proxy keeps a connection open to every instance, so a cluster with a proxy never auto-pauses (Aurora User Guide, retrieved 2026-07-30). Lambda wants pooling; pausing is the whole point of the option; you cannot have both.
- **Without pooling, resume latency lands in the request path.** About 15 seconds typically, and 30 seconds or more once paused beyond 24 hours — which for a demo that idles for days is the normal case, not the edge case. That sits inside #17's ~60-second forecast-visible budget and in front of a public endpoint.
- **The floor is only zero if it actually pauses.** Minimum non-zero capacity is 0.5 ACU ≈ **$43.80/month**, the minimum auto-pause interval is five minutes, and any poller or health check or open session keeps it awake. Given #29's abuse surface, five quiet minutes is an assumption, not a guarantee.
- **A's structural problems are untouched**: VPC and NAT Gateway, ordered teardown, two adapter families, no cross-store transaction. Storage also continues to bill while paused.
- It is the hardest option to defend in prose: a serverless relational cluster holding fifty rows is a stranger thing than either extreme.

### C. Single-store DynamoDB — chosen

One store, one adapter family, one Terraform module, one `destroy`. No VPC, no NAT Gateway, no proxy, no connection pooling, no database instance, no connection string, no secret to rotate and nothing for gitleaks to catch — IAM only. Storage cost is $0 inside the always-free 25 GB, and the request bill is a function of ingestion cadence rather than of wall-clock time.

Genuine downsides, and they are not small:

- **Fleet-wide aggregation becomes read fan-out rather than a `GROUP BY`.** A5 is one Query per site with aggregation in application code, where SQL would be one statement, and the cost grows linearly with fleet size. This is the clearest thing the project gives up.
- **Ad-hoc questions get materially harder.** "Which sites have the worst RMSE this month?" is a SQL one-liner and here is a fan-out plus an in-memory sort. There is no query planner, and a question the key design did not anticipate needs a Scan or a new index.
- **No referential integrity.** Nothing prevents series items outliving a deleted site; #29's eviction must delete the series itself, and orphans are prevented by discipline and TTL rather than by a foreign key.
- **The site cap is an application-level invariant** — a counter item in a transaction — where PostgreSQL would give a constraint. It is correct, but it is ours to keep correct.
- **The key design _is_ the schema.** Every pattern in the inventory is baked into a key or an index, so a genuinely new pattern means a migration or a new GSI, and this document becomes required reading for anyone touching the data. That is a deliberate trade of future flexibility for present cost and simplicity.
- **Reversing it is not free.** If #22's topology graph becomes real, it is the workload DynamoDB is worst at, and adding PostgreSQL then means paying A's standing costs then, with data to migrate.
- **Capacity mode is a live trade rather than a settled one.** The free provisioned allowance covers this workload, but taking it means a shared regional budget, a throttle that is visible on one synchronous path, and alarms that on-demand would not need. Options E–G below take that trade apart.

### D. Single-store PostgreSQL

This option has the strongest _technical_ argument of the four, and it should be stated at full strength. A5 becomes a single `SELECT sum(...) ... GROUP BY date_trunc('hour', ...)`. A6 becomes a join. H2 becomes a `NOT EXISTS`. #29's cap becomes a constraint inside a transaction. #22's graph becomes a recursive CTE. There is one adapter family, one mental model, referential integrity throughout, and native declarative partitioning with BRIN indexes handles this time-series volume comfortably.

Rejected because:

- **It pays every one of A's standing charges — ~$69/month, ~69% of the ceiling — and adds the time-series volume to a 20 GB micro instance**, so the first capacity decision arrives early rather than never.
- **The bill starts on day one and is unrelated to usage**, which is the exact inverse of this project's stated posture that idle cost is the steady state.
- **Retention becomes machinery rather than a table setting.** DynamoDB's TTL is an attribute; here it is partition management plus a scheduled job, running on a cluster that also has to be cheap to idle.
- Teardown, VPC, and connection-limit problems are identical to A.
- On the portfolio axis it reads worst of all: choosing the familiar store and then paying $69/month standing under a $100 ceiling to hold fifty rows and some hourly series is the decision hardest to defend on its merits.

### Capacity mode within option C: E, F, and G

Having chosen DynamoDB, the capacity mode is a second decision with its own three candidates. It is a genuine judgement call — an earlier version of this ADR chose E, on reasoning that was honest and arithmetically correct, and the sections below say why the answer moved.

#### E. On-demand on all four tables

The case for it is not weak. `PAY_PER_REQUEST` is one uniform attribute across four resources, needs no sizing exercise, no throttle alarms, and no auto-scaling abstinence; it cannot be invalidated by a fleet-size assumption drifting; and it absorbs an arbitrary traffic spike without anyone having modelled it. It leaves the 25/25 regional pool untouched, so no future table or ticket ever has to negotiate for capacity. And at **≈ $2.88/month** against a $100 ceiling, it buys all of that for a rounding error. If this project's constraint were engineering time rather than the bill, E would be the right answer.

Rejected because:

- **The read figure that decided it was a sustained rate presented as a ceiling.** "~25 read units per load, so 25 RCU is one load per second" is correct arithmetic about the steady state and silent about the 300 seconds of burst sitting in front of it. Restated properly — ~50 loads/minute sustained on `series` with ~250 absorbed instantly — the read side fits with room, and E's central objection dissolves.
- **The write side was never in question.** 7% of the free allowance, with no GSI amplification anywhere on the hourly path.
- **It forfeits a permanently free, non-expiring allowance** in a project whose stated posture is free-tier-first with idle cost as the steady state — while the modelled workload sits inside that allowance by an order of magnitude.
- The cost-safety argument advanced for it — that on-demand bills rather than throttles — is a configuration choice (`MaxRead/WriteRequestUnits`) available in both modes, so it does not separate them.

#### F. Provisioned on all four tables

The maximally free-tier-first answer: one mode, one Terraform idiom, $0.

Rejected because:

- **`sites` and `metrics` have request-shaped load.** Their arrival rate is whoever is looking, plus #29's abuse surface. Sizing them means guessing, and a wrong guess throttles the CRUD path that #17's demo flow depends on.
- **`sites` carries both GSIs.** A provisioned GSI needs its own allocation and consumes it on every projected-attribute write, so F puts four of the six capacity-managed entities in the pool instead of two, and couples the pool to any future index.
- The saving over G is zero — `sites` and `metrics` cost cents on-demand — so F pays real risk for no money.

#### G. Hybrid: provisioned for `series` and `weather`, on-demand for `sites` and `metrics` — chosen

Takes the free allowance exactly where the load is predictable and computable, and pays cents where it is not. $0/month, 19 WCU / 24 RCU of 25/25, both GSIs outside the pool permanently, and a standing rule (new tables default to on-demand) that keeps the budget from becoming a cross-ticket negotiation.

Its costs are real and are stated in the Decision: two modes in one module, mandatory auto-scaling abstinence, throttle alarms as required work, and a residual regional-pool coupling. The reason those are acceptable rather than merely tolerable is reversibility — `billing_mode` flips to on-demand in one Terraform attribute, up to four times per 24 hours, with the first switch instantly sustaining 4,000 WCU / 12,000 RCU. G is a bet that can be unwound in the time it takes to run `terraform apply`, which is not true of anything else in this document.

## Consequences

**Easier.** #13 implements four `aws_dynamodb_table` resources, two GSIs, one TTL attribute, and two capacity modes in a single Terraform module with a one-step `destroy` — no VPC, no subnet groups, no proxy, no secrets. #16 gets exact quota protection, because the `ARCHIVE#DAY#` marker written in the same transaction as its readings makes "fetch each site-period at most once" a property of the key design rather than of caller discipline. #29 gets a structural seed-fleet exemption via the sparse GSI2 and an atomic cap via the counter item. #20 gets forecast identity that already carries the model variant, in both the series and metrics keys. #17's ~60-second path needs no cache invalidation and no snapshot rebuild. #19's aggregation stays the pure function architecture rule 3 wanted anyway. And least privilege becomes a list of table ARNs: ingestion reads `sites` and writes `weather`; forecast reads `sites` and `weather` and writes `series` and `metrics`; the fleet API writes `sites` and reads the rest.

**Harder, and accepted.** Fan-out instead of `GROUP BY`; no ad-hoc SQL; no referential integrity; the site cap and orphan cleanup as application-level invariants; and this document as required reading for the data layer. These are option C's downsides, accepted with open eyes rather than argued away. The hybrid capacity mode adds four more: two modes to explain, mandatory auto-scaling abstinence, throttle alarms as work that on-demand would not have needed, and a residual coupling to the Region's 25/25 pool.

**What the capacity mode requires of #13.** Five things, none of them optional:

1. **No Application Auto Scaling resources.** No `aws_appautoscaling_target`, no `aws_appautoscaling_policy`, on either provisioned table. This is an explicit non-resource: the module carries a comment saying why, because an absence with no explanation reads as an oversight and the "fix" bills silently past the free tier.
2. **CloudWatch alarms on `ReadThrottleEvents` and `WriteThrottleEvents`** for `cumulo-series` and `cumulo-weather`. Throttling is the accepted failure mode of this decision, which makes an unobserved throttle the unaccepted one.
3. **Reads are deliberately eventually consistent.** The read sizing above assumes the Query default. `ConsistentRead: true` doubles read cost and there is no pattern in the inventory that needs it — every consumer is reading data written by a clock-driven cycle minutes earlier. Adapters set it nowhere, and a future caller wanting it needs a reason in the diff.
4. **`BatchWriteItem` returns HTTP 200 with `UnprocessedItems`.** Under provisioned capacity that field is how throttling actually arrives on the batch write path — a success response carrying dropped writes. Ignoring it silently loses data and would surface later as a phantom accuracy gap, exactly the failure `docs/standards/error-handling.md` rule 2 (never swallow) exists to prevent. The adapter retries unprocessed items with backoff or returns a typed partial-failure value; it never treats a 200 as done.
5. **Pin the SDK retry behaviour explicitly.** The 4-attempt, 1,000 ms-throttling-base, full-jitter defaults are the 2026 retry set gated behind `AWS_NEW_RETRIES_2026=true`. #13 sets it rather than inheriting it, per error-handling rule 3.

**What the capacity mode requires of #17.** The read-capacity risk in the add-a-site flow is **polling cadence, not viewer count**. A handful of concurrent visitors is nothing against ~50 loads/minute sustained plus ~250 of burst; several tabs each re-polling the whole 50-site fan-out every few seconds is ~25 read units per poll per tab and saturates the allocation quickly. The flow polls **the newly created site's own partition** — a single Query, 0.5 read units — not the fleet endpoint. Worth noting that this bites under on-demand too; it simply arrives as a bill instead of a throttle, which is the harder failure to notice.

**One thing we could not confirm.** AWS's pricing page describes the always-free 25 GB of storage in provisioned-mode terms, and we could not establish from the docs whether that allowance also covers on-demand tables. It does not affect the decision — under the hybrid split the two tables holding essentially all the data (`series` at ~3.5 GB, `weather`) are provisioned, so the allowance applies on any reading. It affects only the comparison figure: if on-demand tables are excluded, option E would have cost ≈ $3.75/month rather than ≈ $2.88 (3.5 GB at $0.25/GB-month). Immaterial to a decision that turned on $0 versus $3.

**Standing cost.** **$0/month — genuinely zero, not a rounding error.** The hourly cycle's ~4.6 M write units and the dashboard's reads land on `series` and `weather`, inside the permanently free 19 WCU / 24 RCU drawn from the Region's 25/25. Storage sits inside the always-free 25 GB at ~3.5 GB. `sites` and `metrics` bill on-demand at request volumes measured in thousands per month — cents, and not reliably a whole one. If write volume ever does matter, the levers are ingestion cadence, forecast horizon, and bundling a horizon series into one item per (site, model, day) instead of one item per point — roughly a tenfold write reduction, deliberately not taken now because it complicates partial updates to relieve a pressure that does not exist at 7% utilisation. Nothing else in the storage layer bills: no VPC, no NAT Gateway, no instance, no proxy, no PITR, no customer-managed key. The only standing charge in the platform remains ADR 0001's Kinesis stream.

The trade this buys is not money — the alternative was ≈ $2.88/month — it is that a capacity ceiling now exists where none did. That ceiling is documented, measured, alarmed, and reversible in one Terraform attribute.

**The RDS free-tier expiry, stated explicitly.** The twelve-month window runs from account creation, and this account's has already expired (owner-confirmed, 2026-07-30). Had option A or D been chosen there would have been no free period at all — the failure this ceiling exists to prevent, a bill that starts silently after a year, would instead have been an immediate known charge. Because no RDS or Aurora resource is created, there is nothing to expire and no dated cliff anywhere in the storage layer. This is the fact that moved the decision furthest: issue #3's title assumed a free relational store, and on this account there is no such thing.

**Nothing survives teardown, deliberately.** Per the owner's decision (2026-07-30), tearing the project down means deprecating it, so the hindcast cache should go with it. Hence no PITR, no final snapshots, no S3 mirror. The Open-Meteo quota embodied in the archive cache is spent again only if the project is rebuilt — the accepted price of a one-step destroy.

**Assumed scale, restated as the thing that would falsify this.** ~50 sites over ~30 locations, hourly, 48-hour horizon, two models, 90-day retention: 720 Open-Meteo calls/day against 10,000; 6,290 writes per cycle and ~4.6 M/month; ~3.5 GB retained; ~27 read units per dashboard load, ~25 of them provisioned. Every one of those numbers is a lever, and an order-of-magnitude move in any of them is a reason to reopen this. The capacity allocation is the part most tightly bound to them: it is sized from this scale, and the fleet table above says exactly where it stops holding.

**What would make us revisit.** ADRs are immutable — any change supersedes this one with a new ADR and never edits it. Concrete triggers:

1. **A fleet in the hundreds.** The single `FLEET` partition, the per-site fan-out behind A3 and A5, and GSI2's constant partition key all stop being free choices. Expected answers: a time-bucketed GSI for A5, a fleet-latest snapshot item for A3, a sharded site partition.
2. **#22's topology graph becoming a feature rather than a design sketch.** A recursive relational workload is what DynamoDB is worst at, and a superseding ADR adding PostgreSQL for topology alone — its standing costs then justified by a workload instead of an intuition — is the expected shape.
3. **Lead-time-stratified skill scoring**, which puts the issue-time axis back into the series sort key.
4. **The aggregate endpoint becoming hot enough** that fan-out latency or cost is visible: a time-bucketed GSI, or a cached aggregate.
5. **Write volume becoming material**, which triggers the horizon-bundling optimisation named above.
6. **The DynamoDB line exceeding a meaningful fraction of the ceiling**, or #29's billing alarms firing on storage rather than requests.
7. **Any requirement that data survive teardown**, which reverses the persistence decision and reintroduces PITR or an export path.
8. **A throttle alarm firing on `cumulo-series`, or a ticket needing a third batch-shaped table.** The first says the read allocation has met real traffic; the answer is to flip `series` to on-demand — one attribute, no migration — rather than to argue about RCU. The second is the only case in which the 25/25 pool has to be divided again, and the standing rule requires that ticket to arrive with a computed volume rather than an estimate.
