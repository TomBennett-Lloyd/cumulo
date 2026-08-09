import type { Locator, Page } from '@playwright/test';

/*
 * The fleet panel's window picker, as the browser lane addresses it.
 *
 * One module rather than a selector written out per spec, for the reason
 * `site-table.ts` gives about the fleet's disclosure (`structure.md` rule 7):
 * two specs reach for this control and they reach for it as the *same* fact —
 * where a reader-initiated selection lands (#284 D14) — so a change to how the
 * picker states its pressed window should be a one-file change rather than a
 * hunt. `keyboard-focus.spec.ts` measures the ring on it; `header.spec.ts`
 * asserts a search hit lands there.
 */

/**
 * The pressed button, which is the landing.
 *
 * Selected by `aria-pressed` rather than by label, because the rule names
 * *whichever* window is current: pinning `24 h` would make a change of default
 * window read as a focus regression, and the pressed state is the same fact the
 * control states to a reader. One picker is on the page, so this resolves to one
 * element — `Dashboard.focus.test.tsx` narrows by the picker's group for the
 * same query, because jsdom's tree also holds the map's `aria-pressed` add-site
 * control.
 *
 * Exported as the raw selector as well as a locator because one caller passes it
 * to `getComputedStyle` through `Locator.evaluate` and the other wants a locator
 * to assert on.
 */
export const PRESSED_RANGE_BUTTON = '.range-picker-button[aria-pressed="true"]';

/** {@link PRESSED_RANGE_BUTTON} as a locator, for the specs that assert on it. */
export const pressedRangeButton = (page: Page): Locator => page.locator(PRESSED_RANGE_BUTTON);
