import {
  DYNAMODB_BATCH_WRITE_SIZE,
  STORAGE_MAX_ATTEMPTS,
  STORAGE_REQUEST_TIMEOUT_MS,
  STORAGE_RETRY_BASE_DELAY_MS,
} from '@cumulo/storage';

/**
 * How much work one API invocation may start, priced in DynamoDB requests.
 *
 * The API's counterpart to `apps/ingestion/src/cycle-budget.ts`, and it exists
 * for the same reason: a handler that keeps starting storage work until it runs
 * out of things to do will eventually outlive the function timeout, and a
 * request killed at the timeout does not reach `main.ts`'s error boundary. The
 * caller then gets a gateway 502/504 whose body is not an `apiErrorSchema` one
 * — and on `POST /v1/sites` that is worse than an error, because the 201 body
 * is the only place the caller ever learns the new site's id. A create that
 * committed and then died in cleanup loses the id for good.
 *
 * **What this module does and does not buy.** It bounds the *cleanup*'s
 * contribution to an invocation. It does not make the timeout unreachable the
 * way `CYCLE_DEADLINE_MS` does for ingestion, and claiming otherwise would be
 * arithmetic theatre: three storage round trips is the **best** case of an
 * evicting create before any cleanup starts — the capped create, the oldest-site
 * lookup, the evict-and-create — and `createSite` may retry that trio up to
 * `MAX_STORE_ATTEMPTS` times when it loses a race, so 12 × 3 = **36** round
 * trips is the worst case, ≈ 252 s at {@link DYNAMODB_REQUEST_WORST_MS}, plus
 * the ≤ 3.55 s this route now deliberately *sleeps* between those attempts
 * (`sites/conflict-retry.ts`: eleven backoffs capped at 50, 100, 200, then 400
 * ms). Even the best case exceeds {@link API_LAMBDA_TIMEOUT_MS} on its own.
 * That gap is older than this module and is recorded in `docs/tech-debt.md`
 * ("The API's 15 s timeout and the storage client's retry budget are two
 * unreconciled numbers"), which now names this loop as the write-path half of
 * it — #155 widened the loop's budget from 3 attempts to 12 to absorb the
 * transaction conflicts #29 measured, so these numbers deepen that entry rather
 * than settling it, and #165 owns the reconciliation. What changed in this
 * module is only that the cleanup is no longer the *unbounded* term in the sum.
 */

/**
 * The function timeout in `infra/api/lambda.tf`, mirrored.
 *
 * A mirror, not a source: Terraform owns the deployed value and its comment
 * cites this constant by name, as this one cites the file. The two are held
 * equal by `pnpm check:infra-mirrors` in the `verify` composite, which
 * multiplies the Terraform `timeout` by 1000 and compares
 * (`docs/standards/architecture.md` rule 8 — a comment cannot fail a build, so
 * the pair is declared to the gate rather than merely described here).
 */
export const API_LAMBDA_TIMEOUT_MS = 15_000;

/**
 * The worst case of a **single** DynamoDB request, end to end: every attempt
 * burns its full pinned deadline and the one retry sleeps its full jitter
 * ceiling. 2 × 3,000 ms + 1,000 ms = 7,000 ms.
 *
 * Every term is imported rather than remembered. The `+ STORAGE_RETRY_BASE_DELAY_MS`
 * term is the ceiling of the backoff curve **at the pinned two-attempt budget**
 * and only there: one retry, whose full-jitter ceiling is exactly the base
 * delay. At three attempts the curve doubles and the true ceiling would be
 * 3,000 ms, so `request-budget.test.ts` pins `STORAGE_MAX_ATTEMPTS` to 2 — the
 * assertion fails the build if the budget is raised, which is the intended way
 * to be told this sum needs re-deriving.
 *
 * The general doubling sum already exists as `backoffCeilingMs` in
 * `apps/ingestion/src/cycle-budget.ts`, which `docs/tech-debt.md` records as
 * living in the wrong package (a package cannot import from an app). A third
 * copy here would deepen that entry rather than pay it off, so this module
 * prices the pinned case and guards it instead.
 */
export const DYNAMODB_REQUEST_WORST_MS =
  STORAGE_MAX_ATTEMPTS * STORAGE_REQUEST_TIMEOUT_MS + STORAGE_RETRY_BASE_DELAY_MS;

/**
 * How many DynamoDB requests one series-cleanup pass may make: 15,000 / 7,000 =
 * **2**, floored. Not "2 on average" — 2 is the count whose worst case fits
 * inside the function timeout at all.
 */
const SERIES_CLEANUP_REQUEST_BUDGET = Math.floor(API_LAMBDA_TIMEOUT_MS / DYNAMODB_REQUEST_WORST_MS);

/**
 * How many series rows one cleanup pass may delete: **25**.
 *
 * One of the two requests above is the listing Query, so what is left for
 * deletes is a single `BatchWriteItem` — and a `BatchWriteItem` carries at most
 * {@link DYNAMODB_BATCH_WRITE_SIZE} items. Hence
 * `(2 − 1) × 25 = 25`, and a second batch would price the pass at 21,000 ms
 * against a 15,000 ms timeout.
 *
 * **This is a small number against the problem, and deliberately so.** A site's
 * partition holds one row per hour per model plus one per hour of actuals, kept
 * for the 90-day retention of ADR 0002 — order 2,160 rows per model for a site
 * that has existed that long, and eviction picks the *oldest* user site, which
 * is precisely the one holding the most. A 25-row pass is therefore not "delete
 * the site's series"; it is the prompt half of a job whose slow half is the TTL,
 * and for the demo's real lifecycle — a site added and evicted within a session
 * — it is often the whole job. Deleting the rest inline is not available at any
 * budget: 2,160 deletes is 2,160 write units against a table provisioned at 14,
 * so the honest fix is to stop doing this on the request path at all.
 * `docs/tech-debt.md` carries that as its own entry.
 *
 * The bound shrinks rather than breaks if the function timeout is lowered: at a
 * 7-second timeout the budget is one request, the pass lists and deletes
 * nothing, and the TTL does all of it.
 */
export const SERIES_CLEANUP_MAX_ITEMS =
  Math.max(SERIES_CLEANUP_REQUEST_BUDGET - 1, 0) * DYNAMODB_BATCH_WRITE_SIZE;
