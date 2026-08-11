/*
 * The fleet panel's window picker, as the browser lane addresses it.
 *
 * One module rather than a selector written out per spec, for the reason
 * `site-table.ts` gives about the fleet's disclosure (`structure.md` rule 7): a
 * spec reaching for this control reaches for it as one fact, so a change to how
 * the picker states that should be a one-file change rather than a hunt. The
 * 2026-08-11 fold is what that reasoning was banking: the picker became a
 * calendar trigger over a popover, and the two exports below are what absorbed
 * it.
 *
 * There are two facts now, because the fold made the control two things. The
 * trigger is what is on the row at rest and the only part of the picker a spec
 * can touch without opening anything; the pressed chip is inside the popover and
 * exists only while it is open. A caller wanting the chip therefore presses the
 * trigger first — which is a real gesture rather than test scaffolding, since it
 * is exactly what a reader does.
 *
 * What the pressed chip used to be is worth recording here, because it is why
 * the module exists at all and why callers still find the control interesting.
 * Until #328 it was where a reader-initiated selection landed (#284 D14), and
 * the lane measured that landing on it. Nothing lands anywhere now — a selection
 * leaves the reader where they put themselves (`design.md` rule 11) — so this is
 * no longer a focus destination. It is a control that is always pressed, and
 * therefore the one most likely to reacquire a ring by accident, which is the
 * kind of subject a spec goes looking for.
 */

/**
 * The calendar button the picker shows on the controls row.
 *
 * By class rather than by accessible name, for the same reason the chip below is
 * by state: a caller wants *the picker's trigger*, and the name is the panel's
 * (`ariaLabel`, "Aggregation range" at this one call site) rather than the
 * component's, so pinning it here would make a second caller's picker
 * unreachable through this module. One picker is on the page, so it resolves to
 * a single element.
 *
 * It is also now the picker's only permanently visible part, which is what makes
 * it the right subject for a claim about the row — its box is the picker's box
 * while nothing is open.
 */
export const RANGE_TRIGGER = '.range-picker-trigger';

/**
 * The button the picker shows as pressed, inside the popover the trigger opens.
 *
 * Selected by `aria-pressed` rather than by label, because callers want
 * *whichever* window is current: pinning `24 h` would make a change of default
 * window read as a failure in specs that are not about the default. It also
 * means a caller pressing this button changes no state — the pressed window
 * stays pressed — where pressing an unpressed one would move the pressed state
 * and leave this selector resolving to a different element than the one that was
 * touched. Since the fold that second property gained a companion: choosing a
 * window also closes the popover, so pressing an unpressed chip takes the whole
 * sheet out of the document under the caller. One picker is on the page, so the
 * selector resolves to a single element whenever the popover is up.
 *
 * A raw selector rather than a locator: what callers do with it is pass it
 * through `Locator.evaluate` to `getComputedStyle`, and a caller that wants a
 * locator instead writes `page.locator(PRESSED_RANGE_BUTTON)` — one call, which
 * is not worth a second export standing between the selector and its use.
 */
export const PRESSED_RANGE_BUTTON = '.range-picker-button[aria-pressed="true"]';
