import { z } from 'zod';

import { forecastWeatherReadingSchema } from './weather-reading';

/**
 * The body of one `cumulo-weather-readings-<env>` message: ADR 0004's wire
 * contract between ingestion and the forecast service.
 *
 * One message is **one location's whole horizon** — ingestion sends a single
 * `SendMessage` per location per cycle rather than one per hour, so the consumer
 * can fan a location's readings out across every site at that location without
 * reassembling anything.
 *
 * Two narrowings carry meaning rather than convenience:
 *
 * - `forecastWeatherReadingSchema`, not the unnarrowed reading. The queue exists
 *   to trigger *forecasting*, and an archive reading arriving on it would mean
 *   the hindcast harness had been wired into the live path — a mistake worth a
 *   rejected message rather than a forecast row nobody can explain.
 * - `.min(1)`. The publisher already refuses to send an empty batch, because a
 *   message that says nothing is a no-op that looks like success; encoding that
 *   refusal in the schema is what makes it a property of the contract instead of
 *   a property of one implementation of the sender.
 *
 * It lives in `@cumulo/shared` because both ends parse it and neither app may
 * import the other (`architecture.md` rules 1 and 2): a wire format defined
 * twice is two definitions that currently agree.
 */
export const weatherMessageSchema = z.array(forecastWeatherReadingSchema).min(1);

export type WeatherMessage = z.infer<typeof weatherMessageSchema>;
