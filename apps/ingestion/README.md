# `@cumulo/ingestion`

The hourly weather cycle: read the fleet, collapse it to the locations that actually need weather,
fetch each one from Open-Meteo, store the readings in `cumulo-weather`, and publish one message per
location for the forecast service (ADR 0004).

## The cycle

| Module                           | Responsibility                                                                                |
| -------------------------------- | --------------------------------------------------------------------------------------------- |
| `open-meteo/url.ts`              | Request construction. Pure — pins `wind_speed_unit=ms`, `timezone=UTC`, `forecast_hours=48`.  |
| `open-meteo/response.ts`         | Parses and normalizes a response body into `WeatherReading`s. Pure.                           |
| `open-meteo/fetch-forecast.ts`   | The one module that touches the network, and the only place the failure policy lives.         |
| `locations.ts`                   | De-duplicates active fleet sites into the set of weather locations to fetch.                  |
| `publisher/weather-publisher.ts` | The transport seam: one publish per location-cycle, implementation-agnostic.                  |
| `publisher/sqs.ts`               | The SQS implementation of that seam (ADR 0004), and the message body's contract.              |
| `cycle.ts`                       | Orchestration: per location, fetch → **store** → **publish**, in that order.                  |
| `handler.ts`                     | The Lambda boundary: structured logs, and a failed cycle that fails the invocation.           |
| `main.ts`                        | The composition root: parses the environment, binds the policies, exports `handler`.          |
| `thrown-detail.ts`               | One rendering of an unknown thrown value, shared by the adapter and the cycle.                |
| `zod-issue-detail.ts`            | One rendering of a zod parse failure, shared by the response parser and the composition root. |

Two orderings in `cycle.ts` are correctness properties rather than style:

- **Store before publish, and never publish a partial store.** `cumulo-weather` is the durable
  record; the published message is a trigger that happens to carry a copy (ADR 0004). DynamoDB's
  `BatchWriteItem` answers HTTP 200 while handing back items it declined, so a batch that did not
  fully drain leaves its location unpublished and reported as `store-partial`.
- **Failures are per location.** A rate limit, a malformed body or a thrown adapter error is
  converted into that location's outcome and nothing else — the other locations in the cycle still
  publish. A cycle that ends with any location unpublished then throws `CycleFailedError`, so a
  partial run is a failed Lambda invocation rather than a silent success.

## Configuration

`main.ts` parses `process.env` through a zod schema at module scope, so a wrong deployment fails
during initialization rather than mid-cycle.

| Variable     | Purpose                                                                |
| ------------ | ---------------------------------------------------------------------- |
| `CUMULO_ENV` | Environment suffix of the DynamoDB table names (`cumulo-sites-<env>`). |
| `QUEUE_URL`  | Full URL of `cumulo-weather-readings-<env>`, the queue of ADR 0004.    |

`AWS_REGION` is not listed because Lambda always sets it and the SDK reads it directly — naming it
again here would be one more place for the queue's region and the client's to disagree.

## Build

```sh
pnpm --filter @cumulo/ingestion build   # → dist/main.mjs, dist/handler.zip
```

The zip is the artifact ingestion's Terraform uploads; the Lambda handler string is `main.handler`.

Three choices in that one-line script are load-bearing:

- **The AWS SDK is bundled, not `--external`.** The Lambda Node.js runtime ships its own SDK
  version and changes it without notice, so an externalised SDK makes the deployed behaviour a
  function of when the function was invoked. Bundling costs ~1.4 MB and buys version determinism.
- **`--main-fields=module,main`.** The SDK packages have no `exports` map, and esbuild's
  `--platform=node` default prefers `main` — the CommonJS build, whose `require("node:https")`
  becomes a dynamic require that an ESM bundle cannot satisfy, so the artifact throws on import.
  Preferring `module` bundles the SDK's own ESM build instead: no `require` shim banner, and a
  smaller bundle. The check is `node --input-type=module -e "await import('./dist/main.mjs')"` from
  `dist/`, which must load with the variables above set and fail with the zod message without them.
- **`rm -rf dist` first.** `zip` appends to an existing archive, so a stale `main.mjs` would
  otherwise survive into the next artifact.

## Open-Meteo call budget

CLAUDE.md's frugality constraint is "only ever fetch weather for locations where active fleet sites
exist", and that is exactly what `activeFetchLocations` computes: inactive sites contribute nothing,
and co-located sites collapse to one fetch keyed by the `locationId` bucket the readings are stored
under. For the canonical demo fleet — 60 sites in 12 clusters — that is **12 calls per cycle instead
of 60**, and since #78 the 12 is structural rather than incidental: cluster centres sit at the centre
of their `locationId` bucket and the jitter half-width is strictly less than half a bucket, so no
site can round into a neighbour's bucket (`docs/design/fleet-simulation.md`).

At the hourly cadence, against the free tier's 10,000 calls/day, 5,000/hour and 600/minute:

| Window              | Free-tier limit | De-duplicated (12 locations) | Worst case, no de-dup (60) |
| ------------------- | --------------- | ---------------------------- | -------------------------- |
| Per cycle           | —               | 12                           | 60                         |
| Per hour (1 cycle)  | 5,000           | 12 — **0.24%**               | 60 — **1.2%**              |
| Per day (24 cycles) | 10,000          | 288 — **2.9%**               | 1,440 — **14.4%**          |
| Per minute (burst)  | 600             | 12 — **2.0%**                | 60 — **10%**               |

Every figure is inside every limit, including the worst case in which de-duplication achieves
nothing at all. The per-minute row is deliberately pessimistic: `runCycle` issues its fetches
sequentially, so a cycle's calls are spread across its own duration, and the row assumes instead
that all of them land in the same minute.

The headroom is the point. It leaves room for visitor-added sites at new locations, for the
hindcast archive fetches of #16 drawing on the same daily quota, and for re-running a failed cycle,
without any of those needing a quota conversation.

## Attribution

Weather data by [Open-Meteo.com](https://open-meteo.com/), used under
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
