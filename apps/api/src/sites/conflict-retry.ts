import { fullJitterDelayMs } from '@cumulo/storage';

/**
 * The retry policy for a transaction DynamoDB cancelled because it collided with
 * another in-flight transaction on the same row — the fleet counter item at
 * (`FLEET`, `#META#counters`), in practice, which every capped create and every
 * counted delete writes.
 *
 * One module rather than a constant in each route, because the two write routes
 * that touch that counter are contending with *each other*: a create backing off
 * on one curve while a delete backs off on another is two halves of one policy,
 * and the pair only makes sense stated once (`docs/standards/error-handling.md`
 * rule 3 — the failure policy is visible, and here it is visible in one place).
 *
 * The adapter never retries these itself: ADR 0002 assigns the retry to a
 * deliberate owner, and the SDK gives neither `TransactionCanceledException` nor
 * `TransactionConflictException` a retry of its own. The owner is the route
 * handler, and this is what it retries with.
 */

/**
 * How many concurrent transactions may be writing the fleet counter at once —
 * **10** — and so the premise every number below rests on.
 *
 * Derived, not assumed, from the two layers that bound it:
 *
 * - **The gateway write throttle.** `infra/api/gateway.tf` gives each of the
 *   three write route keys its own `route_settings` bucket at
 *   `throttling_rate_limit = 2` / `throttling_burst_limit = 4`. Two of those
 *   three routes write the counter — `POST /v1/sites` through
 *   `createUserSiteWithCap` and `DELETE /v1/sites/{siteId}` through
 *   `deleteUserSiteWithCount`; `PUT` writes a site row with a plain `PutItem`
 *   and never touches the counter. A full bucket plus one second of refill is
 *   4 + 2 = 6 per route, so the two counter-writing routes together admit **12**
 *   in a second. (`evictAndCreateUserSite` deliberately leaves the counter
 *   alone, so an eviction contends on site rows rather than adding to this
 *   count.)
 * - **Account Lambda concurrency, which binds first.** The API function
 *   declares no `reserved_concurrent_executions`, so it draws on the account
 *   limit of 10 measured in #29 (`aws lambda get-account-settings`, recorded in
 *   `infra/ingestion/alarms.tf`). Requests beyond it are refused at Lambda —
 *   #29's E3 burst saw 29 × 503 and zero 429s at 40-way parallelism — so they
 *   never reach DynamoDB and never contend. At most 10 invocations run at once,
 *   and the worst case for this policy is that every one of them is a
 *   counter-writing write route.
 *
 * `min(12, 10) = 10`. #29's E2 attempt-2 fired 6 parallel POSTs per round and
 * saw the contention this policy exists for (8 × 500 across 66 requests); 6 was
 * that harness's chosen parallelism rather than a ceiling, and the ceiling above
 * is higher because the DELETE route's bucket is a second, independent one.
 *
 * Not exported: it is the input to the two budgets below, and a caller that
 * wanted it would be re-deriving a budget rather than using one.
 */
const CONCURRENT_COUNTER_WRITERS = 10;

/**
 * How many times a request may sleep and re-issue a transaction the counter's
 * contention cancelled: **9**.
 *
 * Every round of contention has at least one winner — DynamoDB cancels the
 * losers of a conflict, not all participants — so among
 * {@link CONCURRENT_COUNTER_WRITERS} contenders a single request can lose at
 * most `10 − 1` rounds before its turn comes. That is the whole derivation:
 * 9 retries is the count at which losing every remaining race is no longer a
 * possible explanation for failing, so exhausting this budget means something
 * other than contention is wrong — which is exactly what makes the exhaustion
 * log line worth reading.
 *
 * Bounded rather than unbounded because these routes are unauthenticated: a
 * public write path that can spin holds a Lambda slot out of a pool of 10.
 * Worst case, a request that loses all 9 sleeps 50 + 100 + 200 + 400 × 6 =
 * **2,750 ms** in total (the caps below, summed; full jitter makes the expected
 * total half that). `apps/api/src/request-budget.ts` prices that against the
 * function timeout and says plainly where the sum still does not fit.
 */
export const MAX_CONFLICT_RETRIES = CONCURRENT_COUNTER_WRITERS - 1;

/**
 * The first retry's ceiling: **50 ms**, the order of one DynamoDB transaction
 * round trip.
 *
 * A conflict is not a throttle. The loser does not need capacity to free up, it
 * needs to arrive after the winner commits — so the first sleep is sized to a
 * commit, not to a recovery. Backing off in seconds here would turn a
 * millisecond-scale race into a user-visible pause for no gain.
 */
export const CONFLICT_RETRY_BASE_DELAY_MS = 50;

/**
 * The ceiling the doubling stops at: **400 ms**.
 *
 * Reached at the fourth retry (50 → 100 → 200 → 400) and held for the rest. It
 * stops there because the sleeps are spent inside a 15-second function timeout
 * that a request must answer within: a curve that kept doubling would spend more
 * of that budget waiting than the remaining attempts could ever use, and a
 * request killed at the timeout does not reach the error boundary at all — the
 * caller gets a gateway 502 with a body that is not an `ApiError`.
 *
 * 400 ms is also wide enough to be a *spread*: full jitter over
 * [0, 400) separates 10 contenders by ~40 ms on average, comfortably more than
 * the transaction round trip they are queueing behind.
 */
export const CONFLICT_RETRY_MAX_DELAY_MS = 400;

/**
 * How long to sleep before retry number `retryAttempt` (1-based: 1 is the first
 * retry, so its ceiling is exactly {@link CONFLICT_RETRY_BASE_DELAY_MS}).
 *
 * The curve itself is `@cumulo/storage`'s `fullJitterDelayMs` rather than a
 * fourth copy of the same arithmetic — this module supplies the two numbers that
 * are a decision of this API's, and nothing else. `random` is a parameter rather
 * than a default so the delay is a pure function of its inputs and the route's
 * test can assert the sequence it actually slept.
 */
export const conflictRetryDelayMs = (retryAttempt: number, random: () => number): number =>
  fullJitterDelayMs(retryAttempt, {
    baseDelayMs: CONFLICT_RETRY_BASE_DELAY_MS,
    maxDelayMs: CONFLICT_RETRY_MAX_DELAY_MS,
    random,
  });
