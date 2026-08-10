# The DynamoDB tables of ADR 0002 — the whole of Cumulo's persistence. There is
# no relational store; the ADR concluded against its own issue title.
#
# Four of them are the ADR's own domain tables. The fifth, `abuse`, is #29's
# per-IP limiter state: not a domain concept, but created and named here because
# it is the same store, the same convention, and the same cost ceiling.
#
# ---------------------------------------------------------------------------
# APPLICATION AUTO SCALING IS DELIBERATELY ABSENT. THIS IS A NON-RESOURCE.
# ---------------------------------------------------------------------------
# This stack contains no Application Auto Scaling scalable target and no
# scaling policy (`appautoscaling_target`, `appautoscaling_policy`) on any
# table in it, and adding one is the single quietest way this project's cost
# ceiling fails.
#
# The two resource types are named above without their provider prefix on
# purpose. A grep for the prefixed form across this directory is an acceptance
# check on this stack, and a check that its own explanatory comment trips is a
# check nobody can read; a real resource block always carries the prefix, so
# the grep stays a detector rather than a false positive generator.
#
# Since #258 (2026-08-09) **no table in this stack draws on the pool**: every
# one of the five is on-demand, and DynamoDB's *permanently free* 25 WCU /
# 25 RCU per Region sits entirely unclaimed. There is no capacity arithmetic
# here any more — the figures that used to live in this paragraph are gone
# rather than moved, because there is no allocation left to state.
#
# The non-resource outlives the allocation it was written against, for two
# reasons. The allowance is a hard edge rather than a discount: an auto-scaling
# policy would raise capacity above 25 units the first time real load arrived
# and start billing without anyone deciding to — no alarm, no plan diff, no
# review. And the pool is one apply away from being claimed again — the
# standing rule below admits a future batch-shaped table, and *that* is the
# ticket at which a scalable target looks like the obvious fix. Nothing can
# attach to this stack as it stands (Application Auto Scaling manages
# provisioned capacity, and there is none), which makes the absence cheap to
# keep and expensive to notice missing later.
#
# The escape hatch for load an allocation cannot absorb is a `billing_mode`
# flip to PAY_PER_REQUEST — one attribute, no migration, no downtime, allowed up
# to 4 times per 24-hour rolling window, and a table's first switch instantly
# sustains at least 4,000 WCU / 12,000 RCU. That, not auto-scaling, is the
# answer when the throttle alarms in alarms.tf fire (ADR 0002 revisit trigger
# 8), and both tables that were ever provisioned have now taken it, for the
# same reason: `weather` (#156, 2026-08-03) and `series` (#258, 2026-08-09).
#
# The standing rule that keeps the shared regional pool from being renegotiated
# per ticket: **a new table defaults to on-demand unless its load is
# batch-shaped** — driven by a clock, with a volume the ADR can compute. Only a
# ticket adding another clock-driven batch table touches the 25/25 pool, and it
# arrives with an arithmetic argument rather than an estimate — an argument
# about burst as well as rate, since what unseated both tables that ever took
# the rule up was the size of one `BatchWriteItem` page against the retry
# patience behind it, not the units per cycle (see 2 and 3 below). Two for two
# is not yet a repeal of the rule, but a third batch-shaped table has to answer
# it: a computable per-cycle volume is necessary and, on this evidence, not
# sufficient.
# ---------------------------------------------------------------------------
#
# RESTATEMENT LEDGER. This header owns the stack's capacity posture — since
# #258, nothing here draws on the Region's 25/25 — and each table's section
# below owns that table's own metered arithmetic. Two infra/README.md sites
# restate those wholesale and move with them: the `Runbook: the storage stack`
# section's B3 readback (now one `BillingModeSummary` query per batch-written
# table, both expecting `PAY_PER_REQUEST`) and the whole `### Storage stack`
# section under `Cost` — its capacity rows and the notes below them both carry
# figures.
#
# A third class of carrier is deliberately **not** enumerated here: driver rows.
# infra/README.md's cost convention 3 already requires every stack that drives
# another stack's meter to carry the driven figure on its own row (`$0.00/mo
# here; drives ≈ $X/mo under storage`), and the idle-cost censuses in
# infra/forecast/outputs.tf and infra/ingestion/outputs.tf say the same thing in
# Terraform for the same reason. Those carriers are owned by that convention,
# which finds them all by rule; a list here would name whichever ones existed
# the day it was written and go stale the first time a stack is added — the
# precise failure a ledger exists to prevent. So: change a billing mode or a
# metered estimate, and the two sites above move in the same commit, together
# with every driver row convention 3 requires. Every remaining mention in the
# repo points here without a number, with two named prose exceptions (ADRs are
# a third, exempt as immutable): infra/README.md's ingestion teardown paragraph
# and its "a forgotten stack is nearly free" cost note both carry the ≈ $0.30
# and ≈ $1.48 estimates, and move with them.
#
# The `series` section below also owns the per-dashboard-load read arithmetic:
# #264 doubled it by giving a load a second fleet fan-out, and ADR 0002's
# figure is amended (2026-08-10) rather than current. That section states the
# numbers; this paragraph carries none of its own. Its carriers:
# infra/README.md's `### Storage stack` series row (already enumerated above),
# the `Dashboard` docblock in apps/web/src/dashboard/Dashboard.tsx, the
# `listSites` docblock in apps/web/src/data/fleet-data-source.ts, the
# `POLL_INTERVAL_MS` docblock in apps/web/src/data/use-first-forecast.ts and
# the fleet-vs-poll comment in apps/web/src/data/use-first-forecast.test.tsx.
# So: change the per-load read arithmetic, and those five sites move in the
# same commit.
#
# Settings common to all of them, each one an idle-billing decision (ADR 0002,
# "Table settings"), stated once here rather than repeated per table:
#
#   * point_in_time_recovery off — $0.22/GB-month to protect data the owner has
#     decided is disposable. Every stored fact is refetchable from Open-Meteo or
#     recomputable by a pure model function.
#   * deletion_protection_enabled = false — clean `terraform destroy` is a
#     project requirement that this stack has to exercise, not document.
#   * No `server_side_encryption` block — the omission selects the AWS-owned
#     key, which is encryption at rest at no charge. A customer-managed KMS key
#     would add ~$1/month plus per-request charges for no compliance benefit.
#   * No `stream_enabled` — DynamoDB Streams would be a second event source to
#     bill for and a second trigger surface. ADR 0004 ("DynamoDB Streams stay
#     off") re-argued the omission after the transport moved to SQS: a
#     stream-as-transport would couple the forecast trigger to the storage item
#     shape and fire on archive-cache writes that must not trigger live
#     forecasting.
#   * table_class STANDARD — Standard-IA trades request price for storage price,
#     and storage is free at this volume.
#
# Only key attributes are declared in `attribute` blocks: DynamoDB is schemaless
# for everything else, and the domain fields are owned by the zod schemas in
# @cumulo/shared (ADR 0002, architecture rule 2). No key attribute is ever a
# schema field, and no schema field is declared here.

