import type { Forecast, GenerationReading } from '@cumulo/shared';

import type { ForecastChartPoint } from '../charts/ForecastChart';
import type { FleetDataSource, FleetSourceResult, RangeHours } from '../data/fleet-data-source';

/*
 * One site's two series: how they are fetched, and how they become chart points.
 *
 * Lifted unchanged out of the old site detail view, which #148 deleted along
 * with the rest of them. The join and the paired fetch were
 * never the view's — they are statements about the *data* (which measurement
 * belongs to which forecast hour, and what it means for one of the two calls to
 * fail), and the panel that replaces the view needs exactly the same two
 * answers. Keeping them in a component file made them reachable only by
 * rendering one (`structure.md` rule 1: a unit should be legible, and testable,
 * without its enclosing context).
 */

/** Both series for one site and window, fetched together so they share a state. */
export interface SiteSeries {
  readonly forecasts: readonly Forecast[];
  readonly actuals: readonly GenerationReading[];
}

/**
 * One forecast plus its measurement, if an hour with that exact `validTime` was
 * measured. The `band` key is built conditionally rather than assigned
 * `undefined`: under `exactOptionalPropertyTypes` an absent band and a band of
 * `undefined` are different values, and the chart draws only the former as a
 * point estimate.
 */
const toChartPoint = (
  forecast: Forecast,
  actualByTime: ReadonlyMap<string, number>,
): ForecastChartPoint => {
  const measured = actualByTime.get(forecast.validTime);
  const point = {
    validTimeIso: forecast.validTime,
    medianKw: forecast.acPowerKw,
    actualKw: measured ?? null,
  };
  return forecast.uncertainty === undefined
    ? point
    : {
        ...point,
        band: {
          p10Kw: forecast.uncertainty.p10AcPowerKw,
          p90Kw: forecast.uncertainty.p90AcPowerKw,
        },
      };
};

/**
 * The display join: one chart point per forecast, ascending by time.
 *
 * The forecast series defines the x-domain, so a measurement whose hour was
 * never forecast is dropped rather than appended. Adding it would put a sample
 * on the axis with no forecast beneath it, which reads as a forecast of zero —
 * and the honest fix for a gap in the forecast series is a gap, not an actual
 * standing in for one. Sorting is lexicographic because `UtcIsoTimestamp` is
 * fixed-width UTC, where string order *is* chronological order.
 */
export const joinSiteSeries = (
  forecasts: readonly Forecast[],
  actuals: readonly GenerationReading[],
): readonly ForecastChartPoint[] => {
  const actualByTime = new Map<string, number>(
    actuals.map((actual) => [actual.validTime, actual.acPowerKw]),
  );
  return [...forecasts]
    .sort((left, right) => left.validTime.localeCompare(right.validTime))
    .map((forecast) => toChartPoint(forecast, actualByTime));
};

/**
 * Both source calls as one result: either series failing makes the pair
 * failed, because a chart of forecasts with the measurements silently missing
 * would claim the horizon is now.
 */
export const loadSiteSeries = async (
  dataSource: FleetDataSource,
  siteId: string,
  range: RangeHours,
): Promise<FleetSourceResult<SiteSeries>> => {
  const [forecasts, actuals] = await Promise.all([
    dataSource.siteForecasts(siteId, range),
    dataSource.siteActuals(siteId, range),
  ]);
  if (forecasts.kind === 'error') {
    return forecasts;
  }
  if (actuals.kind === 'error') {
    return actuals;
  }
  return { kind: 'ok', value: { forecasts: forecasts.value, actuals: actuals.value } };
};
