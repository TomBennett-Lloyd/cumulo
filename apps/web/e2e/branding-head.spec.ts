import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';

import { PRODUCT_TAGLINE } from '../src/header/header-copy';
import { routeBasemap } from './hermetic-basemap';

/*
 * What the tab and the link preview say, on the served document.
 *
 * `index.html`'s head is the one part of the app no jsdom test can reach: vitest
 * mounts components into a document it wrote itself and never parses the entry
 * HTML at all, so a `<meta>` typo or an icon link pointing at a file that was
 * never copied into `dist/` is invisible to that lane by construction. This lane
 * builds and serves the real thing (`playwright.config.ts`), which makes two
 * distinct claims measurable here and nowhere else (`testing.md` rule 10): that
 * the head declares what it is supposed to declare, and — the half a static grep
 * over `index.html` could never make — that the files it points at are really
 * served, at the URLs and with the types a browser and a scraper need.
 *
 * The icon cases fetch rather than merely locate for exactly that reason. A
 * `<link rel="icon">` naming a missing file looks identical in the DOM to one
 * naming a present file; the difference is a 404, and it is the whole failure
 * they exist to catch, since `public/` reaching `dist/` is a build behaviour
 * rather than a source fact.
 *
 * All three icon links are queried separately, and that is not redundancy. Two
 * of them resolve to the same file, so one fetch would prove the bytes are
 * there while leaving either `<link>` free to vanish unnoticed — and
 * `index.html`'s own comment argues the head needs all three: the typed SVG for
 * engines that prefer it, the PNG `rel="icon"` for Safari, which renders no SVG
 * favicon, and `apple-touch-icon`, which accepts nothing else. A head that lost
 * a line would still serve a tab icon somewhere, which is precisely why the
 * loss needs its own assertion rather than a shared one.
 *
 * Two things here belong to other owners and are deliberately not restated:
 *
 *   * The tagline is imported from `src/header/header-copy.ts`, which owns the
 *     sentence (`architecture.md` rule 9). The head cannot import it — a
 *     `content` attribute holds no expression — so the two meta tags are
 *     genuine copies, and this file is the check that they still agree with the
 *     owner. Spelling the sentence out here instead would make the check
 *     compare two copies to each other and pass happily after an edit at the
 *     source.
 *   * The interim GitHub Pages origin in `og:url` and `og:image` is asserted by
 *     *shape*, not by value. `.github/workflows/deploy-pages.yml`'s header owns
 *     that origin and enumerates the sites carrying it; a literal here would
 *     make this spec a fourth carrier, and one the teardown that repoints the
 *     others would leave behind as a red run. The shapes still bite on what
 *     matters to a scraper: absolute, https, and — for the image — the brand
 *     raster rather than some other file.
 *
 * The `<title>` is treated the same way: the wordmark and its em-dash descriptor
 * are pinned, the descriptor's words are `index.html`'s to change. `og:title`,
 * though, is not left at its shape — the drift worth catching there is the two
 * of them disagreeing, and since both are served in this one document the
 * comparison needs no third copy of the sentence to make it.
 */

/** The typed SVG icon — the drawing, and the one browsers with dark tabs prefer. */
const SVG_ICON_LINK = 'link[rel="icon"][type="image/svg+xml"]';

/** The raster tab icon, for engines that render no SVG favicon. */
const PNG_ICON_LINK = 'link[rel="icon"][type="image/png"]';

/** The same raster again, as the home-screen icon. */
const APPLE_TOUCH_ICON_LINK = 'link[rel="apple-touch-icon"]';

/** What the head said, and what came back when it was fetched. */
interface ServedIcon {
  readonly href: string;
  readonly status: number;
  readonly contentType: string;
}

/**
 * Read a head `<link>`'s href and fetch it, over the same origin the page was
 * served from.
 *
 * `page.request` inherits the context's `baseURL`, so a root-relative href
 * resolves against the preview server rather than needing one assembled here.
 * The fetch is deliberately outside the page: an icon is not fetched by
 * navigation, and asking the browser to render one would prove the document
 * loaded rather than that the byte stream is an icon of the right type.
 */
const fetchLinkedIcon = async (page: Page, selector: string): Promise<ServedIcon> => {
  const link = page.locator(selector);

  await expect(link, `The head declares no \`${selector}\`.`).toHaveCount(1);

  const href = await link.getAttribute('href');

  if (href === null) {
    throw new Error(`\`${selector}\` carries no href to fetch.`);
  }

  const response = await page.request.get(href);

  return {
    href,
    status: response.status(),
    /*
     * Absent rather than wrong is still a failure, and `''` fails every
     * assertion below — so the default keeps the matcher reporting the content
     * type instead of reporting `undefined`.
     */
    contentType: response.headers()['content-type'] ?? '',
  };
};

test.beforeEach(async ({ page }) => {
  await routeBasemap(page);
  await page.goto('/');
});

test('titles the tab with the wordmark ahead of an em-dash descriptor', async ({ page }) => {
  await expect(page).toHaveTitle(/^Cumulo — /);
});

test('serves the SVG favicon the head points at', async ({ page }) => {
  const icon = await fetchLinkedIcon(page, SVG_ICON_LINK);

  expect(icon.status, `\`${icon.href}\` did not serve.`).toBe(200);
  expect(icon.contentType, `\`${icon.href}\` was not served as an SVG.`).toContain('svg');
});

test('serves the raster behind both of the head links that ask for one', async ({ page }) => {
  for (const selector of [PNG_ICON_LINK, APPLE_TOUCH_ICON_LINK]) {
    const icon = await fetchLinkedIcon(page, selector);

    expect(icon.status, `\`${icon.href}\` (${selector}) did not serve.`).toBe(200);
    expect(icon.contentType, `\`${icon.href}\` (${selector}) was not served as a PNG.`).toContain(
      'png',
    );
  }
});

test('describes the product to a scraper with the tagline and an absolute brand card', async ({
  page,
}) => {
  await expect(page.locator('meta[name="description"]')).toHaveAttribute(
    'content',
    PRODUCT_TAGLINE,
  );
  await expect(page.locator('meta[property="og:description"]')).toHaveAttribute(
    'content',
    PRODUCT_TAGLINE,
  );

  /*
   * The treatment, then the agreement. The shape pins what a share card should
   * lead with; the equality is the one that earns its place, because the drift
   * this file exists to catch is the tab and the card drifting apart — an edit
   * to one `content` attribute that misses the other, which every shape
   * assertion in the world stays green through. Both strings are served in this
   * document, so the comparison is between the two things that must agree
   * rather than against a third copy of the sentence kept here.
   */
  await expect(page.locator('meta[property="og:title"]')).toHaveAttribute('content', /^Cumulo — /);
  await expect(page.locator('meta[property="og:title"]')).toHaveAttribute(
    'content',
    await page.title(),
  );

  await expect(page.locator('meta[property="og:url"]')).toHaveAttribute(
    'content',
    /^https:\/\/.+\/$/,
  );
  await expect(page.locator('meta[property="og:image"]')).toHaveAttribute(
    'content',
    /^https:\/\/.+\/brand-512\.png$/,
  );

  /*
   * `summary` and not `summary_large_image`: the card's image is the 512×512
   * brand raster, and the large-image card crops a square to a 2:1 banner. A
   * designed 1200×630 card is a follow-up, and flipping this value without one
   * would ship a cropped logo.
   */
  await expect(page.locator('meta[name="twitter:card"]')).toHaveAttribute('content', 'summary');
});
