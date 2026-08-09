import { MAX_USER_SITES } from '@cumulo/shared';

import { DEFAULT_FLEET_LOOKBACK_HOURS } from '../forecast/get-fleet-actuals';
import {
  DEFAULT_FORECAST_HORIZON_HOURS,
  FORECAST_HORIZON_HOURS,
} from '../forecast/get-site-forecast';
import { MAX_SERIES_SPAN_HOURS } from '../forecast/get-site-series';
import { siteIdParamName } from '../sites/site-id-param';

import { componentRef } from './components';
import type { ParameterObject, PathsObject } from './openapi-types';
import { docsPaths } from './paths-docs';
import { commonFailures, componentResponse, errorResponses, jsonContent } from './responses';

/**
 * The `paths` half of the document: one entry per route in `main.ts`'s table.
 *
 * What each response *is* lives in `responses.ts` — the error vocabulary, the
 * two failures every operation shares, and the reason a 429 cannot promise one
 * body shape. This file says which operations exist and what they mean. The
 * three operations by which the API documents *itself* live in `paths-docs.ts`
 * and are spread in at the end, which is where they were before the file
 * outgrew its ceiling.
 *
 * **Names are checked.** Path parameters take their names from the router's own
 * constants (`siteIdParamName`, `docsAssetParamName`) and every schema position
 * is a `componentRef`, so a renamed parameter or component is a type error here
 * rather than a `$ref` into nothing.
 *
 * `document.test.ts` closes the remaining gap — that the set of documented
 * operations equals the set of registered routes — by walking the live route
 * table rather than a list copied into a test.
 */

const siteIdParameter: ParameterObject = {
  name: siteIdParamName,
  in: 'path',
  required: true,
  description: 'The server-assigned site id, as returned by `POST /v1/sites`.',
  schema: { type: 'string', format: 'uuid' },
};

const forecastHoursParameter: ParameterObject = {
  name: 'hours',
  in: 'query',
  required: false,
  description: [
    'How far forward to read. A closed set rather than a free integer, because each',
    'value is a read whose cost is known in advance.',
  ].join(' '),
  schema: {
    type: 'string',
    enum: [...FORECAST_HORIZON_HOURS],
    default: DEFAULT_FORECAST_HORIZON_HOURS,
  },
};

/**
 * The same closed set as the forecast horizon, read the other way: this one
 * names how far *back* the fleet read looks. One list in the code
 * (`get-site-forecast.ts` owns it) and therefore one enum here, because both
 * routes serve the same picker in the web app.
 */
const fleetLookbackHoursParameter: ParameterObject = {
  name: 'hours',
  in: 'query',
  required: false,
  description: [
    'How far back to read. A closed set rather than a free integer, because this',
    'endpoint issues one query per fleet site and the cost of each admitted value is',
    'therefore known in advance.',
  ].join(' '),
  schema: {
    type: 'string',
    enum: [...FORECAST_HORIZON_HOURS],
    default: DEFAULT_FLEET_LOOKBACK_HOURS,
  },
};

/**
 * The horizon of the fleet forecast read: {@link forecastHoursParameter}'s enum
 * and default — `get-site-forecast.ts` owns both, and this route offers exactly
 * them, because the two forecast routes serve the same picker in the web app.
 *
 * A parameter of its own rather than a reuse, for the reason
 * {@link fleetLookbackHoursParameter} is one: what a caller needs told is *why*
 * the set is closed, and the answer differs. On the per-site route the cost of
 * a horizon is one read; here it is one read per fleet site.
 */
const fleetForecastHoursParameter: ParameterObject = {
  name: 'hours',
  in: 'query',
  required: false,
  description: [
    'How far forward to read, from the current time. A closed set rather than a free',
    'integer, because this endpoint issues one query per fleet site and the cost of each',
    'admitted value is therefore known in advance.',
  ].join(' '),
  schema: {
    type: 'string',
    enum: [...FORECAST_HORIZON_HOURS],
    default: DEFAULT_FORECAST_HORIZON_HOURS,
  },
};

