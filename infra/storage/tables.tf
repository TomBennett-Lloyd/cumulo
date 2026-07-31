# The four DynamoDB tables of ADR 0002 — the whole of Cumulo's persistence.
# There is no relational store; the ADR concluded against its own issue title.
#
# ---------------------------------------------------------------------------
# APPLICATION AUTO SCALING IS DELIBERATELY ABSENT. THIS IS A NON-RESOURCE.
# ---------------------------------------------------------------------------
# This stack contains no Application Auto Scaling scalable target and no
# scaling policy (`appautoscaling_target`, `appautoscaling_policy`) on either
# provisioned table, and adding one is the single quietest way this project's
# cost ceiling fails.
#
# The two resource types are named above without their provider prefix on
# purpose. A grep for the prefixed form across this directory is an acceptance
# check on this stack, and a check that its own explanatory comment trips is a
# check nobody can read; a real resource block always carries the prefix, so
# the grep stays a detector rather than a false positive generator.
#
# `series` (14 WCU / 21 RCU) and `weather` (5 / 3) total 19 WCU / 24 RCU, which
# fits inside DynamoDB's *permanently free* 25 WCU / 25 RCU per Region. That
# allowance is a hard edge, not a discount: an auto-scaling policy would raise
# capacity above 25 units the first time real load arrived and start billing
# without anyone deciding to — no alarm, no plan diff, no review.
#
# The escape hatch for sustained load is a `billing_mode` flip to
# PAY_PER_REQUEST — one attribute, no migration, no downtime, allowed up to 4
# times per 24-hour rolling window, and a table's first switch instantly
# sustains at least 4,000 WCU / 12,000 RCU. That, not auto-scaling, is the
# answer if the throttle alarms in alarms.tf ever fire (ADR 0002 revisit
# trigger 8).
#
# The standing rule that keeps the shared regional pool from being renegotiated
# per ticket: **a new table defaults to on-demand unless its load is
# batch-shaped** — driven by a clock, with a volume the ADR can compute. Only a
# ticket adding another clock-driven batch table touches the 25/25 pool, and it
# arrives with an arithmetic argument rather than an estimate.
# ---------------------------------------------------------------------------
#
# Settings common to all four, each one an idle-billing decision (ADR 0002,
# "Table settings"), stated once here rather than repeated in four comments:
#
#   * point_in_time_recovery off — $0.20/GB-month to protect data the owner has
#     decided is disposable. Every stored fact is refetchable from Open-Meteo or
#     recomputable by a pure model function.
#   * deletion_protection_enabled = false — clean `terraform destroy` is a
#     project requirement that this stack has to exercise, not document.
#   * No `server_side_encryption` block — the omission selects the AWS-owned
#     key, which is encryption at rest at no charge. A customer-managed KMS key
#     would add ~$1/month plus per-request charges for no compliance benefit.
#   * No `stream_enabled` — ADR 0001's transport is Kinesis; DynamoDB Streams
#     would be a second event source to bill for and a second trigger surface.
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

  # F1: on a stream record for location L, read the physics parameters of every
  # active site at L. Sparse by construction — the adapter writes `gsiLocation`
  # only while a site is active, so an inactive site is structurally absent from
  # the index the forecast service reads, rather than filtered out by code that
  # a later change could forget.
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
#    PROVISIONED at 14 WCU / 21 RCU. Batch-shaped load with a volume ADR 0002
#    computes: 4,850 write units per hourly cycle, draining in ~347 s of a
#    3,600 s cycle with zero burst assumed. The 21 RCU carries the dashboard
#    fan-out — ~25 read units per load, so ~50 loads/minute sustained, with the
#    300-second burst reserve absorbing ~250 instantly.
resource "aws_dynamodb_table" "series" {
  name         = "cumulo-series-${var.environment}"
  billing_mode = "PROVISIONED"
  table_class  = "STANDARD"

  write_capacity = 14
  read_capacity  = 21

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
#    PROVISIONED at 5 WCU / 3 RCU. Batch-shaped: 1,440 write units per cycle,
#    draining in ~288 s. 3 RCU because every read path is offline — #16's
#    hindcast reads a date range, and #12 receives weather on the Kinesis stream
#    rather than reading it back. Nothing on this table's read path sits in
#    front of a user.
resource "aws_dynamodb_table" "weather" {
  name         = "cumulo-weather-${var.environment}"
  billing_mode = "PROVISIONED"
  table_class  = "STANDARD"

  write_capacity = 5
  read_capacity  = 3

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
