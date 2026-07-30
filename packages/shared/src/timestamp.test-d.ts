import { describe, expectTypeOf, it } from 'vitest';

import type { Forecast } from './forecast';
import type { GenerationReading } from './generation-reading';
import { utcIsoTimestampSchema, type UtcIsoTimestamp } from './timestamp';
import type { WeatherReading } from './weather-reading';

/**
 * Type-level tests. These run under Vitest's typecheck mode (`*.test-d.ts`,
 * enabled in `vitest.config.ts`) and assert properties the runtime suite in
 * `timestamp.test.ts` structurally cannot: a brand is erased at runtime, so
 * removing it changes no observable value.
 */
describe('UtcIsoTimestamp', () => {
  it('is not inhabited by an arbitrary string — the point of the brand', () => {
    expectTypeOf<string>().not.toExtend<UtcIsoTimestamp>();
  });

  it('is reachable by parsing, which is the only way in', () => {
    expectTypeOf(utcIsoTimestampSchema.parse('2026-07-30T14:00:00Z')).toExtend<UtcIsoTimestamp>();
  });
});

describe('timestamp-carrying schema fields', () => {
  it('share one brand, so an instant is interchangeable across schemas', () => {
    expectTypeOf<WeatherReading['validTime']>().toEqualTypeOf<Forecast['validTime']>();
    expectTypeOf<Forecast['validTime']>().toEqualTypeOf<Forecast['issuedAt']>();
    expectTypeOf<Forecast['issuedAt']>().toEqualTypeOf<GenerationReading['validTime']>();
    expectTypeOf<GenerationReading['validTime']>().toEqualTypeOf<UtcIsoTimestamp>();
  });
});
