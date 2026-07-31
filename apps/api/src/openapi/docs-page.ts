import { readFile } from 'node:fs/promises';

import { errorResponse, type ApiResponse } from '../http/response';
import type { RouteRequest } from '../http/router';

import { docsAssetParamName, docsAssets, type DocsAsset } from './docs-assets';

/**
 * The `/docs` page and the assets it loads.
 *
 * ADR 0005 chose this shape over an S3 site and over a CDN `<script src>`: the
 * page, the assets, the OpenAPI document and the API itself are one artifact
 * with one lifecycle, served from one origin. Same origin is what makes "try it
 * out" work with no CORS negotiation on the demo's showpiece interaction; one
 * artifact is what makes it impossible to deploy a page that describes an API
 * that is not running yet; and a pinned dependency in `pnpm-lock.yaml` is what
 * keeps the assets inside the supply-chain gates this repo already has, which a
 * `<script src="https://unpkg.com/…">` would sit entirely outside.
 *
 * The assets are read from disk at request time rather than bundled into the
 * JavaScript, because 1.5 MB of Swagger UI inlined as a string is 1.5 MB parsed
 * on every cold start of a service whose other nine routes never touch it.
 */

/**
 * The page, as a constant.
 *
 * It carries the Open-Meteo credit in a `<footer>` because CLAUDE.md's
 * attribution constraint is about *display*, and this page displays
 * weather-derived data the moment a reviewer presses "try it out" on the
 * forecast endpoint. No colours, sizes or spacing values appear here: the
 * frontend gate reserves those for design tokens, which a page served by a
 * Lambda has no access to, so the page is Swagger UI's own stylesheet plus
 * semantic HTML and nothing else.
 *
 * Every URL below is served by the `/docs/{asset}` route from the allowlist in
 * `docs-assets.ts`; `docs-page.test.ts` asserts that, so a reference to an
 * asset nobody ships fails a test rather than a page load.
 */
const docsPageHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Cumulo Fleet API — reference</title>
    <link rel="icon" type="image/png" sizes="32x32" href="/docs/favicon-32x32.png" />
    <link rel="stylesheet" href="/docs/swagger-ui.css" />
  </head>
  <body>
    <div id="swagger-ui"></div>
    <footer>
      <p>
        Weather data by
        <a href="https://open-meteo.com/" rel="noopener noreferrer">Open-Meteo.com</a>,
        licensed CC BY 4.0. Forecast responses from this API carry the same credit in
        their payload; display it wherever you display the data.
      </p>
    </footer>
    <script src="/docs/swagger-ui-bundle.js"></script>
    <script>
      window.ui = SwaggerUIBundle({
        url: '/openapi.json',
        dom_id: '#swagger-ui',
        presets: [SwaggerUIBundle.presets.apis],
        deepLinking: true,
        tryItOutEnabled: true,
      });
    </script>
  </body>
</html>
`;

/**
 * `no-cache` on the page and on `/openapi.json`, an hour on the assets.
 *
 * There is no CDN in front of this Lambda (ADR 0005), so these headers are the
 * whole caching story. The split is by what a deploy can change: the assets are
 * pinned to a `swagger-ui-dist` version, so an hour-old copy is the same bytes,
 * while the page and the document change with every deploy and a stale copy
 * would describe an API that is no longer running.
 */
const assetCacheControl = 'public, max-age=3600';

export const docsPageCacheControl = 'no-cache';

export const docsPageResponse = (): ApiResponse => ({
  statusCode: 200,
  headers: {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': docsPageCacheControl,
  },
  body: docsPageHtml,
});

export interface DocsAssetDeps {
  /**
   * The directory the allowlisted files are read from, as a URL ending in `/`
   * so `new URL(fileName, …)` resolves inside it.
   *
   * A dependency rather than a constant, because the answer differs by where
   * this code is running: `dist/swagger/` next to the bundle in Lambda, the
   * installed `swagger-ui-dist` package under test. The composition root picks
   * (`docs/standards/architecture.md` rule 3); this module reads.
   */
  readonly assetDirectory: URL;
}

const assetContentType = (asset: DocsAsset): string =>
  asset.binary ? asset.mediaType : `${asset.mediaType}; charset=utf-8`;

/**
 * Serve one allowlisted asset.
 *
 * The lookup *is* the validation: an unknown name never becomes a path, so the
 * 404 below covers traversal attempts, source maps, and typos with the same
 * line of code and no string handling to get wrong.
 *
 * A read that fails after a hit is deliberately **not** caught. It means the
 * artifact was built without an asset the allowlist promises — a broken
 * deployment, not a request the caller got wrong — so it belongs to the
 * boundary in `main.ts` as a 500 with the detail in the log
 * (`docs/standards/error-handling.md` rules 1 and 2c).
 */
export const serveDocsAsset = async (
  deps: DocsAssetDeps,
  request: RouteRequest,
): Promise<ApiResponse> => {
  const asset = docsAssets.get(request.params[docsAssetParamName] ?? '');
  if (asset === undefined) {
    return errorResponse('not_found', 'no documentation asset is served under that name');
  }

  const bytes = await readFile(new URL(asset.fileName, deps.assetDirectory));

  return {
    statusCode: 200,
    headers: {
      'content-type': assetContentType(asset),
      'cache-control': assetCacheControl,
    },
    body: bytes.toString(asset.binary ? 'base64' : 'utf8'),
    isBase64Encoded: asset.binary,
  };
};
