/**
 * Copy the allowlisted Swagger UI assets into `dist/swagger/`, where the bundle
 * expects them and where `zip` picks them up beside `main.mjs`.
 *
 * The list is not repeated here: this script imports the same allowlist the
 * `/docs/{asset}` route serves from, so the artifact can never ship a file no
 * route can reach, and a route can never promise a file the artifact omits.
 * Node 22 strips the types out of that `.ts` module on import, which is why
 * `docs-assets.ts` is written to import nothing at all.
 *
 * `import.meta.resolve` rather than a hand-built `node_modules` path: pnpm
 * stores the real package under `.pnpm/swagger-ui-dist@<version>/…` and links
 * it, so the only reliable way to find the installed copy is to ask the module
 * resolver — which also means this reads the *pinned, locked* version, not
 * whatever a directory listing happens to hold.
 */
import { copyFile, mkdir } from 'node:fs/promises';

import { docsAssets } from '../src/openapi/docs-assets.ts';

const packageUrl = import.meta.resolve('swagger-ui-dist/package.json');
const sourceDirectory = new URL('.', packageUrl);
const targetDirectory = new URL('../dist/swagger/', import.meta.url);

await mkdir(targetDirectory, { recursive: true });

for (const asset of docsAssets.values()) {
  await copyFile(
    new URL(asset.fileName, sourceDirectory),
    new URL(asset.fileName, targetDirectory),
  );
}

console.log(`copy-swagger-assets: ${docsAssets.size} asset(s) → dist/swagger/`);
