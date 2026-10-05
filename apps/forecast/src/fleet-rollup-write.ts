import {
  FLEET_ROLLUP_FORECAST_KIND,
  describeThrown,
  fleetRollupPartials,
  type FleetRollupPartial,
  type Forecast,
  type SiteCapacity,
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
 * the sites it already listed — nothing is re-queried, which is the whole reason this shape was
 * chosen over one that re-derives the fleet from storage on every message. One location's message
 * costs two `BatchWriteItem` calls for a 48-hour horizon and nothing else.
 *
 * **No end-of-run event, and none needed.** ADR 0004 makes one SQS message one *location's* whole
 * horizon, so an ingestion cycle is twelve independent invocations with no last-one signal. Each
 * writes only its own keys — `(kind, hour, location)` — so two invocations of one cycle never touch
 * the same item and there is no last-writer race to lose. The sum happens at read, over whatever is
 * there. A mid-cycle read therefore mixes this cycle's locations with last cycle's, which is exactly
 * what the per-site fan-out did before it and is not new staleness.
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
 * The two steps that can throw. A `failed` outcome names which, because the next step differs
 * (`docs/standards/error-handling.md` rule 4): a `putFleetRollupPartials` throw is the series table,
 * while a `fleetRollupPartials` throw is a bug in the arithmetic — nothing an operator can fix in
 * AWS.
 */
type FleetRollupOperation = 'fleetRollupPartials' | 'putFleetRollupPartials';

/**
 * The collaborators a roll-up write needs.
 *
 * `series` is narrowed to the one method this path uses, so the service's least-privilege posture
 * stays a compile-time fact as well as an IAM one — and narrowing is honest here because the roll-up
 * adds no new AWS permission at all: it is a Put into a table `infra/forecast/iam.tf` already grants
 * this function write access to, under a different partition key value.
 */
export interface FleetRollupWriteDeps {
  readonly series: Pick<SeriesAdapter, 'putFleetRollupPartials'>;
  /** Structured-logging sink, injected — this module is below the composition root (rule 4). */
  readonly log: (entry: Record<string, unknown>) => void;
}

/**
 * The forecasts the fleet aggregate is summed from: one model's, never two.
 *
 * `aggregateFleetForecast`'s own docblock refuses to filter and says why — model selection is the
 * caller's — and this is the caller making it, through the one declaration the API reads back with
 * (`FLEET_ROLLUP_FORECAST_KIND`). Filtering here rather than trusting the producer to emit one model
 * is the difference between a property the code holds and a coincidence: `packages/forecast` emits
 * physics alone today, and the hour that stops being true is the hour a silent double-count would
 * otherwise begin.
 */
const rolledUpForecasts = (forecasts: readonly Forecast[]): readonly Forecast[] =>
  forecasts.filter((forecast) => forecast.model === FLEET_ROLLUP_FORECAST_KIND.model);

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
 * `sites` supplies the nameplate capacity behind each hour — the divisor the dashboard's `%` view
 * needs — and `SitePhysics` satisfies `SiteCapacity` structurally, so the producer hands over what
 * it already listed rather than fetching a richer site record to reach two fields.
 *
 * The arithmetic is `@cumulo/shared`'s and nothing here adds a kilowatt to another: there is no `+`
 * over a power value in this file, which is the rule `apps/web/src/dashboard/fleet-series.ts` states
 * for the client, applied to the producer (`docs/standards/architecture.md` rule 3).
 */
export const writeFleetRollup = async (
  deps: FleetRollupWriteDeps,
  locationId: string,
  forecasts: readonly Forecast[],
  sites: readonly SiteCapacity[],
): Promise<FleetRollupOutcome> => {
  let partials: readonly FleetRollupPartial[];
  try {
    partials = fleetRollupPartials(rolledUpForecasts(forecasts), sites);
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
 * this runs. Folding a derived write into `MessageOutcome` would make a healthy message report a
 * failure and be redelivered for it, which is the opposite of what the roll-up is for.
 */
export const reportFleetRollupWrite = async (
  deps: FleetRollupWriteDeps,
  locationId: string,
  forecasts: readonly Forecast[],
  sites: readonly SiteCapacity[],
): Promise<void> => {
  deps.log({
    event: fleetRollupWriteEvent,
    ...(await writeFleetRollup(deps, locationId, forecasts, sites)),
  });
};
