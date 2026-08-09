import { docsAssetParamName, docsAssetContentTypes } from './docs-assets';
import type { ContentObject, PathsObject } from './openapi-types';
import { commonFailures, errorResponses, jsonContent } from './responses';

/**
 * The three operations by which this API describes itself: the document, the
 * page that renders it, and that page's assets.
 *
 * Split out of `paths.ts` when the fleet forecast entry took that file past the
 * 300-line ceiling (`docs/standards/structure.md` rule 4), and split along
 * *this* seam because it is one the code already draws: `main.ts` groups the
 * same three routes under a comment of their own, they are the only operations
 * that answer with something other than this API's domain JSON, and a reader
 * asking what the Fleet API serves never needs them. The alternative cut —
 * splitting the domain operations by resource — would have divided the table a
 * reader actually reads.
 *
 * `paths.ts` spreads {@link docsPaths} at the end of `apiPaths`, so the
 * document's path order is exactly what it was before the move: the domain
 * routes, then these.
 */

/** `text/css` and friends, as the 200 of the asset route. */
const docsAssetContent: ContentObject = Object.fromEntries(
  docsAssetContentTypes.map((contentType) => [contentType, { schema: { type: 'string' } }]),
);

export const docsPaths: PathsObject = {
  '/openapi.json': {
    get: {
      operationId: 'getOpenApiDocument',
      summary: 'This document',
      description: [
        'The OpenAPI 3.0 document, generated at start-up from the same zod schemas the',
        'handlers validate against. There is no spec file in the repository to drift.',
      ].join(' '),
      responses: {
        '200': { description: 'The OpenAPI document.', content: jsonContent({ type: 'object' }) },
        ...commonFailures,
      },
    },
  },
  '/docs': {
    get: {
      operationId: 'getDocsPage',
      summary: 'Swagger UI',
      description: [
        'The API reference, served from this same Lambda with version-pinned assets',
        'bundled into its deployment artifact (ADR 0005). Same origin as the API, so',
        '"try it out" issues real requests with no CORS negotiation.',
      ].join(' '),
      responses: {
        '200': {
          description: 'The Swagger UI page.',
          content: { 'text/html': { schema: { type: 'string' } } },
        },
        ...commonFailures,
      },
    },
  },
  '/docs/{asset}': {
    get: {
      operationId: 'getDocsAsset',
      summary: 'A Swagger UI asset',
      description: [
        'Serves one file from a fixed allowlist of bundled Swagger UI assets. The name',
        'is matched against that allowlist and never used to build a path, so there is no',
        'traversal to defend against; anything not on the list is a 404.',
      ].join(' '),
      parameters: [
        {
          name: docsAssetParamName,
          in: 'path',
          required: true,
          description: 'The exact file name of an allowlisted asset.',
          schema: { type: 'string' },
        },
      ],
      responses: {
        '200': { description: 'The asset.', content: docsAssetContent },
        ...errorResponses('not_found'),
        ...commonFailures,
      },
    },
  },
};