const seriesBoundParameter = (name: 'from' | 'to', bound: string): ParameterObject => ({
  name,
  in: 'query',
  required: true,
  description: [
    `The ${bound} of the window, as a whole-second UTC timestamp (\`2026-07-31T09:00:00Z\`).`,
    `\`from\` must be strictly before \`to\`, and the window may not exceed ${String(MAX_SERIES_SPAN_HOURS)} hours —`,
    'a bound on what one request can make this API read.',
  ].join(' '),
  schema: { type: 'string', format: 'date-time' },
});

const createSiteBody = {
  description: 'The site to add. Any `id` in the body is ignored — the server assigns one.',
  required: true,
  content: jsonContent(componentRef('CreateSiteInput')),
};

export const apiPaths: PathsObject = {
  '/v1/sites': {
    get: {
      operationId: 'listSites',
      summary: 'List the fleet',
      description: [
        'Every site, seed and user-created, active and inactive. Unpaginated by design:',
        'the fleet lives in one partition and #29 caps how many user sites can exist, so',
        '"the whole fleet" is a bounded answer.',
      ].join(' '),
      responses: {
        '200': componentResponse('The whole fleet.', 'ListSitesResponse'),
        ...commonFailures,
      },
    },
    post: {
      operationId: 'createSite',
      summary: 'Add a site to the fleet',
      description: [
        'Unauthenticated on purpose — this is the demo\'s "add a site" flow. The server',
        'assigns `id`, sets `origin` to `user`, stamps `createdAt` and marks the site',
        'active; the 201 body is the only place the caller learns the new id.',
        `At most ${String(MAX_USER_SITES)} user-created sites exist at once: a create`,
        'against a full fleet still answers 201, having evicted the oldest user site —',
        "and that site's stored series points — to make room. The seed fleet is exempt",
        'and is never evicted.',
        'Like every write here it requires an allowed `Origin` header (403 below), and it',
        'is rate-limited per address as well as by the gateway.',
      ].join(' '),
      requestBody: createSiteBody,
      responses: {
        '201': componentResponse('The site as stored, including its new id.', 'FleetSite'),
        ...errorResponses('validation_failed', 'forbidden'),
        ...commonFailures,
      },
    },
  },
  '/v1/sites/{siteId}': {
    get: {
      operationId: 'getSite',
      summary: 'Read one site',
      description: 'The stored site, or 404 if no site has that id.',
      parameters: [siteIdParameter],
      responses: {
        '200': componentResponse('The site.', 'FleetSite'),
        ...errorResponses('validation_failed', 'not_found'),
        ...commonFailures,
      },
    },
    put: {
      operationId: 'updateSite',
      summary: 'Replace one site',
      description: [
        "A full replace of the caller-settable fields; the site's `id`, `origin`,",
        '`createdAt` and `active` are preserved from the stored row. Last write wins —',
        'there is no optimistic concurrency on this endpoint. A write, so it requires an',
        'allowed `Origin` header (403 below) and is rate-limited per address.',
      ].join(' '),
      parameters: [siteIdParameter],
      requestBody: createSiteBody,
      responses: {
        '200': componentResponse('The site as stored after the replace.', 'FleetSite'),
        ...errorResponses('validation_failed', 'forbidden', 'not_found'),
        ...commonFailures,
      },
    },
    delete: {
      operationId: 'deleteSite',
      summary: 'Remove a site from the fleet',
      description: [
        "Removes the site row and, best-effort, the site's stored forecast and actual",
        'series rows. Anything the cleanup leaves behind is unreachable — every series',
        'route resolves the site first — and expires under its retention TTL. A write, so',
        'it requires an allowed `Origin` header (403 below) and is rate-limited per',
        'address.',
      ].join(' '),
      parameters: [siteIdParameter],
      responses: {
        '204': { description: 'The site is gone. No body.' },
        ...errorResponses('validation_failed', 'forbidden', 'not_found'),
        ...commonFailures,
      },
    },
  },
  '/v1/sites/{siteId}/forecast': {
    get: {
      operationId: 'getSiteForecast',
      summary: 'Forecast for one site, from now forward',
      description: [
        'Reads stored forecast points from the current time forward. **An empty',
        '`forecasts` array is a 200, not a 404**: a site created moments ago has no',
        'points until the next forecast cycle writes them, which is a fact about the',
        "fleet's schedule and not about whether the site exists. A client polling for a",
        'first forecast should treat `[]` as "keep waiting" and 404 as "stop". Every',
        'response carries the Open-Meteo attribution that must be displayed with the',
        'data; this endpoint makes no upstream weather calls of its own.',
      ].join(' '),
      parameters: [siteIdParameter, forecastHoursParameter],
      responses: {
        '200': componentResponse(
          'Forecast points for the requested horizon, possibly empty, with attribution.',
          'SiteForecastResponse',
        ),
        ...errorResponses('validation_failed', 'not_found'),
        ...commonFailures,
      },
    },
  },
  '/v1/sites/{siteId}/series': {
    get: {
      operationId: 'getSiteSeries',
      summary: 'Forecasts and actuals for one site over a window',
      description: [
        'One read of the stored series, split into the forecasts and the actuals over the',
        'same window, for plotting the two against each other. The actuals are simulated,',
        'for the reason the `GenerationReading` schema gives. An empty',
        'window is a 200 with empty arrays; only an unknown site id is a 404. Carries the',
        'Open-Meteo attribution that must be displayed with the data.',
      ].join(' '),
      parameters: [
        siteIdParameter,
        seriesBoundParameter('from', 'start'),
        seriesBoundParameter('to', 'end'),
      ],
      responses: {
        '200': componentResponse(
          'Forecasts and actuals over the window, with attribution.',
          'SiteSeriesResponse',
        ),
        ...errorResponses('validation_failed', 'not_found'),
        ...commonFailures,
      },
    },
  },
  '/v1/fleet/actuals': {
    get: {
      operationId: 'getFleetActuals',
      summary: 'Simulated actuals for every fleet site over a look-back window',
      description: [
        'Every site’s stored actuals over the same window, merged into one array, so a',
        'fleet dashboard reads the whole fleet in one request rather than one per site.',
        '**The readings are simulated.** The demo fleet has no inverters and no',
        'telemetry; each reading is synthesized from the stored physics forecast for that',
        'site and hour, and carries no marker of its own — the wire shape is the shape a',
        'real meter would fill, and this sentence is where the difference lives. An empty',
        'fleet, and a fleet whose sites have no readings yet, are both a 200 with an empty',
        '`actuals` array. The response is all or nothing: a fan-out that could not finish',
        'is a 500 rather than a fleet total quietly short a site. Carries the Open-Meteo',
        'attribution that must be displayed with the data; like every endpoint here it',
        'makes no upstream weather calls. Rate-limited per address, because its cost',
        'grows with the fleet.',
      ].join(' '),
      parameters: [fleetLookbackHoursParameter],
      responses: {
        '200': componentResponse(
          'Simulated actuals for the whole fleet over the requested window, possibly empty, with attribution.',
          'FleetActualsResponse',
        ),
        ...errorResponses('validation_failed'),
        ...commonFailures,
      },
    },
  },
  '/v1/fleet/forecast': {
    get: {
      operationId: 'getFleetForecast',
      summary: 'Forecast for every fleet site, from now forward',
      description: [
        'Every site’s stored forecast points from the current time forward, merged into',
        'one array, so a fleet dashboard reads the whole fleet in one request rather than',
        'one per site. The mirror of `GET /v1/fleet/actuals` — the same fleet over the',
        'same kind of window, read the other way; points already past belong to',
        '`GET /v1/sites/{siteId}/series` and its explicit bounds. **An empty fleet, and a',
        'fleet whose sites hold no points yet, are both a 200 with an empty `forecasts`',
        'array**: a fleet with nothing forecast for it yet is a fact about the forecast',
        'schedule rather than about whether the fleet exists, which is the distinction',
        '`GET /v1/sites/{siteId}/forecast` draws for one site. The response is all or',
        'nothing: a fan-out that could not finish is a 500 rather than a fleet total',
        'quietly short a site. Carries the Open-Meteo attribution that must be displayed',
        'with the data; like every endpoint here it makes no upstream weather calls.',
        'Rate-limited per address, because its cost grows with the fleet.',
      ].join(' '),
      parameters: [fleetForecastHoursParameter],
      responses: {
        '200': componentResponse(
          'Forecast points for the whole fleet over the requested horizon, possibly empty, with attribution.',
          'FleetForecastResponse',
        ),
        ...errorResponses('validation_failed'),
        ...commonFailures,
      },
    },
  },
  ...docsPaths,
};
