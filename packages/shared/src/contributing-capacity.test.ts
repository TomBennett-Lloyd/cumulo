import { describe, expect, it } from 'vitest';

import { contributingCapacityKwByHour } from './aggregation';
import type { SiteHourEntry } from './aggregation';
import { forecastSchema } from './forecast';
import { generationReadingSchema } from './generation-reading';
import * as packageSurface from './index';
import { siteSchema } from './site';
import type { Site } from './site';
import { utcIsoTimestampSchema } from './timestamp';

/*
 * `contributingCapacityKwByHour`'s own file rather than a fifth suite in `aggregation.test.ts`, on
 * `fleet-centroid.test.ts`'s precedent and for its reason: that file sits within a couple of dozen
 * lines of the 300-code-line ceiling (`structure.md` rule 4, lint-enforced) and this suite does not
 * fit in the remainder. The cut is by subject — the sibling files cover the time-series sums, the
 * fleet capacity total and the fleet's geography; this one covers the per-hour divisor. All three
 * are colocated with `aggregation.ts`, which is what `testing.md` rule 6 asks for.
 */

const siteA = '11111111-1111-4111-8111-111111111111';
const siteB = '22222222-2222-4222-8222-222222222222';
const absentSite = '99999999-9999-4999-8999-999999999999';

const noon = utcIsoTimestampSchema.parse('2026-07-30T12:00:00Z');
const onePm = utcIsoTimestampSchema.parse('2026-07-30T13:00:00Z');

/**
 * The minimal contract the function declares. Built directly rather than via a domain schema so the
 * suite proves the published signature, not one caller's richer shape — the two real shapes get
 * their own test below.
 */
const buildEntry = (siteId: string, validTime: string): SiteHourEntry => ({
  siteId,
  validTime: utcIsoTimestampSchema.parse(validTime),
});

/**
 * Capacity is the only field the divisor reads, so it is the only one that varies. Parsed rather
 * than hand-built so a fixture can never carry a capacity `siteSchema` would refuse.
 */
const buildSite = (siteId: string, capacityKw: number): Site =>
  siteSchema.parse({
    id: siteId,
    name: `Site ${siteId.slice(0, 4)}`,
    latitude: 53.35,
    longitude: -6.26,
    tiltDegrees: 35,
    azimuthDegrees: 180,
    capacityKw,
  });

describe('contributingCapacityKwByHour', () => {
  it('answers an empty map for no entries rather than an hour with no capacity', () => {
    expect(contributingCapacityKwByHour([], [buildSite(siteA, 4)]).size).toBe(0);
  });

  it('divides a single-site fleet by that one site every hour it reports', () => {
    const capacity = contributingCapacityKwByHour(
      [buildEntry(siteA, '2026-07-30T12:00:00Z'), buildEntry(siteA, '2026-07-30T13:00:00Z')],
      [buildSite(siteA, 4)],
    );

    expect(capacity.get(noon)).toBe(4);
    expect(capacity.get(onePm)).toBe(4);
  });

  it("answers a partial hour with the contributing sites' capacity, not the fleet's", () => {
    // The reason this function exists rather than the `fleetCapacityKw × count / siteCount` proxy.
    // Two sites of 4 kW and 6 kW; at noon both report, at 1pm only the 4 kW one does. The fleet
    // total is 10 kW at both hours and the proxy's mean-capacity answer at 1pm is 5 kW — neither is
    // the capacity actually behind the 1pm reading, which is 4 kW.
    const capacity = contributingCapacityKwByHour(
      [
        buildEntry(siteA, '2026-07-30T12:00:00Z'),
        buildEntry(siteB, '2026-07-30T12:00:00Z'),
        buildEntry(siteA, '2026-07-30T13:00:00Z'),
      ],
      [buildSite(siteA, 4), buildSite(siteB, 6)],
    );

    expect(capacity.get(noon)).toBe(10);
    expect(capacity.get(onePm)).toBe(4);
  });

  it('counts a site once for an hour it reported twice', () => {
    // Duplicates collapse on the same rule as the kW sums, so an hour's divisor and its numerator
    // are always drawn from the same set of sites. Counting twice would answer 8 and halve the %.
    const capacity = contributingCapacityKwByHour(
      [buildEntry(siteA, '2026-07-30T12:00:00Z'), buildEntry(siteA, '2026-07-30T12:00:00Z')],
      [buildSite(siteA, 4)],
    );

    expect(capacity.get(noon)).toBe(4);
  });

  it('contributes nothing for an entry whose site is not in the fleet', () => {
    // Capacity that cannot be evidenced is not asserted: the unknown site adds 0 rather than a
    // guessed average, so the hour is still keyed but reads only the capacity that is known.
    const capacity = contributingCapacityKwByHour(
      [buildEntry(siteA, '2026-07-30T12:00:00Z'), buildEntry(absentSite, '2026-07-30T12:00:00Z')],
      [buildSite(siteA, 4)],
    );

    expect(capacity.get(noon)).toBe(4);
  });

  it('leaves an hour no site reported out of the map entirely', () => {
    const capacity = contributingCapacityKwByHour(
      [buildEntry(siteA, '2026-07-30T12:00:00Z')],
      [buildSite(siteA, 4), buildSite(siteB, 6)],
    );

    expect(capacity.has(onePm)).toBe(false);
  });

  it('takes real forecasts and real readings alike, the two series the fleet panel divides', () => {
    // Both browser-side aggregations feed this divisor, so both domain shapes must satisfy the
    // published entry contract — proved by calling, not by an assertion about types.
    const forecast = forecastSchema.parse({
      siteId: siteA,
      model: 'physics',
      validTime: '2026-07-30T12:00:00Z',
      issuedAt: '2026-07-30T06:00:00Z',
      weatherSource: 'open-meteo',
      poaIrradianceWm2: 0,
      acPowerKw: 2.5,
    });
    const reading = generationReadingSchema.parse({
      siteId: siteB,
      validTime: '2026-07-30T12:00:00Z',
      acPowerKw: 3.5,
    });
    const sites = [buildSite(siteA, 4), buildSite(siteB, 6)];

    expect(contributingCapacityKwByHour([forecast], sites).get(noon)).toBe(4);
    expect(contributingCapacityKwByHour([reading], sites).get(noon)).toBe(6);
  });
});

describe('@cumulo/shared surface', () => {
  it('exports the per-hour contributing capacity', () => {
    expect(packageSurface.contributingCapacityKwByHour).toBe(contributingCapacityKwByHour);
  });
});
