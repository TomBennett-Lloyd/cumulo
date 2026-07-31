/**
 * The exact-filename allowlist of Swagger UI assets this service will serve.
 *
 * **This is the security boundary of the `/docs/{asset}` route, and it is one
 * by construction.** The name in the path is used as a *key into this map* and
 * never as a path segment, so `../../etc/passwd`, `..%2fmain.mjs` and
 * `swagger-ui-bundle.js.map` are all the same kind of nothing: a miss. There is
 * no normalization to get right, no prefix check to get wrong, and no way to
 * reach a file that is not named below.
 *
 * It is also the **build manifest**: `scripts/copy-swagger-assets.mjs` imports
 * this module directly (Node strips the types) and copies exactly these files
 * into `dist/swagger/`. One list, so a fourth asset added to the page cannot be
 * one the artifact ships without, and a file the artifact ships cannot be one
 * no route can reach.
 *
 * That dual use is why this module imports **nothing**: the build script runs
 * before any bundling and outside any TypeScript toolchain, so anything reached
 * from here would have to resolve under bare Node.
 */

export interface DocsAsset {
  /** The file name inside the asset directory. Identical to the key, and used to build the path. */
  readonly fileName: string;
  /** The media type, without parameters — `text/css`, not `text/css; charset=utf-8`. */
  readonly mediaType: string;
  /**
   * Whether the bytes need base64 encoding on the way out. API Gateway hands
   * a base64 body back as the original bytes when `isBase64Encoded` is set;
   * text assets skip the 4/3 inflation and go out as themselves.
   */
  readonly binary: boolean;
}

/** The name the route table captures the asset name under, shared by pattern and lookup. */
export const docsAssetParamName = 'asset';

/**
 * A `Map` rather than an object literal, deliberately: `assets['constructor']`
 * on a plain object is a truthy hit on `Object.prototype`, and the shape of
 * this lookup is "a name from an untrusted URL". `Map.get` has no prototype to
 * walk into.
 *
 * Three files, which is what a working Swagger UI needs: the stylesheet, the
 * bundle that renders it, and a favicon (the one binary asset, so the encoding
 * path below is exercised by the page itself rather than only by a test).
 * `swagger-ui-standalone-preset.js` is deliberately absent — it draws the topbar
 * URL selector, which this page does not use.
 */
export const docsAssets: ReadonlyMap<string, DocsAsset> = new Map([
  ['swagger-ui.css', { fileName: 'swagger-ui.css', mediaType: 'text/css', binary: false }],
  [
    'swagger-ui-bundle.js',
    { fileName: 'swagger-ui-bundle.js', mediaType: 'text/javascript', binary: false },
  ],
  ['favicon-32x32.png', { fileName: 'favicon-32x32.png', mediaType: 'image/png', binary: true }],
]);

/** The distinct media types the asset route can answer with, for the OpenAPI document. */
export const docsAssetContentTypes: readonly string[] = [
  ...new Set([...docsAssets.values()].map((asset) => asset.mediaType)),
];
