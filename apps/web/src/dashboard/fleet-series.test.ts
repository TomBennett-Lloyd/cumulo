import {
  canonicalFleetSeed,
  forecastSchema,
  generateFleet,
  generationReadingSchema,
  siteSchema,
  utcIsoTimestampSchema,
  type Forecast,
  type GenerationReading,
  type Site,
  type UncertaintyBand,
  type UtcIsoTimestamp,
} from '@cumulo/shared';
import { describe, expect, it } from 'vitest';

import type { ForecastChartPoint } from '../charts/ForecastChart';
import { fleetChartAggregate, joinFleetSeries, minimumContributingSites } from './fleet-series';

const timestamp = (hour: number): UtcIsoTimestamp =>
  utcIsoTimestampSchema.parse(`2026-07-30T${hour.toString().padStart(2, '0')}:00:00Z`);

const band = (p10AcPowerKw: number, p90AcPowerKw: number): UncertaintyBand => ({
  p10AcPowerKw,
  p90AcPowerKw,
});

describe('joinFleetSeries', () => {
  it('carries the fleet band onto the chart point', () => {
    const joined = joinFleetSeries(
      [
        {
          validTime: timestamp(6),
          acPowerKw: 6,
          uncertainty: band(4, 9),
          contributingSiteCount: 2,
        },
      ],
      [],
    );

    expect(joined).toEqual([
      {
        validTimeIso: '2026-07-30T06:00:00Z',
        medianKw: 6,
        band: { p10Kw: 4, p90Kw: 9 },
        actualKw: null,
      },
    ]);
  });

  it('joins a measurement to its own hour and leaves an unmeasured hour null', () => {
    const joined = joinFleetSeries(
      [
        { validTime: timestamp(6), acPowerKw: 6, contributingSiteCount: 2 },
        { validTime: timestamp(7), acPowerKw: 8, contributingSiteCount: 2 },
      ],
      [{ validTime: timestamp(6), acPowerKw: 5, contributingSiteCount: 2 }],
    );

    expect(joined.map((point) => point.actualKw)).toEqual([5, null]);
  });

  it('omits the band key entirely for an hour with no uncertainty', () => {
    const joined = joinFleetSeries(
      [{ validTime: timestamp(6), acPowerKw: 6, contributingSiteCount: 2 }],
      [],
    );

    expect(joined.filter((point) => 'band' in point)).toEqual([]);
  });

  it('keeps a measurement whose hour has no forecast, and orders it before the forecast hours', () => {
    const joined = joinFleetSeries(
      [{ validTime: timestamp(6), acPowerKw: 6, contributingSiteCount: 2 }],
      [
        { validTime: timestamp(6), acPowerKw: 5, contributingSiteCount: 2 },
        { validTime: timestamp(5), acPowerKw: 1, contributingSiteCount: 1 },
      ],
    );

    // 05:00 arrives second in the actuals and first in the answer: the union is sorted by instant,
    // not by the order either input happened to be in.
    expect(joined.map((point) => point.validTimeIso)).toEqual([
      '2026-07-30T05:00:00Z',
      '2026-07-30T06:00:00Z',
    ]);
    expect(joined.map((point) => point.medianKw)).toEqual([null, 6]);
  });

  /*
   * The live shape, which is the one the old forecast-only x-domain could not draw at all. The
   * deployed source reads forecasts forward from the clock and actuals back from it, so the two
   * windows share no hour — every simulated actual was dropped, and the chart rendered a legend
   * and an accessible name for a series that was never on it (#264).
   */
  it('keeps disjoint-window actuals on the chart, past hours before future ones', () => {
    const joined = joinFleetSeries(
      [
        {
          validTime: timestamp(12),
          acPowerKw: 9,
          uncertainty: band(7, 11),
          contributingSiteCount: 2,
        },
        {
          validTime: timestamp(13),
          acPowerKw: 7,
          uncertainty: band(5, 9),
          contributingSiteCount: 2,
        },
      ],
      [
        { validTime: timestamp(10), acPowerKw: 4, contributingSiteCount: 2 },
        { validTime: timestamp(11), acPowerKw: 6, contributingSiteCount: 2 },
      ],
    );

    expect(joined.map((point) => point.validTimeIso)).toEqual([
      '2026-07-30T10:00:00Z',
      '2026-07-30T11:00:00Z',
      '2026-07-30T12:00:00Z',
      '2026-07-30T13:00:00Z',
    ]);
    // Every actual survives, which is the assertion the defect fails.
    expect(joined.map((point) => point.actualKw)).toEqual([4, 6, null, null]);
    // And nothing is invented on the half of the domain the other series owns: the past hours have
    // no median and no band, the future hours have no reading.
    expect(joined.map((point) => point.medianKw)).toEqual([null, null, 9, 7]);
    expect(joined.filter((point) => 'band' in point).map((point) => point.validTimeIso)).toEqual([
      '2026-07-30T12:00:00Z',
      '2026-07-30T13:00:00Z',
    ]);
  });
});

