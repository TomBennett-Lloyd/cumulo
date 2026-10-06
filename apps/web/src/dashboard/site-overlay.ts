import {
  compareUtcIsoTimestamps,
  type Forecast,
  type GenerationReading,
  type Site,
  type UtcIsoTimestamp,
} from '@cumulo/shared';

import type { ChartOverlaySeries } from '../charts/ForecastChart';
import type { ChartUnit } from './chart-unit';

/*
 * One site's hours, as a series to draw over the fleet's.
 *
 * A module rather than a line inside `FleetPanel`: which numbers of a
 * `Forecast` become a chart series is a statement about the data, not about the
 * panel that happens to render it (`structure.md` rule 1).
 */

/** The site's own capacity is the divisor, so the hour reads against this roof. */
const inUnit = (site: Site, unit: ChartUnit, acPowerKw: number): number =>
  unit === 'kw' ? acPowerKw : (acPowerKw / site.capacityKw) * 100;

/**
 * The site's last measured hour, by timestamp rather than by position.
 *
 * The readings arrive in whatever order the source gave them, so this is a
 * maximum and not a last element — and the ordering is
 * `compareUtcIsoTimestamps`' (`packages/shared/src/timestamp.ts`), which owns the
 * rule and the width guarantee it rests on.
 */
const lastMeasuredIso = (actuals: readonly GenerationReading[]): UtcIsoTimestamp | undefined =>
  actuals.reduce<UtcIsoTimestamp | undefined>(
    (latest, reading) =>
      latest === undefined || compareUtcIsoTimestamps(reading.validTime, latest) > 0
        ? reading.validTime
        : latest,
    undefined,
  );

/**
 * The site's hours, labelled with the site's name: measurements behind the
 * site's own seam, forecast ahead of it.
 *
 * **It mirrors the fleet's structure rather than drawing one stroke across the
 * window** (#530). **Every** forecast hour at or before the
 * site's last measured hour is dropped here — not only the ones a reading
 * duplicates — because the chart strokes a sample behind the seam as a
 * measurement without re-asking which it was (`ChartOverlayPoint.measured` in
 * `apps/web/src/charts/chart-series.ts` states that invariant). The hour the two
 * runs meet at therefore carries the measurement.
 *
 * The seam travels as `measured` on each point, not as an index: this series is
 * in its own time base and `overlayColumn` (`apps/web/src/charts/chart-series.ts`)
 * is what resolves it onto the chart's x-domain, so an index minted here would be
 * an index into the wrong array.
 *
 * **Measurements cost no extra metered call.** `HttpFleetDataSource.siteActuals`
 * reads `.actuals` off the same `GET /v1/sites/{id}/series` payload
 * `siteForecasts` reads `.forecasts` from, and `seriesFor` shares the in-flight
 * request between the two (`apps/web/src/data/http-fleet-data-source.ts`), so the
 * panel asking for both spends what asking for either already spent.
 *
 * **Median only of the forecast, deliberately.** A `Forecast` also carries a
 * P10–P90 band, and the fleet chart already draws one — the fleet's.
 * `chart-treatment.md` reserves the band treatment for the chart's primary
 * series, and an overlay is a line.
 *
 * The points are handed over in the order the source gave them, measurements
 * first. This series does not define the chart's x-domain — `overlayColumn`
 * joins it onto the fleet series by timestamp — so sorting here would be
 * arranging something nobody reads in order. An hour the fleet chart does not
 * show is dropped by that join, and an hour this series does not cover becomes a
 * gap in the mark rather than a zero.
 *
 * **In `'percent'` the divisor is the site's own capacity, and it is the same
 * number at every hour.** That capacity needs no guard before it divides:
 * `siteSchema` declares `capacityKw` as `z.number().positive()`
 * (`packages/shared/src/site.ts`), so a `Site` that reached this function cannot
 * carry a zero or a negative one. Values above 100% are passed through: a site
 * beating its nameplate is a real hour.
 *
 * The `kw` field carries whichever unit was asked for, per
 * `ChartOverlayPoint`'s contract — the same seam rule the fleet series follows,
 * where kW-spelled fields hold the chart's selected display unit and everything
 * below the panel stays in kW.
 */
export const siteOverlaySeries = (
  site: Site,
  forecasts: readonly Forecast[],
  actuals: readonly GenerationReading[],
  unit: ChartUnit,
): ChartOverlaySeries => {
  const seam = lastMeasuredIso(actuals);
  return {
    label: site.name,
    points: [
      ...actuals.map((reading) => ({
        validTimeIso: reading.validTime,
        kw: inUnit(site, unit, reading.acPowerKw),
        measured: true,
      })),
      ...forecasts
        .filter(
          (forecast) => seam === undefined || compareUtcIsoTimestamps(forecast.validTime, seam) > 0,
        )
        .map((forecast) => ({
          validTimeIso: forecast.validTime,
          kw: inUnit(site, unit, forecast.acPowerKw),
        })),
    ],
  };
};
