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

That gives 30 calls per cycle, 720/day, against the 10,000/day quota. Per cycle it gives `30 × 48 = 1,440` weather items and `50 × 48 × 2 = 4,800` forecast items, so about 6,240 writes per cycle and, at 730 cycles a month, **≈ 4.6 M writes/month** plus ~37 K actuals. Items are a few hundred bytes, so one write request unit each. Retained at 90 days that is ~13.7 M items ≈ **3.5 GB** before per-item overhead.

### Cost forces

Figures are AWS list prices for us-east-1, **verified 2026-07-30**. Ireland (eu-west-1) — the likely region for a UK/Ireland fleet — runs roughly 10–15% higher; no conclusion below turns on that margin.

**DynamoDB.** The always-free tier is 25 GB of standard-class storage plus 25 provisioned WCU and 25 provisioned RCU per Region per payer account, and it **does not expire after twelve months**. The capacity portion applies to provisioned mode only; on-demand bills from the first request at **$0.625 per million write request units and $0.125 per million read request units**. Those are the post-November-2024 prices — the on-demand cut halved the older $1.25/$0.25 figures, which several third-party pricing summaries still quote, and the difference is large enough to matter to this comparison.

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

The cost of four tables is four Terraform resources inside #13's single module and one `terraform destroy`. One consequence is worth naming: were the free provisioned tier ever adopted, four tables plus two GSIs are six separately provisioned entities, each needing at least 1 WCU and 1 RCU from the Region's 25 — feasible, but fiddly, and it is a coupling that fewer tables would avoid.

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

### Capacity mode: on-demand

`PAY_PER_REQUEST` on all four tables. The provisioned free tier's 25 WCU/25 RCU would in fact cover the modelled write volume — 6,240 writes spread over a five-minute cycle is ~21 WCU — so this choice knowingly forfeits a genuinely free option. Three reasons:

- **The read side does not fit.** A dashboard load is ~50 eventually-consistent Queries ≈ 25 read units, so the entire free read allowance is consumed by roughly **one dashboard load per second**. A portfolio demo that gets posted anywhere exceeds that, and the failure mode is `ProvisionedThroughputExceededException` — a visibly broken demo at the exact moment someone is looking at it.
- **The 25 units are one shared regional pool.** Every future table, GSI, and ticket would have to renegotiate against it, turning a capacity budget into a cross-ticket coupling.
- **The bill is ~$3/month.** 4.6 M write units at $0.625/M ≈ $2.88, and reads at plausible demo traffic add well under $1. Against a $100 ceiling, that is a rounding error bought with the removal of a whole class of failure.

Honest counter-point in the other direction: under provisioned capacity an abusive read burst throttles, which is cost-safe; under on-demand it bills. That is why #29's throttling sits at the gateway, _upstream_ of DynamoDB, with billing alarms as the backstop.

### Table settings — each one an idle-billing decision

- **Point-in-time recovery: off.** $0.20/GB-month to recover data the owner has decided is disposable. Every stored fact is refetchable from Open-Meteo or recomputable by a pure function.
- **DynamoDB Streams: off.** ADR 0001's transport is Kinesis; a second event source would bill for existing and add a trigger surface.
- **Deletion protection: off.** Clean teardown is a project requirement and #13 must exercise `destroy`.
- **Encryption: the AWS-owned key** (no charge), not a customer-managed KMS key ($1/month plus request charges). There is no compliance requirement here to justify the second one.
- **Standard table class.** Standard-IA trades request price for storage price, and storage is free at this volume.

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
- **On-demand forfeits a genuinely free tier.** The provisioned allowance would cover the write volume; ~$3/month is being spent to avoid a shared capacity budget and visible throttling.

### D. Single-store PostgreSQL

This option has the strongest _technical_ argument of the four, and it should be stated at full strength. A5 becomes a single `SELECT sum(...) ... GROUP BY date_trunc('hour', ...)`. A6 becomes a join. H2 becomes a `NOT EXISTS`. #29's cap becomes a constraint inside a transaction. #22's graph becomes a recursive CTE. There is one adapter family, one mental model, referential integrity throughout, and native declarative partitioning with BRIN indexes handles this time-series volume comfortably.

Rejected because:

- **It pays every one of A's standing charges — ~$69/month, ~69% of the ceiling — and adds the time-series volume to a 20 GB micro instance**, so the first capacity decision arrives early rather than never.
- **The bill starts on day one and is unrelated to usage**, which is the exact inverse of this project's stated posture that idle cost is the steady state.
- **Retention becomes machinery rather than a table setting.** DynamoDB's TTL is an attribute; here it is partition management plus a scheduled job, running on a cluster that also has to be cheap to idle.
- Teardown, VPC, and connection-limit problems are identical to A.
- On the portfolio axis it reads worst of all: choosing the familiar store and then paying $69/month standing under a $100 ceiling to hold fifty rows and some hourly series is the decision hardest to defend on its merits.

