/*
 * The shell's own words, owned once.
 *
 * A deliberate sibling of `dashboard/state-copy.ts` (what a surface says while
 * it waits or fails) and `charts/chart-copy.ts` (what a chart says about
 * itself): this file holds what the *product* says about itself. The split is
 * the same one those two make — copy belongs to the surface whose voice it is,
 * and the shell's voice is neither a panel's nor a chart's.
 *
 * There is exactly one string here rather than a copy deck, and it is here for
 * a reason `architecture.md` rule 9 states: a sentence spelled out twice is a
 * sentence that will be edited once. The tagline had two carriers when this
 * module was written — a line on the bar, which #265 turned into a toggletip
 * beside the brand — and #284 D13 removed that one, leaving the About dialog
 * alone with it. Owned here anyway, and not inlined back into the dialog: two
 * test files read this export rather than spelling the sentence out, so inlining
 * would put the words in three places to save them being in one — and the
 * carrier that just went is evidence the count moves.
 */

/**
 * What Cumulo is, in one line.
 *
 * Rendered in one place, `AboutDialog.tsx`, and asserted from two
 * (`AboutDialog.test.tsx` against the dialog alone, `App.test.tsx` through the
 * shell) — where the shell's assertion opens the menu and presses About first,
 * because a description behind two presses is not on the page until somebody
 * asks for it. All three import it; none spells any part of it out, so editing
 * the sentence here cannot leave a test passing against the old words — which
 * is the failure a restatement ledger exists to catch, avoided here by there
 * being nothing to ledger (`architecture.md` rule 9).
 */
export const PRODUCT_TAGLINE =
  'Residential solar fleet forecasting — per-site forecasts with uncertainty, summed across a fleet you can add to.';
