import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/*
 * A source contract, not a behaviour test, and deliberately so.
 *
 * maplibre v6 resolves its worker from its own `import.meta.url` unless told
 * otherwise. Under Vite that address points into `node_modules/.vite/deps/`,
 * where the worker file does not exist: the request hangs, no tile is ever
 * requested, and the map renders as a black rectangle. No jsdom test can catch
 * that: jsdom has no WebGL and no worker pipeline, so none reaches the failure,
 * and a mocked maplibre would only prove the mock was called (testing.md
 * rule 3). The defect is visible in a browser and nowhere else, which is why
 * the browser lane is its second observer — `e2e/composition.spec.ts` waits for
 * a laid-out WebGL canvas against the built app (testing.md rule 10). This file
 * stays as the cheap first line in front of it: a mechanical check on the
 * source, biting in `verify` with no build and no browser binary.
 *
 * It fails on the code that shipped before this fix, which is the point
 * (testing.md rule 4). Reading the file off disk needs the node environment —
 * jsdom implies Vite's web transform, which rewrites `new URL(…,
 * import.meta.url)` into a served asset URL (see apps/web/vite.config.ts).
 */
const mapViewSource = readFileSync(
  fileURLToPath(new URL('./MapView.tsx', import.meta.url)),
  'utf8',
);

describe('map worker wiring', () => {
  it('hands maplibre an explicit worker URL', () => {
    expect(mapViewSource).toContain('setWorkerUrl(workerUrl)');
  });

  it('takes that URL from Vite\'s worker pipeline, not a plain "?url" import', () => {
    // `?url` emits the worker verbatim, without the sibling
    // `maplibre-gl-shared.mjs` it imports — which fails in production builds
    // only, the worst place to discover it.
    expect(mapViewSource).toContain(
      "import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'",
    );
  });
});
