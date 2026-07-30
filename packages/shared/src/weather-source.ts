import { z } from 'zod';

/**
 * Provenance of a piece of weather-derived data.
 *
 * This is not decoration: Open-Meteo is CC BY 4.0, so attribution is mandatory
 * wherever weather-derived data is displayed — a visible "Weather data by
 * Open-Meteo.com" link. Carrying the source on the data itself is what lets the
 * UI render the right credit rather than assuming one.
 *
 * A single enum, rather than a free-form string, means adding a provider is a
 * one-place change: extend the enum and every consumer fails to compile until it
 * handles the new source (and its attribution).
 */
export const weatherSourceSchema = z.enum(['open-meteo']);

export type WeatherSource = z.infer<typeof weatherSourceSchema>;
