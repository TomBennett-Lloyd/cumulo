import type { Locator, Page } from '@playwright/test';
import { expect } from '@playwright/test';

/*
 * Reaching a site row, now that the fleet's table is folded away by default.
 *
 * The rows are behind a `<details>` disclosure since #265 — the header's search
 * is the lookup path, and sixty rows open under the chart pushed the rest of the
 * page out of sight. A closed disclosure keeps its children in the *document*,
 * which is why a count of `[data-site-id]` still passes without any of this
 * (`composition.spec.ts` measures exactly that), but it hides them from
 * everything that needs a rendered box: visibility, clicks, tabbing. So every
 * spec that presses a row has to open the table first, and doing it here rather
 * than three times over is what keeps a change to the disclosure a one-file
 * change (`structure.md` rule 7).
 *
 * This opens it the way a pointer user does. The keyboard's version of the same
 * gesture is deliberately not here: `keyboard-focus.spec.ts` tabs to the summary
 * and presses Enter as part of what that spec is *asserting*, and a helper doing
 * it for them would be the assertion answering itself.
 */

const DISCLOSURE = '.site-table';
const SUMMARY = '.site-table-summary';
const ROW = '[data-site-id]';

/**
 * Whether the fleet's disclosure is open, asked of the element itself.
 *
 * `instanceof` rather than a cast: the property only exists on a real
 * `<details>`, and a check the compiler can follow is what makes reading it safe
 * (`typing.md` rule 2). A `.site-table` that stopped being a `<details>` reads
 * as closed here and fails at the visibility assertion below, naming the row it
 * could not reach.
 */
const isOpen = async (page: Page): Promise<boolean> =>
  page
    .locator(DISCLOSURE)
    .evaluate((element) => element instanceof HTMLDetailsElement && element.open);

/**
 * Open the fleet's table and hand back its first row.
 *
 * Idempotent, because `<summary>` is a toggle: a caller that has already opened
 * it would otherwise close it again, and the row would go back out of reach
 * while the call that was supposed to reveal it reported success.
 */
export const openSiteTable = async (page: Page): Promise<Locator> => {
  // The summary arrives with the fleet — the table is not rendered at all until
  // the listing answers — so this is also where a spec waits for the fleet.
  await expect(page.locator(SUMMARY)).toBeVisible();

  if (!(await isOpen(page))) {
    await page.locator(SUMMARY).click();
  }

  const row = page.locator(ROW).first();
  await expect(row).toBeVisible();

  return row;
};
