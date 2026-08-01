import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/*
 * A source contract, not a behaviour test — the same shape, and for the same
 * reason, as `map/map-worker-contract.test.ts`.
 *
 * What it guards is a property of the *bundle graph*: that maplibre reaches the
 * browser only through `import('./MapRegion')`, so the entry chunk stays ~305 kB
 * instead of the 1,254 kB it was. No unit test can see that. Rendering
 * `Dashboard` in jsdom passes identically whether the map is lazy or statically
 * fused back in, and CI never runs `vite build`, so a single stray
 * `import { MapRegion } from './MapRegion'` added by someone reaching for a type
 * would undo the split with every other gate green.
 *
 * Both assertions fail on the code that shipped before the split, which is the
 * point (testing.md rule 4). Reading source off disk needs the node environment
 * — jsdom implies Vite's web transform, which rewrites `new URL(…,
 * import.meta.url)` into a served asset URL (see apps/web/vite.config.ts).
 */
const readSource = (fileName: string): string =>
  readFileSync(fileURLToPath(new URL(fileName, import.meta.url)), 'utf8');

const dashboardSource = readSource('./Dashboard.tsx');
const lazyMapRegionSource = readSource('./LazyMapRegion.tsx');

/** Every `import … from './MapRegion'` statement, whole, in source order. */
const mapRegionImports = (source: string): readonly string[] =>
  source.match(/^import\b[^;]*from '\.\/MapRegion';$/gm) ?? [];

describe('map region code split', () => {
  it('leaves the dashboard no static value import of the map region', () => {
    const imports = mapRegionImports(dashboardSource);

    // Asserted so the check below cannot pass by matching nothing: the
    // dashboard does still name `MapRegionComponent`, and the day it stops is
    // the day this file needs rewriting rather than quietly succeeding.
    expect(imports.length).toBeGreaterThan(0);

    for (const statement of imports) {
      expect(statement.startsWith('import type ')).toBe(true);
    }
  });

  it('reaches the map region through a dynamic import', () => {
    expect(lazyMapRegionSource).toContain("import('./MapRegion')");
  });

  it('keeps the Open-Meteo attribution visible while the map chunk loads', () => {
    // The credit is a licence obligation wherever weather-derived data renders
    // (CLAUDE.md). A fallback without it puts the app out of compliance for as
    // long as the network is slow — a window nobody would notice locally.
    expect(lazyMapRegionSource).toContain('<MapAttributionStrip />');
  });
});