## Consequences

**Easier.** #13 implements four `aws_dynamodb_table` resources, two GSIs, one TTL attribute, and on-demand capacity in a single Terraform module with a one-step `destroy` — no VPC, no subnet groups, no proxy, no secrets. #16 gets exact quota protection, because the `ARCHIVE#DAY#` marker written in the same transaction as its readings makes "fetch each site-period at most once" a property of the key design rather than of caller discipline. #29 gets a structural seed-fleet exemption via the sparse GSI2 and an atomic cap via the counter item. #20 gets forecast identity that already carries the model variant, in both the series and metrics keys. #17's ~60-second path needs no cache invalidation and no snapshot rebuild. #19's aggregation stays the pure function architecture rule 3 wanted anyway. And least privilege becomes a list of table ARNs: ingestion reads `sites` and writes `weather`; forecast reads `sites` and `weather` and writes `series` and `metrics`; the fleet API writes `sites` and reads the rest.

**Harder, and accepted.** Fan-out instead of `GROUP BY`; no ad-hoc SQL; no referential integrity; the site cap and orphan cleanup as application-level invariants; and this document as required reading for the data layer. These are option C's downsides, accepted with open eyes rather than argued away.

**Standing cost.** **$0 while nothing runs.** In steady state, **≈ $3/month** at the modelled cadence — dominated by ~4.6 M write request units a month from hourly ingestion, which runs on a clock whether or not anyone visits. That is the honest framing: the steady state here is not zero, it is three dollars, and reads add well under $1 at plausible demo traffic. Storage sits inside the always-free 25 GB at ~3.5 GB. If it ever matters, the levers are ingestion cadence, forecast horizon, and bundling a horizon series into one item per (site, model, day) instead of one item per point — roughly a tenfold write reduction, deliberately not taken now because it complicates partial updates for a saving of a couple of dollars. Nothing else in the storage layer bills: no VPC, no NAT Gateway, no instance, no proxy, no PITR, no customer-managed key. The only standing charge in the platform remains ADR 0001's Kinesis stream.

**The RDS free-tier expiry, stated explicitly.** The twelve-month window runs from account creation, and this account's has already expired (owner-confirmed, 2026-07-30). Had option A or D been chosen there would have been no free period at all — the failure this ceiling exists to prevent, a bill that starts silently after a year, would instead have been an immediate known charge. Because no RDS or Aurora resource is created, there is nothing to expire and no dated cliff anywhere in the storage layer. This is the fact that moved the decision furthest: issue #3's title assumed a free relational store, and on this account there is no such thing.

**Nothing survives teardown, deliberately.** Per the owner's decision (2026-07-30), tearing the project down means deprecating it, so the hindcast cache should go with it. Hence no PITR, no final snapshots, no S3 mirror. The Open-Meteo quota embodied in the archive cache is spent again only if the project is rebuilt — the accepted price of a one-step destroy.

**Assumed scale, restated as the thing that would falsify this.** ~50 sites over ~30 locations, hourly, 48-hour horizon, two models, 90-day retention: 720 Open-Meteo calls/day against 10,000; ~6,240 writes per cycle and ~4.6 M/month; ~3.5 GB retained; ~25 read units per dashboard load. Every one of those numbers is a lever, and an order-of-magnitude move in any of them is a reason to reopen this.

**What would make us revisit.** ADRs are immutable — any change supersedes this one with a new ADR and never edits it. Concrete triggers:

1. **A fleet in the hundreds.** The single `FLEET` partition, the per-site fan-out behind A3 and A5, and GSI2's constant partition key all stop being free choices. Expected answers: a time-bucketed GSI for A5, a fleet-latest snapshot item for A3, a sharded site partition.
2. **#22's topology graph becoming a feature rather than a design sketch.** A recursive relational workload is what DynamoDB is worst at, and a superseding ADR adding PostgreSQL for topology alone — its standing costs then justified by a workload instead of an intuition — is the expected shape.
3. **Lead-time-stratified skill scoring**, which puts the issue-time axis back into the series sort key.
4. **The aggregate endpoint becoming hot enough** that fan-out latency or cost is visible: a time-bucketed GSI, or a cached aggregate.
5. **Write volume becoming material**, which triggers the horizon-bundling optimisation named above.
6. **The DynamoDB line exceeding a meaningful fraction of the ceiling**, or #29's billing alarms firing on storage rather than requests.
7. **Any requirement that data survive teardown**, which reverses the persistence decision and reintroduces PITR or an export path.
