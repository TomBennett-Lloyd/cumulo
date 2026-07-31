import type { Forecast, GenerationReading, Site } from '@cumulo/shared';

/**
 * The web app's read surface over fleet data.
 *
 * Every view in #19 talks to this interface and nothing else, so the same
 * components run against deterministic fixtures today and the Fleet API (#14)
 * later with no change above this line.
 *
 * Two properties are load-bearing:
 *
 * - **Failures are values, not exceptions** (`docs/standards/error-handling.md`
 *   rule 1). "No forecast for this site", "the API said 503", "the payload did
 *   not parse" are all part of this interface's domain, so they come back as
 *   `{ status: 'failed', error }` with the operation and entity in the message
 *   (rule 4). A rejected promise from an implementation is a *bug* in that
 *   implementation, not a supported outcome — callers do not catch.
 * - **Members are function-typed properties, not method signatures.** Callers
 *   pass `provider.siteForecasts` straight into a hook, and a detached method
 *   would lose its `this` (`@typescript-eslint/unbound-method`). Arrow-typed
 *   properties make detaching safe by construction.
 */

/**
 * The look-back windows the views offer, as whole hours: 24 h, 48 h, 7 d.
 *
 * A closed union rather than `number`: a provider must be able to serve every
 * value, and adding a window should fail to compile everywhere it is switched
 * on rather than silently return nothing.
 */
export type RangeHours = 24 | 48 | 168;

/** The outcome of one provider call — ready with data, or failed with a reason to show. */
export type DataResult<T> =
  | { readonly status: 'ready'; readonly data: T }
  | { readonly status: 'failed'; readonly error: string };

export interface FleetDataProvider {
  readonly listSites: () => Promise<DataResult<readonly Site[]>>;
  readonly siteForecasts: (
    siteId: string,
    range: RangeHours,
  ) => Promise<DataResult<readonly Forecast[]>>;
  readonly siteActuals: (
    siteId: string,
    range: RangeHours,
  ) => Promise<DataResult<readonly GenerationReading[]>>;
  readonly fleetForecasts: (range: RangeHours) => Promise<DataResult<readonly Forecast[]>>;
  readonly fleetActuals: (range: RangeHours) => Promise<DataResult<readonly GenerationReading[]>>;
}
