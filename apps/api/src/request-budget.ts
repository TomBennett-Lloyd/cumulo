import { STORAGE_COMMAND_WORST_MS } from '@cumulo/storage';

/**
 * How much work one API invocation may start, priced in storage commands.
 *
 * The API's counterpart to `apps/ingestion/src/cycle-budget.ts`, and it exists
 * for the same reason: a handler that keeps starting storage work until it runs
 * out of things to do will eventually outlive the function timeout, and a
 * request killed at the timeout does not reach `main.ts`'s error boundary —
 * `apps/api/README.md`'s error contract states what the caller gets instead.
 *
 * **The unit.** Every figure here is a multiple of
 * {@link STORAGE_COMMAND_WORST_MS}, which `@cumulo/storage` states about itself
 * and this module imports rather than re-derives (#165: the same number had
 * three derivations and they were free to disagree). It is a **bound, not an
 * expectation**. It answers one question —
 * {@link hasBudgetForStorageCommands}, may this request start another command?
 *
 * **What the deadline buys.** Every request carries a `RequestDeadline`
 * (`http/request-deadline.ts`), and every *looping* term asks it before each
 * command, so none can spin an invocation into the timeout — they stop and
 * answer in schema instead. `apps/api/README.md`'s 504 bullet enumerates the
 * looping terms.
 *
 * **And every admitted unit is bounded by one {@link STORAGE_COMMAND_WORST_MS}
 * of wall clock.** Sequential work meets that by pricing *the next command* —
 * one admission, one command. The fleet fan-out meets it a second way, and
 * `forecast/fleet-series-read.ts` carries that argument. What is still refused
 * is accumulation **in series** behind one admission, the shape ADR 0007
 * retired.
 *
 * **Where it stops.** Each route keeps an ungated straight-line prefix: the
 * limiter's own commands (`IpLimiter.check` spends two on the allowed path,
 * `getBlock` then `incrementRateWindow`), the lookups that decide what the
 * handler does, and the **first** page of any Query — a pagination bound is
 * checked *between* pages, so the first is always issued. Counted from the
 * handlers, each unit at most {@link STORAGE_COMMAND_WORST_MS} of wall clock:
 *
 * - `GET /v1/sites` — **1** (`listFleetSites`; ADR 0002 holds the fleet in one
 *   bounded partition, so one page).
 * - `GET /v1/sites/{siteId}` — **1** (`getFleetSite`).
 * - `GET …/forecast` — **2**: `getFleetSite`, then the first series page.
 * - `GET …/series` — **4**: limiter 2, `getFleetSite`, first series page.
 * - `GET /v1/fleet/actuals` — **4**: limiter 2, `listFleetSites`, then the
 *   fan-out's first batch. The deadline gate sits *between* batches, so the
 *   first one is ungated exactly as a first page is.
 * - `GET /v1/fleet/forecast` — **4** on the roll-up path (limiter 2,
 *   `listFleetSites`, then the first page of the single `#FLEET` Query); **5**
 *   on ADR 0009's fallback, where that Query's first page is followed by the
 *   fan-out's first batch, because the roll-up read is consulted first and only
 *   *then* found wanting, so both first-reads are ungated in the same request.
 *   The fallback comes out at #507 and the prefix returns to 4.
 * - `POST /v1/sites` — **2**: the limiter's. Everything after is admitted per
 *   command. The committed write is the last thing the route does: nothing
 *   follows it, so the 201 and the server-assigned id it carries cannot be lost
 *   to work done after the site exists (ADR 0007).
 * - `PUT /v1/sites/{siteId}` — **4**: limiter 2, then `getFleetSite` and
 *   `putFleetSite`. The read-modify-write is straight-line, so it has no loop
 *   to gate.
 * - `DELETE /v1/sites/{siteId}` — **3** on a user site (limiter 2,
 *   `getFleetSite`), the counted deletes gated after it; **4** on a seed site,
 *   whose single `deleteFleetSite` is a plain `DeleteItem` with no retry loop
 *   of its own to gate.
 * - Any limited route *refusing* a caller — **3**: the two above plus
 *   `putBlock`, and then the 429.
 *
 * **So the timeout is reachable, and this is exactly when.** Not from any loop,
 * and never from a single command. It takes **three independent per-unit worst
 * cases coinciding in one request's ungated prefix** to kill an invocation —
 * `request-budget.test.ts` asserts the arithmetic, and `docs/tech-debt.md`
 * carries the residual.
 *
 * **Restatement ledger (`docs/standards/architecture.md` rule 9).** This header
 * owns the admission invariant — every admitted unit bounded by one
 * {@link STORAGE_COMMAND_WORST_MS} of wall clock, plus the per-route ungated
 * straight-line prefix counted above. These sites carry the claim rather than
 * pointing at it, and move with it in the same commit:
 *
 * - `apps/api/README.md`, the 504 bullet of the error-contract section —
 *   *paraphrasing*: it restates the bound, the fan-out's overlap and the
 *   ungated-prefix residual for API callers.
 * - `apps/api/src/openapi/responses.ts`, the `commonFailures` docblock —
 *   *paraphrasing*: "between admitted units", and the same residual.
 * - `apps/api/src/forecast/fleet-series-read.ts`, the "Why one admission prices
 *   one command" docblock — *arguing*: the batch-costs-its-maximum argument is
 *   about this bound and quotes it to reason from.
 * - `infra/api/lambda.tf`, the header comment above the `timeout` attribute on
 *   `aws_lambda_function.api` — *arguing*: the 504 residual it states turns on a
 *   unit being a bound on wall clock rather than being one command.
 *
 * None of them quotes this header's wording, so the sweep behind this list is
 * shaped around the claim rather than the phrasing (rule 10):
 * `command grep -rnE 'admitted unit|straight-line prefix|STORAGE_COMMAND_WORST_MS|wall clock' apps/api infra/api`,
 * run 2026-08-11. The list is a **floor**, not a census. That sweep also
 * reaches `request-budget.test.ts`, which imports the constant and computes
 * with it rather than restating anything, so it needs no entry.
 */

