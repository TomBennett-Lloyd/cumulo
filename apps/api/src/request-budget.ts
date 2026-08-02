import { DYNAMODB_BATCH_WRITE_SIZE, STORAGE_COMMAND_WORST_MS } from '@cumulo/storage';

/**
 * How much work one API invocation may start, priced in storage commands.
 *
 * The API's counterpart to `apps/ingestion/src/cycle-budget.ts`, and it exists
 * for the same reason: a handler that keeps starting storage work until it runs
 * out of things to do will eventually outlive the function timeout, and a
 * request killed at the timeout does not reach `main.ts`'s error boundary. The
 * caller then gets a gateway 504 whose body is not an `apiErrorSchema` one —
 * and on `POST /v1/sites` that is worse than an error, because the 201 body is
 * the only place the caller ever learns the new site's id. A create that
 * committed and then died in cleanup loses the id for good.
 *
 * **The unit.** Every figure here is a multiple of
 * {@link STORAGE_COMMAND_WORST_MS} — 7,000 ms, which `@cumulo/storage` states
 * about itself and this module imports rather than re-derives (#165: the same
 * number had three derivations and they were free to disagree). It is a
 * **bound, not an expectation**: a healthy command costs tens of milliseconds,
 * and nothing here predicts a duration. It answers one question —
 * {@link hasBudgetForStorageCommands}, may this request start another command?
 *
 * **What the deadline buys.** Every request carries a `RequestDeadline`
 * (`http/request-deadline.ts`), and every *looping* term now asks it before
 * each command: series pagination, `POST`'s store-and-evict attempts,
 * `DELETE`'s counted deletes, and the series cleanup both write routes end
 * with. None of those can run an invocation into the timeout any more — they
 * stop and answer in schema instead, which is the whole of what the deadline is
 * for.
 *
 * **Where it stops.** Each route keeps an ungated straight-line prefix: the
 * limiter's own commands (`IpLimiter.check` spends two on the allowed path,
 * `getBlock` then `incrementRateWindow`), the lookups that decide what the
 * handler does, and the **first** page of any Query — a pagination bound is
 * checked *between* pages, so the first is always issued. Counted from the
 * handlers, at {@link STORAGE_COMMAND_WORST_MS} each:
 *
 * - `GET /v1/sites` — **1** (`listFleetSites`; ADR 0002 holds the fleet in one
 *   bounded partition, so one page), ≈ 7 s.
 * - `GET /v1/sites/{siteId}` — **1** (`getFleetSite`), ≈ 7 s.
 * - `GET …/forecast` — **2**: `getFleetSite`, then the first series page,
 *   ≈ 14 s.
 * - `GET …/series` — **4**: limiter 2, `getFleetSite`, first series page,
 *   ≈ 28 s.
 * - `POST /v1/sites` — **2**: the limiter's, ≈ 14 s. Everything after is
 *   gated per command, including the up-to-36 commands of the store loop and
 *   the cleanup's two.
 * - `PUT /v1/sites/{siteId}` — **4**: limiter 2, then `getFleetSite` and
 *   `putFleetSite`, ≈ 28 s. The read-modify-write is straight-line, so it has
 *   no loop to gate and is the widest ungated prefix on the API.
 * - `DELETE /v1/sites/{siteId}` — **3** on a user site (limiter 2,
 *   `getFleetSite`), ≈ 21 s, the counted deletes and the cleanup gated after
 *   it; **4** on a seed site, whose single `deleteFleetSite` is a plain
 *   `DeleteItem` with no retry loop of its own to gate, ≈ 28 s.
 * - Any limited route *refusing* a caller — **3**: the two above plus
 *   `putBlock`, and then the 429, ≈ 21 s.
 *
 * **So the timeout is reachable, and this is exactly when.** Not from any loop,
 * and never from a single command: 7,000 ms is comfortably inside
 * {@link API_LAMBDA_TIMEOUT_MS}. Two independent commands both hitting their
 * worst case in the same request come to 14,000 ms and still land, with
 * {@link API_RESPONSE_MARGIN_MS} of the timeout left; the third coincidence is
 * what crosses it, at 21,000 ms. It therefore takes **three independent
 * per-command worst cases coinciding in one request's ungated prefix** to kill
 * an invocation — which only the four-command routes above can even offer —
 * and each of those worst cases is itself two burnt 3,000 ms deadlines plus a
 * full backoff. That is a coincidence this module declines to size a slack
 * against, for the same reason `cycle-budget.ts` declines to size its
 * every-retry-at-once term: multiplying independent tail events together
 * produces a number nobody can act on. It is stated instead of implied, and
 * `docs/tech-debt.md` carries the residual — gating the prefix per command
 * would close it, at the cost of a deadline check in front of the limiter.
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
 *
 * **It stays a plain integer literal on one line**, however tempting it is to
 * write it as an expression of the constants below. The gate's TypeScript
 * reader matches `export const <NAME> = <integer>;` and nothing else — it
 * refuses anything it cannot parse rather than skipping it, so an expression
 * here does not weaken the gate quietly, it stops the build with a non-verdict.
 * The value's *relation* to the gateway ceiling is carried by
 * `request-budget.test.ts` instead, where an inequality can be expressed.
 */
