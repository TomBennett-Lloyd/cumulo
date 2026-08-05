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
 * a reason `architecture.md` rule 9 states: the tagline now has two carriers —
 * the header line and the About dialog — and a sentence spelled out twice is a
 * sentence that will be edited once.
 */

/**
 * What Cumulo is, in one line.
 *
 * Rendered by the header (`App.tsx`) and quoted by `AboutDialog.tsx`, and
 * asserted by both of their test files (`App.test.tsx`, `AboutDialog.test.tsx`).
 * All four import it; none spells any part of it out, so editing the sentence
 * here cannot leave a test passing against the old words — which is the failure
 * a restatement ledger exists to catch, avoided here by there being nothing to
 * ledger (`architecture.md` rule 9).
 */
export const PRODUCT_TAGLINE =
  'Residential solar fleet forecasting — per-site forecasts with uncertainty, summed across a fleet you can add to.';
