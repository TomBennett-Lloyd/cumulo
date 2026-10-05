import { expect, test } from '@playwright/test';

import { PROBE_BASE_PATH } from './base-path-preview';
import { ICON_LINKS, fetchLinkedIcon } from './head-icons';
import { routeBasemap } from './hermetic-basemap';

/*
 * The app as GitHub Pages serves it: from a path, not from a domain root.
 *
 * `.github/workflows/deploy-pages.yml` builds with a `--base` flag, which makes
 * Vite rewrite every root-absolute URL it owns in `apps/web/index.html` — the
 * three icon hrefs, the entry module's `src`, and every chunk URL the entry
 * imports — to sit under that path. Everything else in this lane previews at
 * `/`, where those URLs are correct however the build behaved, so the rewrite
 * was the one transformation the deployed site depends on and no spec could
 * fail on: a regression in it ships a 404 on every icon with the lane green
 * (#541). This file is the lane's only case against the based build, and
 * `playwright.config.ts`'s `chromium-base-path` project is what points it at
 * the server serving one.
 *
 * Both directions are asserted, because the head carries URLs of both kinds and
 * the failure is symmetric. The icon hrefs and the module `src` *must* move
 * under the base or they 404; `og:url` and `og:image` must *not*, because a
 * scraper does not resolve a relative URL against the page it came from. Those
 * two are spared for different reasons — Vite's HTML asset table includes
 * `og:image` content and excludes external absolute URLs from the rewrite,
 * while `og:url` is not in the table at all — and `apps/web/index.html`'s
 * comment beside them owns the mechanism. Asserting both anyway costs one line and is what
 * would catch the table gaining an entry.
 *
 * Nothing here asserts a *value*: not the deploy's base path, which
 * `base-path-preview.ts` explains it is deliberately not using, and not the
 * interim Pages origin, which `.github/workflows/deploy-pages.yml`'s header
 * owns and `branding-head.spec.ts` already declines to copy for the same
 * reason. Every claim below is a relation between the base the build was given
 * and what the build then emitted.
 *
 * Residual, and the reason this is not the whole of #541's deploy half: the
 * gate watches Vite's rewrite, not the workflow's invocation of it. The
 * `pnpm run build -- --base=…` trap that the deploy step's own comment
 * describes — the flag landing after vite's `--` separator, exit 0, root
 * absolute URLs — happens before any of this runs, and nothing here or
 * anywhere else would fail on it.
 */

/** Everything the based build must have moved under `PROBE_BASE_PATH`. */
const ENTRY_MODULE_SCRIPT = 'script[type="module"][src]';

/** What a scraper must still be handed verbatim, base or no base. */
const ABSOLUTE_SOCIAL_META = ['meta[property="og:url"]', 'meta[property="og:image"]'];

test.beforeEach(async ({ page }) => {
  await routeBasemap(page);
  await page.goto(PROBE_BASE_PATH);
});

test('serves every head icon from under the base the build was given', async ({ page }) => {
  for (const selector of ICON_LINKS) {
    const icon = await fetchLinkedIcon(page, selector);

    expect(
      icon.href.startsWith(PROBE_BASE_PATH),
      `\`${selector}\` points at \`${icon.href}\`, which the build never moved under \`${PROBE_BASE_PATH}\`.`,
    ).toBe(true);

    /*
     * The fetch is the half that speaks in the deploy's own terms. A prefix
     * says the rewrite happened; a 200 says the file is reachable at the URL
     * the rewrite produced, which is exactly the "live 404 on every icon" this
     * spec exists to make impossible.
     */
    expect(icon.status, `\`${icon.href}\` did not serve under the base path.`).toBe(200);
  }
});

test('boots the whole app from under the base path', async ({ page }) => {
  const script = page.locator(ENTRY_MODULE_SCRIPT);

  await expect(script, 'The head declares no entry module script.').toHaveCount(1);

  // `?? ''` rather than a throw: an attribute the selector required cannot be
  // absent, and an empty string fails the assertion below with the same message
  // a wrong one would.
  const src = (await script.getAttribute('src')) ?? '';

  expect(
    src.startsWith(PROBE_BASE_PATH),
    `The entry module's src is \`${src}\`, not under \`${PROBE_BASE_PATH}\`.`,
  ).toBe(true);

  /*
   * And then the claim no assertion over the emitted document can make. The map
   * canvas exists only if the entry executed, requested the lazily imported map
   * chunk at a URL Vite rewrote the same way, got it, and handed maplibre a GL
   * context — so one visible element covers the static graph, the dynamic one
   * and the app's own behaviour under a non-root base. Any root-absolute path
   * built in `src/` rather than emitted by Vite fails here and nowhere else.
   */
  await expect(page.locator('.maplibregl-canvas')).toBeVisible();
});

test('leaves the absolute social URLs exactly as the head wrote them', async ({ page }) => {
  for (const selector of ABSOLUTE_SOCIAL_META) {
    const meta = page.locator(selector);

    await expect(meta, `The head declares no \`${selector}\`.`).toHaveCount(1);

    const content = (await meta.getAttribute('content')) ?? '';

    expect(content, `\`${selector}\` must stay an absolute URL a scraper can follow.`).toMatch(
      /^https:\/\//,
    );
    expect(content, `\`${selector}\` was rewritten under the build's base path.`).not.toContain(
      PROBE_BASE_PATH,
    );
  }
});
