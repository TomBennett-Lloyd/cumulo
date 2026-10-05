import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';

/*
 * The head's icon links, and how to fetch what one of them points at.
 *
 * Two specs read them and assert different things about the same three
 * elements: `branding-head.spec.ts` that the served document declares all
 * three and that the bytes behind them are icons of the right type, and
 * `base-path.spec.ts` that the same three hrefs are rewritten by the build's
 * public base path and serve at the rewritten URL. The selectors live here
 * rather than in either so the two cannot drift into asserting about different
 * elements; `apps/web/index.html`'s own comment owns why the head needs all
 * three of them.
 */

/** The typed SVG icon — the drawing, and the one browsers with dark tabs prefer. */
export const SVG_ICON_LINK = 'link[rel="icon"][type="image/svg+xml"]';

/** The raster tab icon, for engines that render no SVG favicon. */
export const PNG_ICON_LINK = 'link[rel="icon"][type="image/png"]';

/** The same raster again, as the home-screen icon. */
export const APPLE_TOUCH_ICON_LINK = 'link[rel="apple-touch-icon"]';

/**
 * Every icon link the head declares, in the order `apps/web/index.html` writes
 * them — for the callers whose claim is about all of them equally. A caller
 * making a different claim per link names the three above instead.
 */
export const ICON_LINKS = [PNG_ICON_LINK, SVG_ICON_LINK, APPLE_TOUCH_ICON_LINK];

/** What the head said, and what came back when it was fetched. */
export interface ServedIcon {
  readonly href: string;
  readonly status: number;
  readonly contentType: string;
}

/**
 * Read a head `<link>`'s href and fetch it, over the same origin the page was
 * served from.
 *
 * `page.request` inherits the context's `baseURL`, so a root-absolute href
 * resolves against the preview server rather than needing one assembled here.
 * The fetch is deliberately outside the page: an icon is not fetched by
 * navigation, and asking the browser to render one would prove the document
 * loaded rather than that the byte stream is an icon of the right type.
 */
export const fetchLinkedIcon = async (page: Page, selector: string): Promise<ServedIcon> => {
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
     * assertion on it — so the default keeps the matcher reporting the content
     * type instead of reporting `undefined`.
     */
    contentType: response.headers()['content-type'] ?? '',
  };
};
