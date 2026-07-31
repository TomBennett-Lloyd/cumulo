import { describe, expectTypeOf, it } from 'vitest';

import {
  archiveWeatherReadingSchema,
  forecastWeatherReadingSchema,
  type ArchiveWeatherReading,
  type ForecastWeatherReading,
  type WeatherReading,
} from './weather-reading';

/**
 * Type-level tests. These run under Vitest's typecheck mode (`*.test-d.ts`,
 * enabled in `vitest.config.ts`) and assert what the runtime suite in
 * `weather-reading.test.ts` structurally cannot.
 *
 * The narrowed readings exist to make one thing impossible: handing a
 * forecast-only writer an archive reading, or the reverse. That is a *compile*
 * guarantee, so every runtime test in this repo stays green if it disappears —
 * widening `ForecastWeatherReading` back to plain `WeatherReading` (the shape
 * this concept had before the definitions were unified, #91) changes no value,
 * parses no differently, and breaks no assertion anywhere. The `.not.toExtend`
 * rows below are the only thing that fails when it does.
 */
describe('the kind-narrowed weather readings', () => {
  it('are not inhabited by an arbitrary reading — the point of the narrowing', () => {
    expectTypeOf<WeatherReading>().not.toExtend<ForecastWeatherReading>();
    expectTypeOf<WeatherReading>().not.toExtend<ArchiveWeatherReading>();
  });

  it('exclude each other, so neither writer accepts the other half', () => {
    expectTypeOf<ArchiveWeatherReading>().not.toExtend<ForecastWeatherReading>();
    expectTypeOf<ForecastWeatherReading>().not.toExtend<ArchiveWeatherReading>();
  });

  it('fix `kind` to exactly one literal rather than the full axis', () => {
    expectTypeOf<ForecastWeatherReading['kind']>().toEqualTypeOf<'forecast'>();
    expectTypeOf<ArchiveWeatherReading['kind']>().toEqualTypeOf<'archive'>();
  });

  it('are each still a weather reading — narrowed, not a parallel shape', () => {
    expectTypeOf<ForecastWeatherReading>().toExtend<WeatherReading>();
    expectTypeOf<ArchiveWeatherReading>().toExtend<WeatherReading>();
  });

  it('stay tied to the schemas they are inferred from', () => {
    expectTypeOf(forecastWeatherReadingSchema.parse(null)).toEqualTypeOf<ForecastWeatherReading>();
    expectTypeOf(archiveWeatherReadingSchema.parse(null)).toEqualTypeOf<ArchiveWeatherReading>();
  });
});