# 1. Sites — the control plane. One partition (`FLEET`) holding the whole fleet,
#    so "list every site" (A2) and "enumerate active locations" (I1) are single
#    Queries rather than Scans. Bounded by #29's site cap, which is a business
#    rule that already exists.
#
#    ON-DEMAND, permanently. Its load is request-shaped — CRUD from whoever is
#    looking, plus #29's abuse surface — so there is no volume to size against.
#    Keeping it out of the provisioned pool also keeps *both* GSIs out: a GSI
#    consumes capacity from its own pool on every projected-attribute write, and
#    that is what usually makes provisioned sizing treacherous. No future index
#    on this table can ever draw on the free 25/25.
resource "aws_dynamodb_table" "sites" {
  name         = "cumulo-sites-${var.environment}"
  billing_mode = "PAY_PER_REQUEST"
  table_class  = "STANDARD"

  hash_key  = "pk"
  range_key = "siteId"

  attribute {
    name = "pk"
    type = "S"
  }

  attribute {
    name = "siteId"
    type = "S"
  }

  attribute {
    name = "gsiLocation"
    type = "S"
  }

  attribute {
    name = "gsiUserSites"
    type = "S"
  }

  attribute {
    name = "gsiCreatedAt"
    type = "S"
  }

  # F1: on a queue message for location L (ADR 0004's SQS transport), read the
  # physics parameters of every active site at L. Sparse by construction — the
  # adapter writes `gsiLocation` only while a site is active, so an inactive
  # site is structurally absent from the index the forecast service reads,
  # rather than filtered out by code that a later change could forget.
  #
  # INCLUDE rather than ALL: the projection is exactly the physics parameters
  # the forecast service needs, so the index stays small and a name change on
  # the base item does not amplify writes into it. The projected set is mirrored
  # by `siteSchema.omit({ name: true })` in the adapter — keep the two in step.
  #
  # `key_schema` blocks rather than the index-level `hash_key`/`range_key`
  # arguments: the provider deprecated those two *inside*
  # `global_secondary_index` in favour of this form, and `terraform validate`
  # says so. (The table-level `hash_key`/`range_key` above are not deprecated —
  # only the index-level pair is.) HASH is listed first because that is the
  # order DynamoDB's KeySchema takes.
  global_secondary_index {
    name = "by-location"

    key_schema {
      attribute_name = "gsiLocation"
      key_type       = "HASH"
    }

    key_schema {
      attribute_name = "siteId"
      key_type       = "RANGE"
    }

    projection_type = "INCLUDE"
    non_key_attributes = [
      "latitude",
      "longitude",
      "tiltDegrees",
      "azimuthDegrees",
      "capacityKw",
    ]
  }

  # X1/X2: count user-generated sites, and find the oldest one for eviction.
  # Sparse on `origin = user`: the adapter writes neither attribute for seed
  # sites, so #29's "never evict a seed site" is a property of the data model
  # instead of a WHERE clause. KEYS_ONLY because eviction needs an id, not a
  # site — the full item is one GetItem away if it turns out to want one.
  global_secondary_index {
    name = "user-sites-by-age"

    key_schema {
      attribute_name = "gsiUserSites"
      key_type       = "HASH"
    }

    key_schema {
      attribute_name = "gsiCreatedAt"
      key_type       = "RANGE"
    }

    projection_type = "KEYS_ONLY"
  }

  # No TTL: a site's lifetime is #29's eviction rule, not a clock.

  point_in_time_recovery {
    enabled = false
  }

  deletion_protection_enabled = false
}

