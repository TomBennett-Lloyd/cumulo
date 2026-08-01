import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/*
 * A source contract, not a behaviour test — the same shape, and for the same
 * reason, as `dashboard/map-region-split-contract.test.ts`.
 *
 * What it guards is a property of the *bundle graph*: that the design-token
 * gallery reaches a browser only through `tokens.html`, and that `tokens.html`
 * is a document the production build never reads. `vite build` builds the
 * entries named in `build.rollupOptions.input`, which defaults to `index.html`
 * alone; every module under `src/preview/` is therefore reachable from the dev
 * server and from nowhere else, and the shipped app carries zero bytes of the
 * gallery — no swatch grid, no palette prose, no `preview.css`.
 *
 * No unit test can see that property. Every component under `src/preview/`
 * still renders correctly in jsdom whether it is bundle-reachable or not — so a
 * single `import { TokensPreview } from './preview/TokensPreview'` added by
 * someone reaching for a swatch, or a stray `import './preview/preview.css'` in
 * `src/main.tsx`, would fuse the gallery back into the shipped entry chunk with
 * every gate in `verify` green.
 *
 * The scan therefore covers the whole app source tree rather than the two files
 * the extraction touched, and matches on the `preview` path segment rather than
 * on any one module name, so a `../preview/ColorSwatches` spelling from
 * elsewhere in the tree counts too. `src/preview/` itself is excluded: the
 * gallery's own modules import each other, and that is the arrangement being
 * protected, not a violation of it.
 *
 * The dist-level proof of the property this stands in for is no longer a manual
 * one: CI's `web-build` job builds `apps/web` and runs
 * `.claude/scripts/check-web-bundle.sh` on every push and PR (#142), and that
 * script asserts exactly this block against the real build —
 *
 *   test ! -e apps/web/dist/tokens.html \
 *     && ! grep -rq "swatch-chip" apps/web/dist \
 *     && ! grep -rq "Direction B" apps/web/dist
 *
 * — refusing a verdict (exit 2) if either marker has stopped appearing in the
 * *non-test* source under `src/preview/`, which is the one way a grep like this
 * rots into a pass. The census skips `*.test.*` deliberately, and this file is
 * the reason: the block above quotes both markers, so a census that read test
 * files would be satisfied by this comment alone once the real emitters had been
 * renamed. This source contract remains the fast layer: it runs inside `verify`
 * without a build, and it names the offending import.
 *
 * The two markers are load-bearing and were chosen by elimination: `swatch-chip`
 * is a class emitted only by `preview.css`, and `Direction B` is palette prose
 * that appears only in `TokensPreview.tsx`. Earlier candidates were rejected as
 * vacuous — `TokensPreview` is a component name minification erases, and
 * `Meridian` survives in the shipped token comments regardless.
 *
 * Reading source off disk needs the node environment — jsdom implies Vite's web
 * transform, which rewrites `new URL(…, import.meta.url)` into a served asset
 * URL (see apps/web/vite.config.ts, where node is the app default).
 */
const SOURCE_ROOT = fileURLToPath(new URL('..', import.meta.url));

const APP_ROOT = join(SOURCE_ROOT, '..');

const HARNESS_ENTRY = join(SOURCE_ROOT, 'preview', 'main.tsx');
const HARNESS_DOCUMENT = join(APP_ROOT, 'tokens.html');
const SHIPPED_ENTRY = join(SOURCE_ROOT, 'main.tsx');
const SHIPPED_DOCUMENT = join(APP_ROOT, 'index.html');
const VITE_CONFIG = join(APP_ROOT, 'vite.config.ts');

/** Whether a path lies inside the gallery's own directory. */
const isPreviewModule = (file: string): boolean =>
  relative(SOURCE_ROOT, file).split(sep).includes('preview');

/**
 * Every module the shipped app could pull in, by path.
 *
 * Test files are excluded because they are not in the production graph: an
 * import in a `*.test.tsx` cannot put a byte into `dist/`, and refusing one
 * would block the gallery's own component tests. `src/preview/` is excluded for
 * the reason in the header — inside the gallery these imports are the design.
 */
const appSourceFiles = (): readonly string[] =>
  readdirSync(SOURCE_ROOT, { recursive: true, withFileTypes: true })
    .filter(
      (entry) => entry.isFile() && /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name),
    )
    .map((entry) => join(entry.parentPath, entry.name))
    .filter((file) => !isPreviewModule(file));

/**
 * Every `import`/`export` statement naming a path inside `preview/`, whole, in
 * source order.
 *
 * Matching the quoted path rather than a `from` clause is what makes a bare
 * side-effect import — `import './preview/preview.css';`, the CSS regression
 * this most needs to catch — count alongside value imports and re-exports.
 * `[^;]*` spans newlines, so a wrapped multi-line import is matched as one
 * statement rather than missed. Type-only imports are offenders here too: the
 * gallery exports no types worth reaching for, so one is a mistake being made
 * rather than a cost-free edge.
 */
const previewImportStatements = (source: string): readonly string[] =>
  source.match(/^(?:import|export)\b[^;]*'[^']*\/preview\/[^']*';$/gm) ?? [];

const allPreviewImports = (): readonly string[] =>
  appSourceFiles().flatMap((file) =>
    previewImportStatements(readFileSync(file, 'utf8')).map((statement) => `${file}: ${statement}`),
  );

describe('tokens harness isolation', () => {
  it('leaves no shipped module a reference to the token gallery', () => {
    expect(allPreviewImports()).toEqual([]);
  });

  it('keeps the harness wired to its own document, so the scan above is not vacuous', () => {
    // If the gallery were deleted or its entry renamed, the assertion above
    // would stay green while proving nothing. This is what makes the emptiness
    // above mean "extracted" rather than "gone".
    expect(existsSync(HARNESS_ENTRY)).toBe(true);
    expect(readFileSync(HARNESS_ENTRY, 'utf8')).toContain('TokensHarness');
    expect(readFileSync(HARNESS_DOCUMENT, 'utf8')).toContain('src/preview/main.tsx');
  });

  it('keeps the shipped entry and its document free of the gallery', () => {
    // The scan above walks import statements; this catches the same regression
    // arriving in a shape a statement match would miss — a `<script>` tag in
    // index.html, or a lazy `import('./preview/…')` inside src/main.tsx. The
    // shipped entry owns every stylesheet in the app, so it is also where a
    // returning `preview.css` would land.
    expect(readFileSync(SHIPPED_DOCUMENT, 'utf8')).not.toContain('preview');
    expect(readFileSync(SHIPPED_ENTRY, 'utf8')).not.toContain('preview');
  });

  it('never promotes the harness page into the build input', () => {
    // Naming `tokens.html` in `build.rollupOptions.input` is exactly the
    // regression this guards: it would ship the whole gallery from a two-line
    // config edit, and no gate inside `verify` would notice — CI's `web-build`
    // job would (#142), on the gallery bytes landing in dist/, but this is the
    // test that names the config line that put them there. The config mentions
    // the file nowhere today, so any mention at all is the change worth
    // stopping to look at.
    expect(readFileSync(VITE_CONFIG, 'utf8')).not.toContain('tokens.html');
  });
});
