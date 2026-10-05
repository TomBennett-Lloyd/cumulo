import {
  utcIsoTimestampSchema,
  type Forecast,
  type GenerationReading,
  type Site,
  type UtcIsoTimestamp,
} from '@cumulo/shared';
import { describe, expect, it } from 'vitest';

import { siteOverlaySeries } from './site-overlay';

const SITE: Site = {
  id: '2a2b2f3c-0000-4000-8000-000000000001',
  name: 'Rathmines rooftop',
  latitude: 53.3244,
  longitude: -6.2657,
  tiltDegrees: 35,
  azimuthDegrees: 180,
  capacityKw: 4.25,
};

const at = (hour: number): UtcIsoTimestamp =>
  utcIsoTimestampSchema.parse(`2026-07-31T${hour.toString().padStart(2, '0')}:00:00Z`);

/** A forecast with a band, so the assertions below can show the band is dropped. */
const forecastAt = (hour: number, acPowerKw: number): Forecast => ({
  siteId: SITE.id,
  model: 'physics',
  validTime: at(hour),
  issuedAt: at(9),
  weatherSource: 'open-meteo',
  poaIrradianceWm2: acPowerKw * 100,
  acPowerKw,
  uncertainty: { p10AcPowerKw: acPowerKw - 0.5, p90AcPowerKw: acPowerKw + 0.5 },
});

/** A measured hour for the same site, in the shape the series reads. */
const readingAt = (hour: number, acPowerKw: number): GenerationReading => ({
  siteId: SITE.id,
  validTime: at(hour),
  acPowerKw,
});