/*
 * `fleetChartAggregate` is the pipeline the panel actually calls, and the only place the night flag
 * is stamped. What it owes a test is the *threading*: that the fleet reaches the classifier and the
 * classifier reaches every point. Whether a given hour is really night is `fleet-night.test.ts`'s
 * question, so the assertions below turn on a contrast the summer/winter split makes unarguable
 * rather than on any single hour's verdict.
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

/**
 * One forecast fixture, parsed rather than hand-built so no test can assert against a shape
 * `forecastSchema` would refuse.
 *
 * Shared by both suites below because it is genuinely one intent: a schema-valid `Forecast` to feed
 * the pipeline. What the two suites vary differs — the night suite varies the *day* against a fixed
 * site, the percent suite varies the *site* against a fixed day — and only the varying part is
 * theirs (`structure.md` rule 7: extract the shared portion, and nothing more).
 */
const buildForecast = (spec: ForecastSpec): Forecast =>
  forecastSchema.parse({
    model: 'physics',
    issuedAt: `${spec.validTime.slice(0, 'YYYY-MM-DD'.length)}T00:00:00Z`,
    weatherSource: 'open-meteo',
    poaIrradianceWm2: spec.acPowerKw * 100,
    ...spec,
  });

const forecastAt = (hourUtc: number, acPowerKw: number, dayIso: string): Forecast =>
  buildForecast({
    siteId: '11111111-1111-4111-8111-111111111111',
    validTime: `${dayIso}T${hourUtc.toString().padStart(2, '0')}:00:00Z`,
    acPowerKw,
  });

describe('fleetChartAggregate', () => {
  const demoFleet = generateFleet(canonicalFleetSeed);

  it('marks the fleet’s dark hours and leaves its daylight hours unmarked', () => {
    // Midwinter, where the contrast is widest and needs no fine judgement: 02:00 UTC is the middle
    // of the night anywhere in these islands, and 12:00 UTC is the middle of the day.
    const aggregate = fleetChartAggregate(
      [forecastAt(2, 0, '2026-12-21'), forecastAt(12, 9, '2026-12-21')],
      [],
      demoFleet,
      'kw',
    );

    expect(aggregate.points.map((point) => point.night)).toEqual([true, false]);
  });

  it('flags every point, so an unflagged point means the flag was never threaded', () => {
    const aggregate = fleetChartAggregate(
      [forecastAt(2, 0, '2026-12-21'), forecastAt(12, 9, '2026-12-21')],
      [],
      demoFleet,
      'kw',
    );

    expect(aggregate.points.every((point) => point.night !== undefined)).toBe(true);
  });

  it('marks nothing at all for a fleet with no sites, whatever the hour', () => {
    // The empty-fleet arm reaching the chart: a fleet that is nowhere has no night, so the layer
    // draws nothing rather than shading hours no site was consulted about.
    const aggregate = fleetChartAggregate(
      [forecastAt(2, 0, '2026-12-21'), forecastAt(12, 9, '2026-12-21')],
      [],
      [],
      'kw',
    );

    expect(aggregate.points.map((point) => point.night)).toEqual([false, false]);
  });

  it('leaves the kilowatts and the completeness count untouched by the night layer', () => {
    const aggregate = fleetChartAggregate([forecastAt(12, 9, '2026-12-21')], [], demoFleet, 'kw');

    expect(aggregate.points.map((point) => point.medianKw)).toEqual([9]);
    expect(aggregate.minContributingSites).toBe(1);
  });
});

/*
 * The %-of-capacity arm. Every fleet below has two sites of *different* capacity, because that is
 * the only fleet on which the exact per-hour divisor and the tempting "fleet capacity × share of
 * sites reporting" proxy disagree: on same-sized sites the two are equal at every hour, and a suite
 * built on one would pass against either rule. The partial hours are where the whole feature lives.
 */
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
  fleetChartAggregate(forecasts, readings, twoSizeFleet, 'percent').points;

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
describe('minimumContributingSites', () => {
  it('answers 0 for an empty series rather than a number no caller could render', () => {
    expect(minimumContributingSites([])).toBe(0);
  });

  it('reports the thinnest hour, not the first or the last', () => {
    expect(
      minimumContributingSites([
        { validTime: timestamp(6), acPowerKw: 6, contributingSiteCount: 3 },
        { validTime: timestamp(7), acPowerKw: 2, contributingSiteCount: 1 },
        { validTime: timestamp(8), acPowerKw: 5, contributingSiteCount: 2 },
      ]),
    ).toBe(1);
  });

  it('equals the fleet size when every hour has every site', () => {
    expect(
      minimumContributingSites([
        { validTime: timestamp(6), acPowerKw: 6, contributingSiteCount: 2 },
        { validTime: timestamp(7), acPowerKw: 8, contributingSiteCount: 2 },
      ]),
    ).toBe(2);
  });
});
