/*
 * The fleet panel's window picker, as the browser lane addresses it.
 *
 * One module rather than a selector written out per spec, for the reason
 * `site-table.ts` gives about the fleet's disclosure (`structure.md` rule 7): a
 * spec reaching for this control reaches for it as one fact — the button the
 * picker currently shows as pressed — so a change to how the picker states that
 * should be a one-file change rather than a hunt.
 *
 * What the fact used to be is worth recording here, because it is why the module
 * exists at all and why callers still find the control interesting. Until #328
 * the pressed button was where a reader-initiated selection landed (#284 D14),
 * and the lane measured that landing on it. Nothing lands anywhere now — a
 * selection leaves the reader where they put themselves (`design.md` rule 11) —
 * so this is no longer a focus destination. It is a control that is always on
 * the page, always pressed, and therefore the one most likely to reacquire a
 * ring by accident, which is the kind of subject a spec goes looking for.
 */

/**
 * The button the picker shows as pressed.
 *
 * Selected by `aria-pressed` rather than by label, because callers want
 * *whichever* window is current: pinning `24 h` would make a change of default
 * window read as a failure in specs that are not about the default. It also
 * means a caller pressing this button changes no state — the pressed window
 * stays pressed — where pressing an unpressed one would move the pressed state
 * and leave this selector resolving to a different element than the one that was
 * touched. One picker is on the page, so it resolves to a single element;
 * `Dashboard.focus.test.tsx` narrows by the picker's group for the same query,
 * because jsdom's tree also holds the map's `aria-pressed` add-site control.
 *
 * A raw selector rather than a locator: what callers do with it is pass it
 * through `Locator.evaluate` to `getComputedStyle`, and a caller that wants a
 * locator instead writes `page.locator(PRESSED_RANGE_BUTTON)` — one call, which
 * is not worth a second export standing between the selector and its use.
 */
export const PRESSED_RANGE_BUTTON = '.range-picker-button[aria-pressed="true"]';
