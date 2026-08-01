import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
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
 * fused back in, so a single stray `import { MapRegion } from './MapRegion'`
 * added by someone reaching for a type would undo the split with every gate in
 * `verify` green.
 *
 * There is a dist-level ratchet behind this one now: CI's `web-build` job builds
 * `apps/web` and runs `.claude/scripts/check-web-bundle.sh` on every push and PR
 * (#142), whose entry-chunk byte budget is blown outright by the 949 kB map
 * chunk being fused back in. This contract stays as the fast layer — it runs
 * inside `verify` with no build, and it names the offending import statement
 * rather than reporting a number that went up.
 *
 * The scan therefore covers the whole app source tree rather than the two files
 * this split touched. `LazyMapRegion.tsx` is both the file that most needs
 * checking and the easiest to overlook: a static import *there* re-fuses the
 * module into the entry chunk (rollup's "dynamically imported but also
 * statically imported" case) while every assertion about the dynamic import
 * still passes. Matching by path suffix rather than by the literal
 * `'./MapRegion'` is what makes a `../dashboard/MapRegion` spelling from
 * elsewhere in the tree count too.
 *
 * These assertions fail on the code that shipped before the split, which is the
 * point (`testing.md` rule 4). Reading source off disk needs the node
 * environment — jsdom implies Vite's web transform, which rewrites `new URL(…,
 * import.meta.url)` into a served asset URL (see apps/web/vite.config.ts).
 */
const SOURCE_ROOT = fileURLToPath(new URL('..', import.meta.url));

const LAZY_MAP_REGION = join(SOURCE_ROOT, 'dashboard', 'LazyMapRegion.tsx');

/**
 * Every module the app ships, by path.
 *
 * Test files are excluded because they are not in the production graph: a
 * static import in a `*.test.tsx` cannot put a byte into `dist/`, and refusing
 * one would block a future test that legitimately renders `MapRegion` itself.
 */
const appSourceFiles = (): readonly string[] =>
  readdirSync(SOURCE_ROOT, { recursive: true, withFileTypes: true })
    .filter(
      (entry) => entry.isFile() && /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name),
    )
    .map((entry) => join(entry.parentPath, entry.name));

/**
 * Every `import`/`export … from '…/MapRegion'` statement, whole, in source
 * order.
 *
 * `[^;]*` spans newlines, so a wrapped multi-line import is matched as one
 * statement rather than missed. `export … from` is in scope because a re-export
 * is a static value edge exactly like an import.
 */
const mapRegionStatements = (source: string): readonly string[] =>
  source.match(/^(?:import|export)\b[^;]*from '[^']*\/MapRegion(?:\.tsx)?';$/gm) ?? [];

const isTypeOnly = (statement: string): boolean =>
  statement.startsWith('import type ') || statement.startsWith('export type ');

const allMapRegionStatements = (): readonly string[] =>
  appSourceFiles().flatMap((file) =>
    mapRegionStatements(readFileSync(file, 'utf8')).map((statement) => `${file}: ${statement}`),
  );

describe('map region code split', () => {
  it('leaves no shipped module a static value import of the map region', () => {
    const offenders = allMapRegionStatements().filter(
      (entry) => !isTypeOnly(entry.slice(entry.indexOf(': ') + 2)),
    );

    expect(offenders).toEqual([]);
  });

  it('scans a tree that does reference the map region, so nothing above passes by matching nothing', () => {
    // Without this, a rename the suffix match no longer recognises would turn
    // the assertion above into a test that proves nothing while staying green.
    expect(allMapRegionStatements().length).toBeGreaterThan(0);
  });

  it('reaches the map region through a dynamic import', () => {
    expect(readFileSync(LAZY_MAP_REGION, 'utf8')).toContain("import('./MapRegion')");
  });

  it('credits Open-Meteo in every shell that stands in for the map', () => {
    // `LazyMapRegion.test.tsx` proves the loading shell actually renders the
    // credit; this counts, which is what catches a *second* shell being added
    // without one. Two today: the loading placeholder and the load failure.
    // The credit is a licence obligation wherever weather-derived data renders
    // (CLAUDE.md), and a shell that quietly dropped it would be out of
    // compliance for exactly as long as the map is missing.
    const shells = readFileSync(LAZY_MAP_REGION, 'utf8').match(/className="map-view"/g) ?? [];
    const credits = readFileSync(LAZY_MAP_REGION, 'utf8').match(/<MapAttributionStrip \/>/g) ?? [];

    expect(shells.length).toBeGreaterThan(0);
    expect(credits.length).toBe(shells.length);
  });
});
