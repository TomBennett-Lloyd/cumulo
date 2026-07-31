/**
 * How many sites one tab may add per window at the shipped default.
 *
 * Three is a demo allowance, not a security control: a visitor exploring the
 * map adds one site, maybe compares it with a second and a third, and anything
 * past that inside a minute is a hand on the button rather than someone
 * looking at forecasts.
 */
export const DEFAULT_CREATION_LIMIT = 3;

/** The window the default limit is counted over. */
export const DEFAULT_CREATION_WINDOW_MS = 60_000;

const MS_PER_SECOND = 1000;

/**
 * How long the visitor must wait before the next creation is permitted.
 *
 * Named and exported because it crosses a boundary: the throttle produces it,
 * `AddSiteForm` renders it, and the dashboard passes it between the two. A
 * shape inlined into three signatures would be three shapes that happen to
 * agree today (`typing.md` rule 6).
 */
export interface CreationRefusal {
  /** Always ≥ 1 — a wait rounded down to "0 seconds" would read as "no wait". */
  readonly retryAfterSeconds: number;
}

export interface CreationAllowed {
  readonly kind: 'allowed';
}

export interface CreationRefused extends CreationRefusal {
  readonly kind: 'refused';
}

/**
 * The throttle's answer about one prospective creation.
 *
 * A union rather than a boolean plus an optional number, so "refused" cannot
 * arrive without the wait that makes it actionable (`typing.md` rule 4).
 */
export type CreationDecision = CreationAllowed | CreationRefused;

/**
 * Construction-time knobs. All optional: the defaults are what ships, and a
 * test that supplies none is testing the shipped configuration
 * (`testing.md` rule 7).
 */
export interface CreationThrottleOptions {
  readonly limit?: number;
  readonly windowMs?: number;
  /** Injected clock. Tests move it by hand; nothing here ever sleeps. */
  readonly now?: () => number;
}

/**
 * A sliding-window pacer for site creation, in front of the Open-Meteo budget.
 *
 * **It refuses; it never queues.** Queueing looks kinder and is worse here: a
 * queued creation belongs to a visitor who has already clicked away, and it
 * still spends a weather fetch when it eventually runs. CLAUDE.md's API
 * frugality constraint says only fetch weather for locations where active
 * fleet sites exist — a site nobody stayed to look at fails that test, and the
 * spend is unrecoverable once made. A refusal, in contrast, is visible: the
 * visitor is told what the limit is and when it lifts, and can decide.
 *
 * Budget arithmetic, so the numbers are checkable rather than vibes: three
 * creations per minute per tab, each at worst one new weather location
 * server-side (co-located sites coalesce onto one location — see
 * `docs/design/fleet-simulation.md`, which puts the whole 60-site fleet on 12
 * locations), is 3 calls/minute against Open-Meteo's 600/minute ceiling. The
 * scheduled ingestion cycle it shares that ceiling with spends 12 calls/hour.
 *
 * Scope, stated plainly: this is a **UX-level** pacer, per tab, trivially
 * bypassed by reloading. It exists so the honest visitor sees an honest limit,
 * not to stop a hostile one. Authoritative enforcement is server-side — the
 * Fleet API's error model (#14) and abuse protection (#29).
 *
 * A class rather than a factory closing over its counters (`structure.md`
 * rule 2): `check` and `record` genuinely share the recorded-attempt list and
 * the clock, and `this.` is what makes that visible to a reader holding only
 * one of the two methods.
 */
export class CreationThrottle {
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  /** When each still-counting creation was recorded, oldest first. */
  private recordedAtMs: readonly number[] = [];

  constructor(options: CreationThrottleOptions = {}) {
    this.limit = options.limit ?? DEFAULT_CREATION_LIMIT;
    this.windowMs = options.windowMs ?? DEFAULT_CREATION_WINDOW_MS;
    // Wrapped rather than passed as `Date.now`: a detached method is a lint
    // error here (`structure.md` rule 3) and a `this`-binding hazard generally.
    this.now = options.now ?? (() => Date.now());

    // A throttle that permits nothing, or counts over no time, is a caller bug
    // rather than an expected failure — so it throws at construction instead of
    // returning a refusal that no wait could ever lift (`error-handling.md`
    // rule 1). It also keeps `check` total: with a limit of at least one, a
    // refusal always has at least one recorded attempt to expire.
    if (!Number.isInteger(this.limit) || this.limit < 1) {
      throw new Error(`CreationThrottle needs a limit of at least 1, got ${String(this.limit)}`);
    }
    if (!(this.windowMs > 0)) {
      throw new Error(`CreationThrottle needs a positive window, got ${String(this.windowMs)}ms`);
    }
  }

  /**
   * Whether one more creation may be attempted right now.
   *
   * Read-only from the caller's point of view: asking does not consume the
   * allowance, so a refused visitor who waits and asks again is not pushed
   * further back by having asked. {@link record} is what spends it.
   */
  check(): CreationDecision {
    const nowMs = this.now();
    // Attempts that have aged out stop counting — this is what makes the
    // window slide rather than reset in blocks.
    this.recordedAtMs = this.recordedAtMs.filter((atMs) => nowMs - atMs < this.windowMs);

    if (this.recordedAtMs.length < this.limit) {
      return { kind: 'allowed' };
    }

    // Non-empty by construction: reaching here needs `length >= limit >= 1`.
    const earliestExpiryMs = Math.min(...this.recordedAtMs.map((atMs) => atMs + this.windowMs));
    return {
      kind: 'refused',
      retryAfterSeconds: Math.ceil((earliestExpiryMs - nowMs) / MS_PER_SECOND),
    };
  }

  /**
   * Spends one of the window's creations.
   *
   * Separate from {@link check} because the two answer different moments: the
   * check gates a click, and the record marks the attempt that the click
   * actually sent. Recording inside `check` would charge the visitor for a
   * creation the form refused on its own (invalid tilt, say) and never sent.
   * The consequence is a caller obligation — a caller that checks and never
   * records has a throttle that never throttles — and it is why the dashboard
   * records at the point it calls `createSite`, not at the point it validates.
   */
  record(): void {
    this.recordedAtMs = [...this.recordedAtMs, this.now()];
  }
}
