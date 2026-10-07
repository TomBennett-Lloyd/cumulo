import type { AbuseAdapter } from '@cumulo/storage';

/**
 * The per-IP request limiter: ADR 0006's layer 1, and the layer that bites first
 * against a single determined caller.
 *
 * The gateway's throttles (layers 2 and 3) bound the *bill* but treat every
 * caller as one queue. This is the abuse control: it counts per address, and an
 * address that goes over is refused without spending anyone else's budget.
 */

/**
 * The abuse policy, as three numbers. Restatement ledger, a floor — ADR 0006,
 * ADR 0007 (as-it-stood), `apps/api/README.md`, and `infra/api/gateway.tf`'s
 * write-throttle comment — swept 2026-10-07 with `git grep -nE
 * '(^|[^0-9.$])[0-9]+(-request threshold| (limited-route |serial |aggregate )?requests? ?(/ ?60|per|to a limited|spread)| aggregate requests| table round trips)|\(\*\*[0-9]+\*\*; amended'`.
 * Issue #29's evidence run is not trued.
 *
 * The threshold sits above a dashboard load plus a selection of every seed site
 * inside one window (`ip-limiter.test.ts`) — a repeat view of current data is
 * a 304 this limiter never counts (`cycleCached` in `apps/api/src/main.ts`)
 * — and below what the write-route throttle in `infra/api/gateway.tf` admits in
 * one window, so an address held to that throttle can still be blocked. An
 * hour's block makes retrying pointless without locking a NAT'd office out for
 * the day.
 */
export const RATE_WINDOW_SECONDS = 60;
export const MAX_LIMITED_REQUESTS_PER_WINDOW = 90;
export const BLOCK_SECONDS = 3600;

/**
 * Whether a request may proceed, and — when it may not — how long the caller
 * should wait, which is the whole content of the 429 it will receive.
 */
export type IpDecision =
  { readonly allowed: true } | { readonly allowed: false; readonly retryAfterSeconds: number };

export interface IpLimiterDeps {
  /**
   * The adapter whole rather than its three methods: they carry their client
   * and table name on `this`, so a detached method arrives already broken
   * (`docs/standards/structure.md` rule 3). The `Pick` is the narrowing.
   */
  readonly abuse: Pick<AbuseAdapter, 'incrementRateWindow' | 'getBlock' | 'putBlock'>;
  /** Epoch seconds, injected — the window boundary is behaviour worth testing. */
  readonly nowEpochSeconds: () => number;
}

/**
 * A `retry-after` a client can act on: whole seconds, never below one.
 *
 * Two clocks are in play — this limiter's and the one `AbuseAdapter.getBlock`
 * compares a stored block against — so a block reported as live can still
 * compute a wait of zero or less against *our* instant. `retry-after: 0` reads
 * as "retry immediately", straight back into the block that just refused, and a
 * negative one does not parse at all. Rounding up rather than down for the same
 * reason: a client that returns a fraction of a second early is a client the
 * limiter refuses twice.
 */
const retryAfterFrom = (untilEpochSeconds: number, nowEpochSeconds: number): number =>
  Math.max(1, Math.ceil(untilEpochSeconds - nowEpochSeconds));

/**
 * A class rather than functions over a closure, because the block cache below is
 * state genuinely shared between one instance's calls and `this.` is what makes
 * that visible (`docs/standards/architecture.md` rule 7,
 * `docs/standards/structure.md` rule 2). It extends nothing.
 */
export class IpLimiter {
  private readonly deps: IpLimiterDeps;

  /**
   * Addresses known to be blocked, and until when — a **container-scoped**
   * cache, deliberately not a source of truth.
   *
   * Lambda reuses a warm container across invocations, so an address that got
   * itself blocked is usually refused by this map with no I/O at all.
   *
   * It is a cache and not the record: a cold container knows nothing, which is
   * why `check` still reads the table when the map misses. And it stays small
   * by construction — an entry appears only for an address that has already
   * gone over the threshold inside one window, and the gateway's throttles bound how
   * many distinct addresses can do that, so there is no eviction policy here
   * and no need for one.
   */
  private readonly blockedUntil = new Map<string, number>();

  constructor(deps: IpLimiterDeps) {
    this.deps = deps;
  }

  /**
   * Count one request from an address against the policy, and say whether it may
   * proceed.
   *
   * Three steps, cheapest first: the in-memory cache, then the stored block,
   * then the window counter. Only the last one writes.
   *
   * **Storage failures propagate, so the limiter fails closed**: no `catch`
   * here, and the boundary in `main.ts` turns the throw into a 500.
   */
  async check(ip: string): Promise<IpDecision> {
    const now = this.deps.nowEpochSeconds();

    const cached = this.blockedUntil.get(ip);
    if (cached !== undefined) {
      if (cached > now) {
        return { allowed: false, retryAfterSeconds: retryAfterFrom(cached, now) };
      }
      // Expired: drop it rather than leave the map growing a row per address
      // this container has ever blocked.
      this.blockedUntil.delete(ip);
    }

    const stored = await this.deps.abuse.getBlock(ip);
    if (stored.blocked) {
      this.blockedUntil.set(ip, stored.blockedUntilEpochSeconds);
      return {
        allowed: false,
        retryAfterSeconds: retryAfterFrom(stored.blockedUntilEpochSeconds, now),
      };
    }

    const windowStart = now - (now % RATE_WINDOW_SECONDS);
    // Two windows of slack on the row's TTL, not one: DynamoDB deletes expired
    // rows asynchronously and *early* deletion is the failure that would matter
    // — a counter reaped mid-window silently hands the caller a fresh window.
    const count = await this.deps.abuse.incrementRateWindow(
      ip,
      windowStart,
      windowStart + 2 * RATE_WINDOW_SECONDS,
    );

    if (count > MAX_LIMITED_REQUESTS_PER_WINDOW) {
      const until = now + BLOCK_SECONDS;
      await this.deps.abuse.putBlock(ip, until);
      this.blockedUntil.set(ip, until);
      return { allowed: false, retryAfterSeconds: retryAfterFrom(until, now) };
    }

    return { allowed: true };
  }
}
