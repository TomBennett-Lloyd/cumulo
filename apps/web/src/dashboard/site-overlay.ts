import type { Forecast, Site } from '@cumulo/shared';

import type { ChartOverlaySeries } from '../charts/ForecastChart';

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
 */
export const siteOverlaySeries = (
  site: Site,
  forecasts: readonly Forecast[],
): ChartOverlaySeries => ({
  label: site.name,
  points: forecasts.map((forecast) => ({
    validTimeIso: forecast.validTime,
    kw: forecast.acPowerKw,
  })),
});
