import { describe, expect, it } from 'vitest';

import {
  fleetRollupMembers,
  fleetRollupMembersSchema,
  fleetRollupProvenanceSchema,
} from './fleet-rollup-provenance';
import { sitePhysicsSchema, type SitePhysics } from './site';

const site = (overrides: Partial<SitePhysics> = {}): SitePhysics =>
  sitePhysicsSchema.parse({
    id: '3f2b8c1e-5d4a-4e6f-9a7b-1c2d3e4f5a6b',
    latitude: 53.3239,
    longitude: -6.2638,
    tiltDegrees: 35,
    azimuthDegrees: 180,
    capacityKw: 4.2,
    ...overrides,
  });

const RATHMINES = site({ id: '9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a', capacityKw: 3.6 });
const RANELAGH = site();

describe('fleetRollupMembers', () => {
  it('is a 16-hex digest that a stored attribute parses back into', () => {
    const members = fleetRollupMembers([RANELAGH, RATHMINES]);

    expect(members).toMatch(/^[0-9a-f]{16}$/u);
    expect(fleetRollupMembersSchema.parse(String(members))).toBe(members);
  });

  it('pins the digest of a known fleet, so a change to the hash or the tuple reddens here', () => {
    // A literal rather than a recomputation: the producer and the reader run in different
    // deployables, and an item written by one release is read by the next. Computed outside this
    // code, as FNV-1a 64 over the compact JSON of the two tuples, both in bucket `53.32,-6.26`.
    expect(fleetRollupMembers([RANELAGH, RATHMINES])).toBe('58bb8fbd38e3bfdd');
  });

  it('is the same for the same sites in any order', () => {
    expect(fleetRollupMembers([RATHMINES, RANELAGH])).toBe(
      fleetRollupMembers([RANELAGH, RATHMINES]),
    );
  });

  it('moves when a site leaves, or when one leaves and another joins the same bucket', () => {
    const before = fleetRollupMembers([RANELAGH, RATHMINES]);
    const newcomer = site({ id: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d', capacityKw: 3.6 });

    expect(fleetRollupMembers([RANELAGH])).not.toBe(before);
    expect(fleetRollupMembers([RANELAGH, newcomer])).not.toBe(before);
  });

  it.each([
    ['capacityKw', { capacityKw: 4.3 }],
    ['tiltDegrees', { tiltDegrees: 36 }],
    ['azimuthDegrees', { azimuthDegrees: 181 }],
    ['the bucket (latitude)', { latitude: 53.3339 }],
    ['the bucket (longitude)', { longitude: -6.2738 }],
  ] as const)('moves when one site’s %s changes', (_field, edit) => {
    expect(fleetRollupMembers([{ ...RANELAGH, ...edit }, RATHMINES])).not.toBe(
      fleetRollupMembers([RANELAGH, RATHMINES]),
    );
  });
});

describe('fleetRollupProvenanceSchema', () => {
  it('refuses a members value that is not a digest', () => {
    expect(() =>
      fleetRollupProvenanceSchema.parse({ members: 'abc', issuedAt: '2026-07-30T06:00:00Z' }),
    ).toThrow();
  });
});
