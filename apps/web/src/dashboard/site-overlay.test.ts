import {
  utcIsoTimestampSchema,
  type Forecast,
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

describe('siteOverlaySeries', () => {
  it('names the series after the site, because the legend and the table column are its only labels', () => {
    const series = siteOverlaySeries(SITE, [forecastAt(10, 1.5)]);

    expect(series.label).toBe('Rathmines rooftop');
  });

  it('carries one point per forecast hour, at the median and nothing else', () => {
    const series = siteOverlaySeries(SITE, [forecastAt(10, 1.5), forecastAt(11, 2.25)]);

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
    const series = siteOverlaySeries(SITE, [forecastAt(12, 3), forecastAt(10, 1.5)]);

    // Not sorted, and that is the contract: `overlayValuesByIndex` resolves this
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
    const series = siteOverlaySeries(SITE, []);

    expect(series).toEqual({ label: 'Rathmines rooftop', points: [] });
  });
});