# 2. Series — per-site time series: forecasts (physics and ML) and generation
#    actuals, interleaved by valid time so "forecast and actual over a range"
#    (A4) is one Query.
#
#    ON-DEMAND since #258 (ADR 0002, Amendments 2026-08-09); provisioned at
#    14 WCU / 21 RCU before that. The load is still batch-shaped and the ADR's
#    sustained arithmetic still holds — 4,850 write units per cycle, draining in
#    ~347 s of 3,600 at the old allocation — but what moved this table is burst
#    shape, not rate: the same cause as 3 below, arriving on the other side of
#    the queue. One message is one `putForecasts` call (`batch_size = 1`, so a
#    record is a batch) carrying every site at that location across the whole
#    48-hour horizon — **~240 items, ~240 write units, from a single message** —
#    which `drainBatches` drains as ~10 *sequential* `BatchWriteItem` pages of
#    25. At 14 WCU/s that one message is ~17 s of accumulation arriving in under
#    a second, and `maximum_concurrency = 2` puts two of them there at once.
#    The retry budget behind each page is bounded and small (`drainBatches`
#    3 sends, SDK 2 attempts, jittered), so once the burst credit is gone a page
#    cannot be funded before patience runs out — and no WCU number the free pool
#    could have afforded closes that gap, it only moves the fleet size at which
#    the cliff appears. Confirmed live on 2026-08-05, minutes
#    after #156 removed the upstream pacing that had been masking it: ~650
#    WriteThrottleEvents across two colliding cycles (300 of them in the one
#    minute that tripped the alarm), 12 of 24 forecast messages failing on first
#    delivery — and that at *half* the item count above, since only the physics
#    producer exists today and the ~240 prices both model variants. Nothing was
#    lost — SQS redelivered every one of them, and the last landed on its third
#    receive — but the thing absorbing the cliff was redelivery patience rather
#    than capacity, and the alarm mailed on every occurrence (#258).
#
#    Cost is activity-shaped rather than standing: ~2.10 M write units/month at
#    the canonical 12-location fleet (~2,880 items per cycle, the figure the
#    forecast stack's cost table carries) ≈ $1.48/month, ≈ $2.50 at ADR 0002's
#    ~50-site planning envelope of 4,850 units per cycle, ≈ $4.99 at #29's
#    100-site cap, and $0 while the schedule is idle. Reads are activity-shaped
#    for the same reason and stay negligible: the dashboard read path the
#    21 RCU was sized against now costs **≈ 52 a load** at $0.1415/M — ~50
#    read units per load on this table and ~2 elsewhere. The ~50 is ~25 covering
#    every site's partition for the fleet's forecasts and ~25 again for its
#    simulated actuals, since #264 gave the fleet a measured half and #296
#    put both behind their own API route, where the per-site Queries are now
#    issued server-side. (The load's remaining ~2 units are one Query over the
#    `FLEET` partition on `sites`, not this table.) This paragraph owns the
#    per-load figure — ADR 0002's ≈ 27 was honest until #264 gave a load its
#    second `series` read, and is amended (2026-08-10) rather than current;
#    every carrier is named in this file's header ledger. So the loads it
#    takes to spend a cent still number in the thousands, and the bound on a
#    determined caller is ADR 0005's gateway throttle rather than a read
#    allocation — which is what the 21 RCU had become in practice anyway.
#
#    There is deliberately no `on_demand_throughput` block, for the same reason
#    3 below states: a `max_write_request_units` ceiling is a per-second cap, so
#    a 25-item page can outrun it exactly as it outran 14 WCU/s, and the ceiling
#    would reintroduce the throttle class this flip exists to remove on a table
#    whose whole month costs a dollar or two. The backstop against runaway spend
#    is the account-wide budget alarm in infra/bootstrap/budget.tf, which watches
#    money rather than throughput and therefore cannot drop a write.
#    (Restatement ledger: this file's header.)
resource "aws_dynamodb_table" "series" {
  name         = "cumulo-series-${var.environment}"
  billing_mode = "PAY_PER_REQUEST"
  table_class  = "STANDARD"

  hash_key  = "siteId"
  range_key = "sk"

  attribute {
    name = "siteId"
    type = "S"
  }

  attribute {
    name = "sk"
    type = "S"
  }

  # No GSI. The one heterogeneous item collection in the whole access-pattern
  # inventory is served by this table's own sort key, so there is no index here
  # to amplify the hourly write path.

  # 90-day retention on live series, as an attribute rather than as machinery.
  # The adapter writes `expiresAt` (epoch seconds) = validTime + 90 days.
  # Deletes are free and asynchronous — TTL is not a guaranteed-punctual clock,
  # so nothing may depend on an expired item being gone at a particular moment.
  #
  # The attribute name below is owned jointly with `TTL_ATTRIBUTE_NAME` in
  # `packages/storage/src/ttl.ts`, which every writer of an expiring item
  # derives its key from; per architecture rule 8 the pair is declared to
  # `check:infra-mirrors`, so renaming one side fails `verify` rather than
  # leaving items that never expire.
  ttl {
    attribute_name = "expiresAt"
    enabled        = true
  }

  point_in_time_recovery {
    enabled = false
  }

  deletion_protection_enabled = false
}

