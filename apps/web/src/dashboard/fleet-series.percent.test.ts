import {
  fleetForecastAggregate,
  forecastSchema,
  generationReadingSchema,
  siteSchema,
  type Forecast,
  type GenerationReading,
  type Site,
  type UncertaintyBand,
} from '@cumulo/shared';
import { describe, expect, it } from 'vitest';

import type { ForecastChartPoint } from '../charts/ForecastChart';
import { fleetChartAggregate } from './fleet-series';

/**
 * The `%`-of-capacity arm of `fleetChartAggregate`, in its own file.
 *
 * Split from `fleet-series.test.ts` (`docs/standards/structure.md` rule 7): that suite pins the
 * join and the night layer, this one pins a *unit transform* and needs a fleet shaped for it — two
 * sites of different capacity, because that is the only fleet on which the exact per-hour divisor
 * and the tempting "fleet capacity x share of sites reporting" proxy disagree. On same-sized sites
 * the two are equal at every hour and a suite built on one would pass against either rule. The
 * partial hours are where the whole feature lives.
 *
 * Its own `buildForecast` rather than an import from the other suite: what the two vary differs —
 * that one varies the *day* against a fixed site, this one varies the *site* against a fixed day —
 * and a shared builder would have to grow a parameter for each.
 */

/**
 * The fields any fixture below varies. The rest — model, source, irradiance, issue time — are
 * constant because nothing under test reads them, and `issuedAt` is derived from the hour's own
 * date so a fixture cannot claim to have been issued on a different day than it forecasts.
 */
interface ForecastSpec {
  readonly siteId: string;
  readonly validTime: string;
  readonly acPowerKw: number;
  readonly uncertainty?: UncertaintyBand;
}

const band = (p10AcPowerKw: number, p90AcPowerKw: number): UncertaintyBand => ({
  p10AcPowerKw,
  p90AcPowerKw,
});

/** Parsed rather than hand-built, so no test asserts against a shape `forecastSchema` would refuse. */
const buildForecast = (spec: ForecastSpec): Forecast =>
  forecastSchema.parse({
    model: 'physics',
    issuedAt: `${spec.validTime.slice(0, 'YYYY-MM-DD'.length)}T00:00:00Z`,
    weatherSource: 'open-meteo',
    poaIrradianceWm2: spec.acPowerKw * 100,
    ...spec,
  });
const SMALL_SITE = '11111111-1111-4111-8111-111111111111';
const LARGE_SITE = '22222222-2222-4222-8222-222222222222';
const UNKNOWN_SITE = '99999999-9999-4999-8999-999999999999';

/** Capacity is the only field the divisor reads, so it is the only one a fixture varies. */
const buildSite = (id: string, capacityKw: number): Site =>
  siteSchema.parse({
    id,
    name: `Site ${id.slice(0, 4)}`,
    latitude: 53.35,
    longitude: -6.26,
    tiltDegrees: 35,
    azimuthDegrees: 180,
    capacityKw,
  });

/** 4 kW + 6 kW: a 10 kW fleet in which neither site is half of it. */
const twoSizeFleet: readonly Site[] = [buildSite(SMALL_SITE, 4), buildSite(LARGE_SITE, 6)];

const summerHour = (hourUtc: number): string =>
  `2026-07-30T${hourUtc.toString().padStart(2, '0')}:00:00Z`;

const readingFrom = (siteId: string, hourUtc: number, acPowerKw: number): GenerationReading =>
  generationReadingSchema.parse({ siteId, validTime: summerHour(hourUtc), acPowerKw });

const percentPoints = (
  forecasts: readonly Forecast[],
  readings: readonly GenerationReading[],
): readonly ForecastChartPoint[] =>
  // Through `fleetForecastAggregate` — the same `@cumulo/shared` function the producer writes its
  // partials with and the demo source computes with — because the aggregate is what the seam hands
  // this pipeline since #494, and a hand-built one could carry a divisor no real fleet would.
  fleetChartAggregate(
    fleetForecastAggregate(forecasts, twoSizeFleet),
    readings,
    twoSizeFleet,
    'percent',
  ).points;

