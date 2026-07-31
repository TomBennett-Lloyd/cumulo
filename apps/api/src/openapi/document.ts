import type { ApiResponse } from '../http/response';

import { componentSchemas } from './components';
import type { OpenApiDocument } from './openapi-types';
import { apiPaths } from './paths';

/**
 * The OpenAPI document, assembled once at module load and served from memory.
 *
 * **No spec file exists in this repository.** The schemas come from the zod
 * objects the handlers parse with (`components.ts`), the statuses from the map
 * `errorResponse` derives status lines from, and the parameter names from the
 * router's own constants — so "the document is out of date" is not a state this
 * service can reach. What is left to review is the prose, which is the part a
 * generator cannot write.
 *
 * Built at module scope for the reason the composition root is: Lambda reuses a
 * warm container, so the conversion and the `JSON.stringify` below happen once
 * per container rather than once per request, and a document that failed to
 * build would fail *initialization* rather than one caller's GET.
 */

/**
 * There is deliberately **no `servers` block**.
 *
 * Swagger UI resolves relative URLs against the page it is served from, so "try
 * it out" hits the same origin as `/docs` — which is the whole point of ADR
 * 0005's hosting choice. A `servers` entry would have to name the gateway's
 * endpoint, and that endpoint embeds a server-assigned API id that is captured
 * from a Terraform output rather than predicted. Better absent than wrong.
 */
export const openApiDocument: OpenApiDocument = {
  // Patch version of the 3.0 line, which is what `target: 'openapi-3.0'`
  // generates schemas for: draft-4 style `exclusiveMinimum: true` flags and
  // `nullable`, neither of which is valid 3.1.
  openapi: '3.0.3',
  info: {
    title: 'Cumulo Fleet API',
    // The contract version, which is the `/v1` in the paths — not the package
    // version. A breaking change to these shapes is a `/v2`, not a bump here.
    version: '1.0.0',
    description: [
      'Read and manage the sites in a small residential solar fleet, and read the',
      'stored per-site forecasts and measured actuals.',
      '',
      '**Attribution.** Forecast data is derived from weather published by Open-Meteo',
      'under CC BY 4.0. Every response carrying forecast data carries an `attribution`',
      'object with the exact credit; it must be displayed wherever the data is.',
      '',
      '**This API makes no upstream weather calls.** Every endpoint reads rows that the',
      'ingestion and forecast services already stored, so no amount of traffic here can',
      "spend the fleet's third-party API budget.",
      '',
      '**Errors.** Every failure this service generates is an `ApiError` body whose',
      '`code` determines the status. A 429 is the exception — it comes from the API',
      "Gateway stage throttle before this service is invoked and carries the gateway's",
      'own body, so map on the status code rather than on the body.',
    ].join('\n'),
  },
  paths: apiPaths,
  components: { schemas: componentSchemas },
};

/**
 * Serialised once, beside the document it serialises: the bytes are constant
 * for the life of the container, and re-stringifying a few hundred kilobytes on
 * every `/docs` page load would be work with no possible new answer.
 */
const openApiDocumentJson = JSON.stringify(openApiDocument);

/**
 * `GET /openapi.json`.
 *
 * Not routed through `jsonResponse`: that helper's job is to parse a body
 * through the zod schema that describes it, and this body *is* the schema
 * catalogue. `document.test.ts` checks its structural invariants instead, and
 * `swagger-cli validate` checks it against the OpenAPI meta-schema.
 */
export const openApiDocumentResponse = (): ApiResponse => ({
  statusCode: 200,
  headers: {
    'content-type': 'application/json',
    // Same reasoning as the `/docs` page: no CDN in front, and a stale copy
    // would describe an API that is no longer the one answering.
    'cache-control': 'no-cache',
  },
  body: openApiDocumentJson,
});
