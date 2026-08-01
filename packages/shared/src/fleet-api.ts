import { z } from 'zod';

import { attributionSchema } from './attribution';
import { forecastSchema } from './forecast';
import { generationReadingSchema } from './generation-reading';
import { fleetSiteSchema } from './site';

/**
 * The response envelopes of the Fleet API's read routes.
 *
 * These are the wire contract between two apps: the Fleet API parses every body
 * through the matching schema before it reaches the wire, and the web app parses
 * what it receives back through the same object. `architecture.md` rule 1 forbids
 * `apps/web` importing from `apps/api`, and rule 2 forbids a second definition of
 * a shape both ends depend on — so the envelope a producer guarantees and the one
 * a consumer relies on are one definition, here, or they are two definitions that
 * agree only until someone edits one of them.
 *
 * Request-side validation stays in the API. `hours`, `from`/`to` and the bounds
 * they enforce are decisions about what this server is willing to read, not a
 * shape anyone else has to hold.
 */

/**
 * An object rather than a bare array. A top-level JSON array cannot grow a
 * sibling field — a cursor, a count, a partial-results flag — without breaking
 * every client, and this API expects at least one of those eventually.
 */
export const listSitesResponseSchema = z.object({
  sites: z.array(fleetSiteSchema),
});

export type ListSitesResponse = z.infer<typeof listSitesResponseSchema>;

/**
 * An object rather than a bare array, for {@link listSitesResponseSchema}'s
 * reason — a top-level array cannot grow a sibling field. Here it already has
 * one: the attribution is a peer of the data it credits, not a property repeated
 * on every point.
 */
export const siteForecastResponseSchema = z.object({
  forecasts: z.array(forecastSchema),
  attribution: attributionSchema,
});

export type SiteForecastResponse = z.infer<typeof siteForecastResponseSchema>;

/**
 * Forecasts and measured actuals over one window, as two named arrays rather
 * than one tagged list, carrying the same peer `attribution` as
 * {@link siteForecastResponseSchema}.
 */
export const siteSeriesResponseSchema = z.object({
  forecasts: z.array(forecastSchema),
  actuals: z.array(generationReadingSchema),
  attribution: attributionSchema,
});

export type SiteSeriesResponse = z.infer<typeof siteSeriesResponseSchema>;
