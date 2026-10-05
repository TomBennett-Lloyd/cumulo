import type { Forecast, GenerationReading, Site } from '@cumulo/shared';

import type { ChartOverlaySeries } from '../charts/ForecastChart';
import type { ChartUnit } from './chart-unit';

/*
 * One site's hours, as a series to draw over the fleet's.
 *
 * A module rather than a line inside `FleetPanel`: which numbers of a
 * `Forecast` become a chart series is a statement about the data, not about the
 * panel that happens to render it, and a unit that can be read and tested
 * without mounting a component is the cheaper of the two (`structure.md`
 * rule 1). It is the successor to the site panel's `site-series.ts`, which
 * joined a site's forecasts to its measurements for a chart of its own; that
 * chart is gone, and what survives it is one series on the fleet's.
 */

/** The site's own capacity is the divisor, so the hour reads against this roof. */
const inUnit = (site: Site, unit: ChartUnit, acPowerKw: number): number =>
  unit === 'kw' ? acPowerKw : (acPowerKw / site.capacityKw) * 100;

/**
 * The site's last measured hour, by timestamp rather than by position.
 *
 * The readings arrive in whatever order the source gave them, so this is a
 * maximum and not a last element. ISO-8601 UTC timestamps of one shape order
 * lexicographically, which is the property `utcIsoTimestampSchema`
 * (`packages/shared/src/timestamp.ts`) makes true of every value here.
 */
const lastMeasuredIso = (actuals: readonly GenerationReading[]): string | undefined =>
  actuals.reduce<string | undefined>(
    (latest, reading) =>
      latest === undefined || reading.validTime > latest ? reading.validTime : latest,
    undefined,
  );

/**
 * The site's hours, labelled with the site's name: measurements behind the
 * site's own seam, forecast ahead of it.
 *
 * **It mirrors the fleet's structure rather than drawing one stroke across the
 * window** (#530). Until then this series was the site's `forecasts` over the
 * whole range, so the hours behind the seam were the site's *past* forecasts
 * drawn identically to its future ones — a line whose left half said "predicted"
 * and looked like its right half. The fleet draws nothing of that kind: its
 * actuals stop at the seam and its median begins there. So a forecast hour at or
 * before the site's last measured hour is dropped here, and the hour the two
 * meet at carries the measurement.
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
 * panel asking for both spends what asking for either already spent. That share
 * is what retired this module's previous reasoning, which refused the readings as
 * "a metered request bought for a mark".
 *
 * **Median only of the forecast, deliberately.** A `Forecast` also carries a
 * P10–P90 band, and the fleet chart already draws one — the fleet's. A second
 * band on the same axis would put two washes over each other, and the reader's
 * question at that point ("is this the site's uncertainty or the fleet's?") has
 * no answer the chart can give: `chart-treatment.md` reserves the band treatment
 * for the chart's primary series, and an overlay is a line. The site's own
 * uncertainty is not lost, it is simply not this surface's subject.
 *
 * The points are handed over in the order the source gave them, measurements
 * first. This series does not define the chart's x-domain — `overlayColumn`
 * joins it onto the fleet series by timestamp — so sorting here would be
 * arranging something nobody reads in order. An hour the fleet chart does not
 * show is dropped by that join, and an hour this series does not cover becomes a
 * gap in the mark rather than a zero.
 *
 * **In `'percent'` the divisor is the site's own capacity, and it is the same
 * number at every hour.** The fleet's divisor moves hour to hour because which
 * sites reported moves hour to hour; a single site is either present for an
 * hour or has no point there at all, so there is nothing to vary. That capacity
 * needs no guard before it divides: `siteSchema` declares `capacityKw` as
 * `z.number().positive()` (`packages/shared/src/site.ts:47`), so a `Site` that
 * reached this function cannot carry a zero or a negative one, and a check here
 * would be asking a question the type already answered. Values above 100% are
 * passed through: a site beating its nameplate is a real hour, and clamping it
 * would erase the reading the reader most wants to see.
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
        .filter((forecast) => seam === undefined || forecast.validTime > seam)
        .map((forecast) => ({
          validTimeIso: forecast.validTime,
          kw: inUnit(site, unit, forecast.acPowerKw),
        })),
    ],
  };
};
