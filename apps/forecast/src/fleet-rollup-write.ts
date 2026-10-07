import {
  FLEET_ROLLUP_FORECAST_KIND,
  describeThrown,
  fleetRollupMembers,
  fleetRollupPartials,
  type FleetRollupPartial,
  type FleetRollupProvenance,
  type Forecast,
  type SitePhysics,
  type UtcIsoTimestamp,
} from '@cumulo/shared';
import type { BatchWriteOutcome, SeriesAdapter } from '@cumulo/storage';

/**
 * The fleet roll-up producer: having stored a location's forecasts, write that location's
 * contribution to each hour of the fleet aggregate (ADR 0009, #494).
 *
 * **Why it lives in the producer at all.** `GET /v1/fleet/forecast` used to answer by reading every
 * site's partition and summing in the request — 1,753.9 ms p50 warm, on a visitor's first paint, and
 * paid again by every visitor. The sum is the same every time, so it is computed once here, where
 * the numbers already are, and read back as twelve small items.
 *
 * **Zero extra reads.** The partials are computed from the forecasts this invocation just wrote and
 * the sites it already listed — nothing is re-queried.
 *
 * **No end-of-run event, and none needed.** ADR 0004 makes one SQS message one *location's* whole
 * horizon, so an ingestion cycle is twelve independent invocations with no last-one signal. Each
 * writes only its own keys — `(kind, hour, location)` — so two invocations of one cycle never touch
 * the same item and there is no last-writer race to lose.
 *
 * **It cannot fail the record.** Every failure is converted to a log entry, for the reason
 * `simulate-actuals.ts` states about its own: this runs below the record boundary
 * (`consume-message.ts`) and after the message's real work is already stored, so a throw crossing it
 * would redeliver a whole location's horizon to retry a derived write. The next cycle rewrites every
 * one of these keys an hour later, so a missed roll-up repairs itself; and when a location has never
 * written one, the API's fallback answers from the fan-out and says so in the log.
 */

/**
 * The log event every roll-up write is reported under, exported so a test asserts on the name an
 * operator greps for rather than on a copy of it.
 */
export const fleetRollupWriteEvent = 'forecast.fleet-rollup.outcome';

/**
 * What became of one location's roll-up, as a value.
 *
 * `nothing-to-roll-up` is a success and is deliberately not folded into `written` with a zero: a
 * location whose sites produced no forecast of the rolled-up model has nothing to contribute, and an
 * operator reading a run of those is reading a fleet that is not forecasting rather than a producer
 * that is failing. It is unreachable today — `packages/forecast` emits physics for every hour it is
 * given — which is precisely why it must not be silence.
 */
export type FleetRollupOutcome = { readonly locationId: string } & (
  | { readonly status: 'written'; readonly hourCount: number }
  | { readonly status: 'nothing-to-roll-up' }
  | { readonly status: 'store-partial'; readonly unprocessedCount: number }
  | { readonly status: 'failed'; readonly detail: string }
);

/**
 * The steps that can throw. A `failed` outcome names which, because the next step differs
 * (`docs/standards/error-handling.md` rule 4): a `putFleetRollupPartials` throw is the series table,
 * while the other two are bugs in the arithmetic — nothing an operator can fix in AWS.
 */
type FleetRollupOperation = 'fleetRollupMembers' | 'fleetRollupPartials' | 'putFleetRollupPartials';

/**
 * The collaborators a roll-up write needs.
 *
 * `series` is narrowed to the one method this path uses, so the service's least-privilege posture
 * stays a compile-time fact as well as an IAM one.
 */
export interface FleetRollupWriteDeps {
  readonly series: Pick<SeriesAdapter, 'putFleetRollupPartials'>;
  /** Structured-logging sink, injected — this module is below the composition root (rule 4). */
  readonly log: (entry: Record<string, unknown>) => void;
}

const failedOutcome = (
  locationId: string,
  operation: FleetRollupOperation,
  error: unknown,
): FleetRollupOutcome => ({
  locationId,
  status: 'failed',
  detail: `${operation} threw — ${describeThrown(error)}`,
});

/**
 * Compute and write one location's partials, reporting the result and never rejecting.
 *
 * `sites` is what the message listed: the nameplate capacity behind each hour, and the membership
 * the slices are stamped with beside `issuedAt` — the message's one vintage — so the API can tell
 * these slices from a stale one (#602).
 *
 * The arithmetic is `@cumulo/shared`'s and nothing here adds a kilowatt to another
 * (`docs/standards/architecture.md` rule 3). The model selection is `@cumulo/shared`'s too —
 * `fleetRollupPartials` filters on the kind it is handed, so the producer and the API's fallback
 * cannot select differently (#531).
 */
export const writeFleetRollup = async (
  deps: FleetRollupWriteDeps,
  locationId: string,
  issuedAt: UtcIsoTimestamp,
  forecasts: readonly Forecast[],
  sites: readonly SitePhysics[],
): Promise<FleetRollupOutcome> => {
  let provenance: FleetRollupProvenance;
  try {
    provenance = { members: fleetRollupMembers(sites), issuedAt };
  } catch (error: unknown) {
    return failedOutcome(locationId, 'fleetRollupMembers', error);
  }

  let partials: readonly FleetRollupPartial[];
  try {
    partials = fleetRollupPartials(forecasts, sites, FLEET_ROLLUP_FORECAST_KIND);
  } catch (error: unknown) {
    return failedOutcome(locationId, 'fleetRollupPartials', error);
  }

  if (partials.length === 0) {
    return { locationId, status: 'nothing-to-roll-up' };
  }

  let stored: BatchWriteOutcome;
  try {
    stored = await deps.series.putFleetRollupPartials(
      FLEET_ROLLUP_FORECAST_KIND,
      locationId,
      provenance,
      partials,
    );
  } catch (error: unknown) {
    return failedOutcome(locationId, 'putFleetRollupPartials', error);
  }

  return stored.status === 'partial'
    ? { locationId, status: 'store-partial', unprocessedCount: stored.unprocessedCount }
    : { locationId, status: 'written', hourCount: partials.length };
};

/**
 * The roll-up write as `consume-message.ts` calls it: run it, say what happened, return nothing.
 *
 * The outcome is logged here rather than returned to the record boundary because it is not the
 * message's result — the message's work is the forecasts, and those are already stored by the time
 * this runs.
 */
export const reportFleetRollupWrite = async (
  deps: FleetRollupWriteDeps,
  locationId: string,
  issuedAt: UtcIsoTimestamp,
  forecasts: readonly Forecast[],
  sites: readonly SitePhysics[],
): Promise<void> => {
  deps.log({
    event: fleetRollupWriteEvent,
    ...(await writeFleetRollup(deps, locationId, issuedAt, forecasts, sites)),
  });
};