describe('siteOverlaySeries', () => {
  it('names the series after the site, because the legend and the table column are its only labels', () => {
    const series = siteOverlaySeries(SITE, [forecastAt(10, 1.5)], [], 'kw');

    expect(series.label).toBe('Rathmines rooftop');
  });

  it('carries one point per forecast hour, at the median and nothing else', () => {
    const series = siteOverlaySeries(SITE, [forecastAt(10, 1.5), forecastAt(11, 2.25)], [], 'kw');

    /*
     * The whole point value, asserted by equality rather than field by field.
     * The band is the thing being left out — these forecasts all carry one — and
     * a per-field check would still pass on a point that had quietly grown a
     * `p10Kw` the chart would then have nowhere to draw.
     */
    expect(series.points).toEqual([
      { validTimeIso: '2026-07-31T10:00:00Z', kw: 1.5 },
      { validTimeIso: '2026-07-31T11:00:00Z', kw: 2.25 },
    ]);
  });

  it('hands the hours over in the order the source gave them, since the join is by timestamp', () => {
    const series = siteOverlaySeries(SITE, [forecastAt(12, 3), forecastAt(10, 1.5)], [], 'kw');

    // Not sorted, and that is the contract: `overlayColumn` resolves this
    // series onto the fleet chart's x-domain by `validTimeIso`, so an order
    // imposed here would be arranging something nobody reads in order.
    expect(series.points.map((point) => point.validTimeIso)).toEqual([
      '2026-07-31T12:00:00Z',
      '2026-07-31T10:00:00Z',
    ]);
  });

  it('is an empty series, not an absent one, when the site has no forecast hours', () => {
    // The chart tells the difference: an overlay of no points still puts the
    // site's name in the legend and the table, which is the honest answer to
    // "this site is selected and has nothing to show for these hours".
    const series = siteOverlaySeries(SITE, [], [], 'kw');

    expect(series).toEqual({ label: 'Rathmines rooftop', points: [] });
  });

  it('draws the site against its own capacity in percent, not the fleet’s', () => {
    // 2.125 kW from a 4.25 kW roof is 50% of what this site could do — which is the whole reason
    // the panel switches units on selection: on the fleet's kW axis the same hour is a flat line.
    const series = siteOverlaySeries(SITE, [forecastAt(10, 2.125)], [], 'percent');

    expect(series.points).toEqual([{ validTimeIso: '2026-07-31T10:00:00Z', kw: 50 }]);
  });

  it('passes a site beating its nameplate through unclamped', () => {
    const series = siteOverlaySeries(SITE, [forecastAt(10, 8.5)], [], 'percent');

    // 200%, not 100: a roof outrunning its rating is a real reading and the reader must see it.
    expect(series.points.map((point) => point.kw)).toEqual([200]);
  });

  /*
   * The seam (#530). The overlay mirrors the fleet's structure — measurements
   * behind it, forecast ahead of it — so what this series says about each hour is
   * which of the two it is, and the chart turns that into solid, dashed and a dot.
   */
  it('marks the measured hours and leaves the forecast hours unmarked', () => {
    const series = siteOverlaySeries(
      SITE,
      [forecastAt(11, 2.25), forecastAt(12, 3)],
      [readingAt(10, 1.5)],
      'kw',
    );

    expect(series.points).toEqual([
      { validTimeIso: '2026-07-31T10:00:00Z', kw: 1.5, measured: true },
      { validTimeIso: '2026-07-31T11:00:00Z', kw: 2.25 },
      { validTimeIso: '2026-07-31T12:00:00Z', kw: 3 },
    ]);
  });

  it('drops the site’s past forecasts, including the one at the hour it last measured', () => {
    // The hour the two meet carries the measurement, not the forecast of it —
    // which is what makes the solid and dashed stretches share a vertex there.
    const series = siteOverlaySeries(
      SITE,
      [forecastAt(9, 9), forecastAt(10, 9), forecastAt(11, 2.25)],
      [readingAt(9, 1), readingAt(10, 1.5)],
      'kw',
    );

    expect(series.points).toEqual([
      { validTimeIso: '2026-07-31T09:00:00Z', kw: 1, measured: true },
      { validTimeIso: '2026-07-31T10:00:00Z', kw: 1.5, measured: true },
      { validTimeIso: '2026-07-31T11:00:00Z', kw: 2.25 },
    ]);
  });

  it('drops a forecast hour behind the seam that no reading covers', () => {
    /*
     * The half of that rule a duplicate-only filter would satisfy, and the one
     * the solid stroke actually rests on: `overlayStretches`
     * (`apps/web/src/charts/forecast-chart-marks.tsx`) strokes every sample at or
     * before the seam as a measurement without re-reading `measured`, which is the
     * invariant `charts/chart-series.ts` states. So an outage hour behind the
     * seam — forecast, never measured — must not reach the chart at all; left in,
     * it would be drawn solid and read as a reading.
     */
    const series = siteOverlaySeries(
      SITE,
      [forecastAt(8, 9), forecastAt(9, 9), forecastAt(10, 9), forecastAt(11, 2.25)],
      [readingAt(9, 1), readingAt(10, 1.5)],
      'kw',
    );

    expect(series.points.map((point) => point.validTimeIso)).toEqual([
      '2026-07-31T09:00:00Z',
      '2026-07-31T10:00:00Z',
      '2026-07-31T11:00:00Z',
    ]);
  });

  it('finds that seam by timestamp rather than by the order the readings arrived', () => {
    const series = siteOverlaySeries(
      SITE,
      [forecastAt(10, 9), forecastAt(11, 2.25)],
      [readingAt(10, 1.5), readingAt(9, 1)],
      'kw',
    );

    // The 10:00 forecast is still dropped, though the 10:00 reading came first.
    expect(series.points.map((point) => point.validTimeIso)).toEqual([
      '2026-07-31T10:00:00Z',
      '2026-07-31T09:00:00Z',
      '2026-07-31T11:00:00Z',
    ]);
    expect(series.points.filter((point) => point.measured !== true)).toEqual([
      { validTimeIso: '2026-07-31T11:00:00Z', kw: 2.25 },
    ]);
  });

  it('is forecast only where the site measured nothing over the window', () => {
    const series = siteOverlaySeries(SITE, [forecastAt(10, 1.5)], [], 'kw');

    expect(series.points).toEqual([{ validTimeIso: '2026-07-31T10:00:00Z', kw: 1.5 }]);
  });

  it('is measurements only where the site has no forecast', () => {
    const series = siteOverlaySeries(SITE, [], [readingAt(10, 1.5)], 'kw');

    expect(series.points).toEqual([
      { validTimeIso: '2026-07-31T10:00:00Z', kw: 1.5, measured: true },
    ]);
  });

  it('scales a measured hour against the site’s own capacity too', () => {
    const series = siteOverlaySeries(SITE, [], [readingAt(10, 2.125)], 'percent');

    expect(series.points).toEqual([
      { validTimeIso: '2026-07-31T10:00:00Z', kw: 50, measured: true },
    ]);
  });
});
