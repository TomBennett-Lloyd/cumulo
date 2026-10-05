import {
  canonicalFleetSeed,
  fleetForecastAggregate,
  forecastSchema,
  generateFleet,
  utcIsoTimestampSchema,
  type Forecast,
  type UncertaintyBand,
  type UtcIsoTimestamp,
} from '@cumulo/shared';
import { describe, expect, it } from 'vitest';

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
          contributingCapacityKw: 10,
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
        {
          validTime: timestamp(6),
          acPowerKw: 6,
          contributingSiteCount: 2,
          contributingCapacityKw: 10,
        },
        {
          validTime: timestamp(7),
          acPowerKw: 8,
          contributingSiteCount: 2,
          contributingCapacityKw: 10,
        },
      ],
      [{ validTime: timestamp(6), acPowerKw: 5, contributingSiteCount: 2 }],
    );

    expect(joined.map((point) => point.actualKw)).toEqual([5, null]);
  });

  it('omits the band key entirely for an hour with no uncertainty', () => {
    const joined = joinFleetSeries(
      [
        {
          validTime: timestamp(6),
          acPowerKw: 6,
          contributingSiteCount: 2,
          contributingCapacityKw: 10,
        },
      ],
      [],
    );

    expect(joined.filter((point) => 'band' in point)).toEqual([]);
  });

  it('keeps a measurement whose hour has no forecast, and orders it before the forecast hours', () => {
    const joined = joinFleetSeries(
      [
        {
          validTime: timestamp(6),
          acPowerKw: 6,
          contributingSiteCount: 2,
          contributingCapacityKw: 10,
        },
      ],
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
          contributingCapacityKw: 10,
        },
        {
          validTime: timestamp(13),
          acPowerKw: 7,
          uncertainty: band(5, 9),
          contributingSiteCount: 2,
          contributingCapacityKw: 10,
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
      fleetForecastAggregate(
        [forecastAt(2, 0, '2026-12-21'), forecastAt(12, 9, '2026-12-21')],
        demoFleet,
      ),
      [],
      demoFleet,
      'kw',
    );

    expect(aggregate.points.map((point) => point.night)).toEqual([true, false]);
  });

  it('flags every point, so an unflagged point means the flag was never threaded', () => {
    const aggregate = fleetChartAggregate(
      fleetForecastAggregate(
        [forecastAt(2, 0, '2026-12-21'), forecastAt(12, 9, '2026-12-21')],
        demoFleet,
      ),
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
      fleetForecastAggregate([forecastAt(2, 0, '2026-12-21'), forecastAt(12, 9, '2026-12-21')], []),
      [],
      [],
      'kw',
    );

    expect(aggregate.points.map((point) => point.night)).toEqual([false, false]);
  });

  it('leaves the kilowatts and the completeness count untouched by the night layer', () => {
    const aggregate = fleetChartAggregate(
      fleetForecastAggregate([forecastAt(12, 9, '2026-12-21')], demoFleet),
      [],
      demoFleet,
      'kw',
    );

    expect(aggregate.points.map((point) => point.medianKw)).toEqual([9]);
    expect(aggregate.minContributingSites).toBe(1);
  });
});

describe('minimumContributingSites', () => {
  it('answers 0 for an empty series rather than a number no caller could render', () => {
    expect(minimumContributingSites([])).toBe(0);
  });

  it('reports the thinnest hour, not the first or the last', () => {
    expect(
      minimumContributingSites([
        {
          validTime: timestamp(6),
          acPowerKw: 6,
          contributingSiteCount: 3,
          contributingCapacityKw: 10,
        },
        {
          validTime: timestamp(7),
          acPowerKw: 2,
          contributingSiteCount: 1,
          contributingCapacityKw: 10,
        },
        {
          validTime: timestamp(8),
          acPowerKw: 5,
          contributingSiteCount: 2,
          contributingCapacityKw: 10,
        },
      ]),
    ).toBe(1);
  });

  it('equals the fleet size when every hour has every site', () => {
    expect(
      minimumContributingSites([
        {
          validTime: timestamp(6),
          acPowerKw: 6,
          contributingSiteCount: 2,
          contributingCapacityKw: 10,
        },
        {
          validTime: timestamp(7),
          acPowerKw: 8,
          contributingSiteCount: 2,
          contributingCapacityKw: 10,
        },
      ]),
    ).toBe(2);
  });
});