export const API_LAMBDA_TIMEOUT_MS = 15_000;

/**
 * API Gateway's hard integration timeout: 30 s, and not ours to move.
 *
 * The ceiling {@link API_LAMBDA_TIMEOUT_MS} was *chosen* against rather than
 * derived from (ADR 0005, cited by `infra/api/lambda.tf`'s own comment). The
 * ownership chain, end to end: **AWS** owns this 30 s; **Terraform** owns the
 * 15 s and sits it below, so that a hung request produces a Lambda timeout log
 * line and an `Errors` data point rather than a gateway 504 with nothing behind
 * it; the **mirror gate** holds the constant above equal to Terraform; and the
 * **test** holds it under this ceiling.
 *
 * That last link is the one that was missing. `check-infra-mirrors.sh` records
 * this inequality as the half of the number it cannot express — its records are
 * equalities between two files, and one side of this one is a value AWS owns
 * and no file here declares. Restating it as a constant moves it somewhere a
 * test can bite, which closes it without pretending the gate grew a feature.
 */
export const API_GATEWAY_INTEGRATION_TIMEOUT_MS = 30_000;

/**
 * Time held back from every budget for finishing the response: **1 s**.
 *
 * After the last storage command returns there is still work to do — serialise
 * the body, write the boundary's log line, let the runtime send it — and a
 * budget spent to the last millisecond on storage is a budget that dies during
 * that. A chosen value, not a measured one: the work is microseconds, so a
 * second is deliberately generous, and being generous costs only the odd
 * command that would have fitted.
 */
export const API_RESPONSE_MARGIN_MS = 1_000;

/**
 * May this request still start `commandCount` storage commands?
 *
 * The API's shape of `CYCLE_DEADLINE_MS`: a command is started only when its
 * own worst case, plus the margin, still fits in what is left of the
 * invocation. Callers ask before each command (or each page, or each retry) —
 * so a request that is running out stops between commands, where its handler
 * can still answer, rather than mid-command where the platform answers for it.
 *
 * `remainingMs` may legitimately be negative: a deadline that has already
 * passed refuses, which is the same answer as one that is merely too tight.
 * `commandCount` may not — a budget for no commands, or for a fraction of one,
 * describes nothing a caller could mean, so it is a violated invariant and
 * throws (`docs/standards/error-handling.md` rule 1, in the shape
 * `requireUsablePolicy` uses in `@cumulo/storage`).
 */
export const hasBudgetForStorageCommands = (remainingMs: number, commandCount: number): boolean => {
  if (!Number.isInteger(commandCount) || commandCount < 1) {
    throw new Error(
      `hasBudgetForStorageCommands: commandCount must be a positive integer, got ${String(commandCount)}`,
    );
  }

  return remainingMs > commandCount * STORAGE_COMMAND_WORST_MS + API_RESPONSE_MARGIN_MS;
};

/**
 * How many storage commands one series-cleanup pass may make: 15,000 / 7,000 =
 * **2**, floored. Not "2 on average" — 2 is the count whose worst case fits
 * inside the function timeout at all.
 */
const SERIES_CLEANUP_REQUEST_BUDGET = Math.floor(API_LAMBDA_TIMEOUT_MS / STORAGE_COMMAND_WORST_MS);

/**
 * How many series rows one cleanup pass may delete: **25**.
 *
 * One of the two commands above is the listing Query, so what is left for
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
 * 7-second timeout the budget is one command, the pass lists and deletes
 * nothing, and the TTL does all of it.
 */
export const SERIES_CLEANUP_MAX_ITEMS =
  Math.max(SERIES_CLEANUP_REQUEST_BUDGET - 1, 0) * DYNAMODB_BATCH_WRITE_SIZE;
