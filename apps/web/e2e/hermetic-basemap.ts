import type { Page } from '@playwright/test';

/*
 * The one network dependency the browser lane refuses to inherit.
 *
 * `basemapStyleUrl` (src/map/basemap.ts) points maplibre at OpenFreeMap's
 * hosted vector styles. Letting the lane fetch them for real would make every
 * run depend on a donation-funded, SLA-free third party being up and fast, and
 * would send traffic to it on every CI run for tiles nothing asserts on.
 *
 * What is substituted is a *response*, at the network boundary — the shape
 * `testing.md` rule 3 endorses. maplibre itself is untouched: it still resolves
 * the style URL, still constructs its WebGL context, still boots its worker,
 * still parses the style document and still lays out `.maplibregl-canvas`. Only
 * the bytes on the wire are ours. Mocking maplibre — the thing rule 3 forbids,
 * and the thing every jsdom test under `src/` is forced into — would delete
 * exactly the behaviour this lane exists to prove.
 *
 * An empty-but-valid style is deliberate over a realistic one. Zero sources and
 * zero layers means no tile, sprite or glyph request follows, so the lane is
 * hermetic in one rule rather than in a growing list of them, and no assertion
 * here depends on cartography that OpenFreeMap is free to redraw.
 */

/** Everything the basemap provider serves. Broad on purpose: one rule, no leaks. */
const OPENFREEMAP_ORIGIN_GLOB = 'https://tiles.openfreemap.org/**';

/**
 * The minimum a MapLibre style document can be and still parse: schema version
 * 8, nothing to draw. Both themes' style URLs resolve to it, so a theme switch
 * mid-test needs no second rule.
 */
const EMPTY_STYLE = { version: 8, sources: {}, layers: [] };

/**
 * Serve the basemap style from memory for the rest of `page`'s life.
 *
 * Call it before the first navigation — a rule installed after `goto` misses
 * the request the app has already made.
 */
export const routeBasemap = async (page: Page): Promise<void> => {
  await page.route(OPENFREEMAP_ORIGIN_GLOB, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(EMPTY_STYLE),
    }),
  );
};
