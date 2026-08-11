import { describe, expect, it } from 'vitest';

import { fleetCentroid } from './aggregation';
import * as packageSurface from './index';
import type { GeoCoordinates } from './location';
import { siteSchema } from './site';
import type { Site } from './site';

/*
 * `fleetCentroid`'s own file rather than a fifth suite in `aggregation.test.ts`.
 *
 * That file sits within a few dozen lines of the 300-code-line ceiling (`structure.md` rule 4,
 * lint-enforced), and a suite covering an empty fleet, a single site, a multi-city mean and the
 * antimeridian edge does not fit inside the remainder. The cut is by subject: the sibling file
 * covers the two time-series aggregations and the capacity sum, this one covers the fleet's
 * geography. Both are colocated with `aggregation.ts`, which is what `testing.md` rule 6 asks for.
 */

const siteA = '11111111-1111-4111-8111-111111111111';
const siteB = '22222222-2222-4222-8222-222222222222';
const siteC = '33333333-3333-4333-8333-333333333333';

const dublin: GeoCoordinates = { latitude: 53.35, longitude: -6.26 };
const cork: GeoCoordinates = { latitude: 51.9, longitude: -8.48 };
const galway: GeoCoordinates = { latitude: 53.27, longitude: -9.06 };

/**
 * Coordinates are the only fields the centroid reads, so they are the only ones that vary. Parsed
 * rather than hand-built so a fixture can never carry a coordinate `siteSchema` would refuse —
 * which matters here more than elsewhere, because the antimeridian case below sits on the edge of
 * the longitude bound.
 */
const buildSiteAt = (siteId: string, coordinates: GeoCoordinates, capacityKw: number): Site =>
  siteSchema.parse({
    id: siteId,
    name: `Site ${siteId.slice(0, 4)}`,
    ...coordinates,
    tiltDegrees: 35,
    azimuthDegrees: 180,
    capacityKw,
  });

describe('fleetCentroid', () => {
  it('answers null for an empty fleet rather than inventing a point on the planet', () => {
    expect(fleetCentroid([])).toBeNull();
  });

  it('places a single-site fleet exactly at that site', () => {
    expect(fleetCentroid([buildSiteAt(siteA, dublin, 4)])).toEqual(dublin);
  });

  it('averages both axes over a fleet spread across several cities', () => {
    // Written as the arithmetic rather than as one rounded pair, so a reader can check the
    // expectation without running it. The three capacities differ by 50× on purpose: the mean is
    // unweighted, so none of them may move the answer.
    const centroid = fleetCentroid([
      buildSiteAt(siteA, dublin, 1),
      buildSiteAt(siteB, cork, 50),
      buildSiteAt(siteC, galway, 4),
    ]);

    expect(centroid?.latitude).toBeCloseTo((53.35 + 51.9 + 53.27) / 3, 10);
    expect(centroid?.longitude).toBeCloseTo((-6.26 + -8.48 + -9.06) / 3, 10);
  });

  it('averages a fleet straddling the antimeridian to the far side of the planet', () => {
    // The documented limitation of the per-axis mean, pinned so it is executable rather than only
    // written down: two sites either side of 180° answer 0°, the opposite meridian. Nothing this
    // repo builds depends on the answer being wrong here — every fleet sits inside one continental
    // span — but a future spherical mean must break this test rather than pass it quietly.
    const centroid = fleetCentroid([
      buildSiteAt(siteA, { latitude: 0, longitude: 179 }, 4),
      buildSiteAt(siteB, { latitude: 0, longitude: -179 }, 4),
    ]);

    expect(centroid).toEqual({ latitude: 0, longitude: 0 });
  });
});

describe('@cumulo/shared surface', () => {
  it('exports the fleet centroid', () => {
    expect(packageSurface.fleetCentroid).toBe(fleetCentroid);
  });
});