# 3. Weather — per-location weather readings, partitioned by the ~1.1 km
#    `locationId` that is simultaneously ingestion's de-duplication key (one
#    pure function in @cumulo/shared, so the two cannot drift). Holds both
#    90-day-expiring FORECAST items and permanently retained ARCHIVE items,
#    plus one `ARCHIVE#DAY#<date>` marker per fetched day — the exact cache-hit
#    test that keeps Open-Meteo quota from being spent twice (H2).
#
#    ON-DEMAND since #156 (ADR 0002, Amendments 2026-08-03); provisioned at
#    5 WCU / 3 RCU before that. The load is still batch-shaped and the ADR's
#    sustained arithmetic still holds — 1,440 write units per cycle, draining in
#    ~288 s of 3,600 — but what moved this table is burst shape, not rate.
#    Ingestion writes each location's 48-hour horizon as two `BatchWriteItem`
#    pages of ≤25 items; one page needs 5 s of accumulation at 5 WCU/s, while
#    the bounded retry budget behind it (`drainBatches` 3 sends, SDK 2 attempts)
#    spends itself in under ~2 s. Once the burst credit is gone the page cannot
#    be funded before patience runs out, and no WCU number the free pool could
#    have afforded closes that gap — it only moves the location count at which
#    the cliff appears. Confirmed live twice: 296 WriteThrottleEvents with 6 of
#    12 locations losing their weather on the seeded demo fleet (2026-08-03,
#    #156), after 1,350 throttles at the 40-location worst case (E7-a).
#
#    Cost is activity-shaped rather than standing: ~0.42 M write units/month at
#    the canonical 12-location hourly fleet ≈ $0.30/month, ≈ $1.28 at the
#    52-location worst case, and $0 while the schedule is idle. Reads stay
#    negligible for the reason the 3 RCU was chosen — every read path is
#    offline: #16's hindcast reads a date range, and #12 receives weather on the
#    SQS queue rather than reading it back. Nothing on this table's read
#    path sits in front of a user.
#
#    There is deliberately no `on_demand_throughput` block. Its
#    `max_write_request_units` ceiling is a per-second cap, so a 25-item page
#    can outrun it exactly as it outran 5 WCU/s — the ceiling would reintroduce
#    the throttle class this flip exists to remove, on a table whose whole month
#    costs cents. The backstop against runaway spend is the account-wide budget
#    alarm in infra/bootstrap/budget.tf, which watches money rather than
#    throughput and therefore cannot drop a write.
resource "aws_dynamodb_table" "weather" {
  name         = "cumulo-weather-${var.environment}"
  billing_mode = "PAY_PER_REQUEST"
  table_class  = "STANDARD"

  hash_key  = "locationId"
  range_key = "sk"

  attribute {
    name = "locationId"
    type = "S"
  }

  attribute {
    name = "sk"
    type = "S"
  }

  # TTL is per item, which is what lets one table hold both retention policies:
  # the adapter sets `expiresAt` on FORECAST items only. ARCHIVE readings and
  # their day markers carry no `expiresAt` and therefore never expire — an
  # archive item that vanished would silently re-spend Open-Meteo quota, and a
  # marker that vanished before its readings would be worse.
  #
  # The attribute name below is the same declared mirror of `TTL_ATTRIBUTE_NAME`
  # in `packages/storage/src/ttl.ts` that the `series` table carries, checked
  # per table by `check:infra-mirrors` (rule 8) — a rename here alone reds the
  # gate on this address.
  ttl {
    attribute_name = "expiresAt"
    enabled        = true
  }

  point_in_time_recovery {
    enabled = false
  }

  deletion_protection_enabled = false
}

