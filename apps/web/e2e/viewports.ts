import type { PlaywrightTestOptions } from '@playwright/test';

/*
 * The two phone widths this lane opens cases at, and what each one is for.
 *
 * Not a registry of every size the lane uses — several specs still declare their
 * own, and two of those names collide across files at different values. What
 * lives here is the pair whose relationship is the point. Before this module,
 * 390x844 was written three times inside the lane — named in
 * `composition.spec.ts` and `header.spec.ts`, inline in a `test.use` in
 * `chart-first-paint.spec.ts` — beside attribution-band's 360x740, which is
 * different on purpose. That the three were equal deliberately, and the fourth
 * number deliberately not, was legible only to someone who had opened all four
 * (#404). All three declarations are now this constant.
 *
 * Sentences that mention the number rather than declare it are carriers too, and
 * this module does not own them — `docs/design/design-principles.md` quotes the
 * inline `test.use` form as the lane's mobile idiom, so an author copying from
 * there re-inlines the literal. No count of those is given on purpose: an
 * enumeration is falsified by one more carrier, where a floor and its sweep are
 * not. The sweep is `git grep -n -E '390|844' -- :/`, and `docs/tech-debt.md`
 * holds what it turned up.
 */

/**
 * The shape `test.use({ viewport })` takes, derived from the option itself.
 *
 * Named from `PlaywrightTestOptions` rather than hand-written so it cannot drift
 * from what Playwright accepts, on the same principle `layout-box.ts` derives
 * `LayoutBox` at the other library boundary (`typing.md` rule 3).
 */
type Viewport = NonNullable<PlaywrightTestOptions['viewport']>;

/**
 * A phone, and the width every phone-width claim in this lane is made at.
 *
 * 390x844 is a real device size rather than a number chosen just under some
 * fold — which is what lets one constant serve claims about two different folds.
 * It sits clear of the width at which `header/header.css` measured the brand, the
 * field and the menu stopping fit on one line (a container query against the
 * bar's own content box since #326; that stylesheet owns the threshold and the
 * derivation), and the clearance is what keeps a case from turning red over a
 * platform whose fonts lay the bar out a few pixels wider than the measurement.
 *
 * Shared across the specs on purpose, and that is the whole reason it is one
 * constant instead of two equal ones: a platform whose fonts run wide shows up in
 * every phone-width case at once, rather than only in whichever spec happened to
 * pick the tighter width.
 */
export const PHONE_VIEWPORT: Viewport = { width: 390, height: 844 };

/**
 * A small phone, chosen for being one — and deliberately not `PHONE_VIEWPORT`.
 *
 * 360x740 is a canonical small-phone size, and mobile is a first-class viewing
 * context rather than an afterthought (`design.md` rule 1). That is the whole
 * derivation, deliberately: this width is **not** picked relative to the compact
 * attribution row's own floor, and nothing computes with that measurement or
 * restates it. `map.css` owns the numbers behind the band's compaction and
 * `composition.spec.ts` is what measures against them; the case that uses this
 * width joins neither ledger, because its claim is the one that holds at every
 * width regardless — no width loses a link.
 *
 * So the band is *expected* to have wrapped here, and nothing asserts a row
 * count. Wrapping is the honest last resort the treatment sanctions; hiding a
 * credit is what is forbidden.
 *
 * Being 30px narrower than `PHONE_VIEWPORT` is therefore not an inconsistency to
 * be tidied away. The two answer different questions — "does the never-wrap claim
 * hold on a phone" against "does a credit survive a genuinely small one" — and
 * collapsing them would quietly weaken the second.
 */
export const SMALL_PHONE_VIEWPORT: Viewport = { width: 360, height: 740 };