describe('fleetChartAggregate in percent of capacity', () => {
  it('divides a partial hour by the contributing sites’ capacity, not the fleet’s', () => {
    const points = percentPoints(
      [
        buildForecast({ siteId: SMALL_SITE, validTime: summerHour(12), acPowerKw: 2 }),
        buildForecast({ siteId: SMALL_SITE, validTime: summerHour(13), acPowerKw: 4 }),
        buildForecast({ siteId: LARGE_SITE, validTime: summerHour(13), acPowerKw: 6 }),
      ],
      [],
    );

    // 12:00 is the case: 2 kW behind the 4 kW that reported is 50%, while the fleet's own 10 kW
    // would call the same hour 20% — one site running flat out drawn as a fleet barely awake.
    // 13:00 is the control that holds either way, since a full hour's two divisors coincide.
    expect(points.map((point) => point.medianKw)).toEqual([50, 100]);
  });

  it('keeps the band nested by dividing it with the median’s divisor', () => {
    const points = percentPoints(
      [
        buildForecast({
          siteId: SMALL_SITE,
          validTime: summerHour(12),
          acPowerKw: 2,
          uncertainty: band(1, 3),
        }),
      ],
      [],
    );

    // One divisor for all three values, so P10 ≤ median ≤ P90 survives the transform. A band given
    // a divisor of its own could only unnest it against the line it is drawn around.
    expect(points).toEqual([
      expect.objectContaining({ medianKw: 50, band: { p10Kw: 25, p90Kw: 75 } }),
    ]);
  });

  it('divides actuals by their own hour’s contributors', () => {
    const points = percentPoints(
      [buildForecast({ siteId: SMALL_SITE, validTime: summerHour(12), acPowerKw: 2 })],
      [readingFrom(LARGE_SITE, 12, 1.5)],
    );

    // Same hour, different reporters: the forecast is the 4 kW site's, the measurement the 6 kW
    // site's. 1.5 kW is 25% of the capacity that actually metered it; the forecast's divisor would
    // call it 37.5%, a percentage of capacity no meter was behind.
    expect(points).toEqual([expect.objectContaining({ medianKw: 50, actualKw: 25 })]);
  });

  it('passes values above capacity through unclamped', () => {
    const points = percentPoints(
      [buildForecast({ siteId: SMALL_SITE, validTime: summerHour(12), acPowerKw: 5 })],
      [],
    );

    // A 4 kW site delivering 5 kW is a real hour — clamping it to 100 would erase exactly the hour
    // worth looking at.
    expect(points.map((point) => point.medianKw)).toEqual([125]);
  });

  it('answers an unknown contributor’s hour with a gap', () => {
    const points = percentPoints(
      [
        buildForecast({
          siteId: UNKNOWN_SITE,
          validTime: summerHour(12),
          acPowerKw: 2,
          uncertainty: band(1, 3),
        }),
      ],
      [readingFrom(UNKNOWN_SITE, 12, 1.5)],
    );

    // Nothing in the fleet matches, so no capacity can be evidenced for the hour and every value it
    // carries breaks: 0% would assert a fleet asleep, and any other number is invented. The band
    // goes whole — the key omitted, not an edge kept and an edge dropped.
    expect(points.map((point) => point.medianKw)).toEqual([null]);
    expect(points.map((point) => point.actualKw)).toEqual([null]);
    expect(points.filter((point) => 'band' in point)).toEqual([]);
  });
});

/*
 * `minimumContributingSites` was an unexported helper of the old fleet view and
 * was only ever proven through the rendered notice. It is a shared export now,
 * so its edges get named tests of their own — an empty series above all, which
 * is the one input whose answer is a decision rather than a minimum.
 */