/**
 * The function timeout in `infra/api/lambda.tf`, mirrored.
 *
 * A mirror, not a source: Terraform owns the deployed value and its comment
 * cites this constant by name, as this one cites the file. The two are held
 * equal by `pnpm check:infra-mirrors` in the `verify` composite
 * (`docs/standards/architecture.md` rule 8).
 *
 * **It stays a plain integer literal on one line**, however tempting it is to
 * write it as an expression of the constants below. The gate's TypeScript
 * reader matches `export const <NAME> = <integer>;` and nothing else — it
 * refuses anything it cannot parse rather than skipping it. The value's
 * *relation* to the gateway ceiling is carried by `request-budget.test.ts`
 * instead, for the reason {@link API_GATEWAY_INTEGRATION_TIMEOUT_MS} states.
 */
export const API_LAMBDA_TIMEOUT_MS = 15_000;

/**
 * API Gateway's hard integration timeout: 30 s, and not ours to move.
 *
 * The ceiling {@link API_LAMBDA_TIMEOUT_MS} was *chosen* against rather than
 * derived from (ADR 0005, cited by `infra/api/lambda.tf`'s own comment).
 * **Terraform** owns the 15 s and sits it below, so that a hung request
 * produces a Lambda timeout log line and an `Errors` data point rather than a
 * gateway 504 with nothing behind it.
 *
 * `check:infra-mirrors` cannot hold that inequality, and
 * `request-budget.test.ts` holds it instead — the test's own case
 * ("sits below the gateway integration ceiling it was chosen against") says
 * why: a record addresses two declared sides, and this ceiling is AWS's, with
 * no declaration in this repo for a record to name.
 */
export const API_GATEWAY_INTEGRATION_TIMEOUT_MS = 30_000;

/**
 * Time held back from every budget for finishing the response: **1 s**.
 *
 * After the last storage command returns there is still work to do — serialise
 * the body, write the boundary's log line, let the runtime send it — and a
 * budget spent to the last millisecond on storage is a budget that dies during
 * that. A chosen value, not a measured one: deliberately generous, and being
 * generous costs only the odd command that would have fitted.
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
