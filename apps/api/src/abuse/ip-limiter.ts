import type { AbuseAdapter } from '@cumulo/storage';

/**
 * The per-IP request limiter: ADR 0006's layer 1, and the layer that bites first
 * against a single determined caller.
 *
 * The gateway's throttles (layers 2 and 3) bound the *bill* but treat every
 * caller as one queue — one abuser consuming the whole 10 rps 429s everybody
 * else, which is a cost control wearing an abuse control's clothes. This is the
 * abuse control: it counts per address, and an address that goes over is refused
 * without spending anyone else's budget.
 */

/**
 * The abuse policy, as three numbers.
 *
 * They are quoted in three other places — ADR 0006, `apps/api/README.md`'s
 * abuse-protection section, and the live-evidence run on issue #29 — so a change
 * here is a change to all four. That is deliberate: a threshold nobody can find
 * the documentation for is a threshold nobody dares tune.
 *
 * 30 per minute is chosen against what a *human* using the demo does. The
 * add-a-site flow is a handful of requests; a visitor clicking through every
 * site's chart might reach ten. Thirty is comfortably above real use and far
 * below what a script does in its first second, which is the gap a friction
 * threshold wants to sit in. An hour's block is long enough that retrying is
 * pointless and short enough that a NAT'd office sharing one address is not
 * locked out for the day.
 */
export const RATE_WINDOW_SECONDS = 60;
export const MAX_LIMITED_REQUESTS_PER_WINDOW = 30;
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
   * itself blocked is usually refused by this map with no I/O at all. That is
   * the whole point: the abuse table is billed per request, and a caller that
   * has just earned an hour's block is precisely the caller most likely to keep
   * calling. Paying DynamoDB to re-learn the same fact a thousand times is how
   * a defence becomes a bill.
   *
   * It is a cache and not the record: a cold container knows nothing, which is
   * why `check` still reads the table when the map misses. And it stays small
   * by construction — an entry appears only for an address that has already
   * sent 31 requests inside one minute, and the gateway's throttles bound how
   * many distinct addresses can do that (a few thousand at the very most across
   * an hour-long block, of a string and a number each), so there is no eviction
   * policy here and no need for one.
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
   * **Windows are fixed, not sliding, so up to 2× the limit can pass across a
   * boundary** — 30 requests at 11:00:59 and 30 more at 11:01:00 are two full
   * windows and neither trips. Accepted rather than fixed: a sliding window
   * costs a read of every timestamp in the last minute on every request, and
   * this threshold is friction against scripts, not an invariant anyone's
   * correctness rests on. A caller sustaining that rate trips the block on its
   * next window anyway.
   *
   * **Storage failures propagate, so the limiter fails closed**: no `catch`
   * here, and the boundary in `main.ts` turns the throw into a 500. The
   * alternative — treat an unreadable abuse table as "allow" — makes the
   * defence removable by whatever is already breaking DynamoDB, which is
   * exactly the moment it is most wanted. A limited route being unavailable
   * while its state store is down is the honest failure
   * (`docs/standards/error-handling.md` rule 1: this is a violated
   * expectation, not a domain outcome the caller could act on).
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
    // — a counter reaped mid-window silently hands the caller a fresh 30.
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
