import type { Forecast, Site } from '@cumulo/shared';

import type { ChartOverlaySeries } from '../charts/ForecastChart';
import type { ChartUnit } from './chart-unit';

/*
 * One site's forecast, as a series to draw over the fleet's.
 *
 * A module rather than a line inside `FleetPanel`: which numbers of a
 * `Forecast` become a chart series is a statement about the data, not about the
 * panel that happens to render it, and a unit that can be read and tested
 * without mounting a component is the cheaper of the two (`structure.md`
 * rule 1). It is the successor to the site panel's `site-series.ts`, which
 * joined a site's forecasts to its measurements for a chart of its own; that
 * chart is gone, and what survives it is one series on the fleet's.
 */

/**
 * The site's median forecast, labelled with the site's name.
 *
 * **Median only, deliberately.** A `Forecast` also carries a P10–P90 band, and
 * the fleet chart already draws one — the fleet's. A second band on the same
 * axis would put two washes over each other, and the reader's question at that
 * point ("is this the site's uncertainty or the fleet's?") has no answer the
 * chart can give: `chart-treatment.md` reserves the band treatment for the
 * chart's primary series, and an overlay is a line. The site's own uncertainty
 * is not lost, it is simply not this surface's subject.
 *
 * Measurements are absent for a different reason: they are a separate source
 * call (`siteActuals`), and spending one to draw a second actuals line under the
 * fleet's would be a metered request bought for a mark the treatment draws in
 * near-ink for exactly one series.
 *
 * The points are handed over in the order the source gave them. This series does
 * not define the chart's x-domain — `overlayValuesByIndex` joins it onto the
 * fleet series by timestamp — so sorting here would be arranging something
 * nobody reads in order. An hour the fleet chart does not show is dropped by
 * that join, and an hour this series does not cover becomes a gap in the mark
 * rather than a zero.
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
  unit: ChartUnit,
): ChartOverlaySeries => ({
  label: site.name,
  points: forecasts.map((forecast) => ({
    validTimeIso: forecast.validTime,
    kw: unit === 'kw' ? forecast.acPowerKw : (forecast.acPowerKw / site.capacityKw) * 100,
  })),
});