# 4. Metrics — evaluation results per site, period, model, and named baseline.
#    Period before model in the sort key is what makes #20's side-by-side
#    comparison one Query rather than two.
#
#    ON-DEMAND: written a handful of times per hindcast run and read by whoever
#    opens the comparison view. Request-shaped, tiny, and not worth a slice of
#    the regional pool. No TTL — metrics are the evidence #20 has to publish.
resource "aws_dynamodb_table" "metrics" {
  name         = "cumulo-metrics-${var.environment}"
  billing_mode = "PAY_PER_REQUEST"
  table_class  = "STANDARD"

  hash_key  = "siteId"
  range_key = "sk"

  attribute {
    name = "siteId"
    type = "S"
  }

  attribute {
    name = "sk"
    type = "S"
  }

  point_in_time_recovery {
    enabled = false
  }

  deletion_protection_enabled = false
}

# 5. Abuse — #29's per-IP request limiter state. Two row kinds share one hash
#    key `pk`: `RATE#<ip>#<windowStart>` counts one address's requests in one
#    fixed window, and `BLOCK#<ip>` records an address blocked until an instant.
#    There is no sort key because nothing ever asks for a range of this data —
#    every access is one exact address and one exact window or block.
#
#    This table exists because the API is anonymous and an HTTP API gives us no
#    other lever: usage plans and API keys are a REST-API feature, and WAF
#    cannot associate with an HTTP API at all (REST/ALB/CloudFront only). So
#    per-address limiting is application state, and this is where it lives.
#
#    ON-DEMAND, by the standing rule at the top of this file: its load is
#    request-shaped — one write per limited request from whoever is knocking —
#    so there is no volume to size a provisioned number against. It was the
#    rule working from the start rather than in hindsight: it never drew on the
#    shared free 25/25 pool, which since #258 no table in this stack does.
#    Under abuse the request rate is bounded by the gateway throttles in
#    `infra/api/gateway.tf` rather than by anything here.
#
#    Every row carries `expiresAt`, so stored size stays at roughly "addresses
#    seen in the last few minutes" and storage is free. TTL deletion is
#    asynchronous and not punctual, which is why the adapter compares
#    `blockedUntil` to a clock instead of treating a surviving row as a live
#    block (`packages/storage/src/adapters/abuse/abuse-adapter.ts`).
resource "aws_dynamodb_table" "abuse" {
  name         = "cumulo-abuse-${var.environment}"
  billing_mode = "PAY_PER_REQUEST"
  table_class  = "STANDARD"

  hash_key = "pk"

  attribute {
    name = "pk"
    type = "S"
  }

  # Third instance of the same declared mirror: the attribute name below and
  # `TTL_ATTRIBUTE_NAME` in `packages/storage/src/ttl.ts`, which the limiter's
  # adapter writes every row's expiry under. Declared to `check:infra-mirrors`
  # per architecture rule 8, so a rename cannot land on one side only.
  ttl {
    attribute_name = "expiresAt"
    enabled        = true
  }

  point_in_time_recovery {
    enabled = false
  }

  deletion_protection_enabled = false
}
