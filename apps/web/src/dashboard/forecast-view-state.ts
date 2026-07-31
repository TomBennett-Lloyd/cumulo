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
 * forecast, and `forecasts` cannot be read on a pending one.
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
  | { readonly status: 'pending'; readonly elapsedSeconds: number }
  | { readonly status: 'ready'; readonly forecasts: readonly Forecast[] }
  | {
      readonly status: 'failed';
      readonly reason: ForecastFailureReason;
      readonly message: string;
    };
