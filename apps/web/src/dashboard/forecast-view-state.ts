import type { Forecast } from '@cumulo/shared';

/**
 * Why a first forecast stopped being worth waiting for.
 *
 * - `timeout` — nothing ever went wrong, the forecast simply never appeared
 *   inside the deadline. The site exists; the pipeline is behind.
 * - `error` — the fleet answered, and the answer was a fault.
 *
 * Split because the recourse differs: a timeout is worth waiting out again,
 * a fault usually is not, and the panel says something different for each.
 */
export type ForecastFailureReason = 'timeout' | 'error';

/**
 * What the site detail panel knows about a site's forecast, right now.
 *
 * A discriminated union rather than a bag of optionals (`typing.md` rule 4):
 * `{ forecasts: [], error: undefined, pending: false }` has no meaning, and the
 * panel would have to invent one. Here every arm carries exactly the data its
 * rendering needs and nothing else — `elapsedSeconds` cannot be read on a ready
 * forecast, and `forecasts` cannot be read on a waiting one.
 *
 * The two waits are separate arms because they are separate sentences (#177):
 *
 * - `checking` — this run has no definitive answer yet. It covers a fetch still
 *   in flight *and* every fault seen so far, because a fault says nothing about
 *   whether the forecast exists. Claiming a first forecast is being generated
 *   here would be a false sentence about an established site.
 * - `generating` — the fleet confirmed the forecast is absent, so the
 *   pipeline's first-forecast wait is genuinely what is happening, and
 *   `elapsedSeconds` is worth counting out loud.
 * - `halted` — the fleet's answer made waiting pointless and retrying is not a
 *   recourse (today: `forbidden`, whose fix is a deployment change). Distinct
 *   from `failed` so the panel can drop the retry that cannot work.
 *
 * `elapsedSeconds` lives in the state rather than being counted inside the
 * panel because the wait belongs to the polling hook (#17 C6), which owns the
 * clock; a panel that timed the wait itself would disagree with the hook the
 * moment either remounted.
 *
 * Declared here, in its own module, because two chunks meet on it: the panel
 * renders it and the first-forecast hook produces it. Neither owns the other.
 */
export type ForecastViewState =
  | { readonly status: 'checking' }
  | { readonly status: 'generating'; readonly elapsedSeconds: number }
  | { readonly status: 'ready'; readonly forecasts: readonly Forecast[] }
  | {
      readonly status: 'failed';
      readonly reason: ForecastFailureReason;
      readonly message: string;
    }
  | { readonly status: 'halted'; readonly message: string };
