import type { ReactElement } from 'react';

/**
 * The product's mark and wordmark, side by side at the head of the shell.
 *
 * ## The mark is a placeholder, and this component is the whole slot
 *
 * The glyph below — a sun with a cloud across it, which is the name's own joke
 * (cumulus clouds are what stand between the sun and the panels) — is drawn
 * inline rather than commissioned. Swapping it for a final asset is a change to
 * this component's internals and nothing else: nobody imports the paths, no
 * test asserts their shape, and the two classes the stylesheet paints
 * (`.brand-mark-sun`, `.brand-mark-cloud`) exist only inside this file. A
 * designed mark arriving as an SVG file replaces the `<svg>` element here; a
 * mark arriving as an image replaces it with an `<img>`. Neither reaches the
 * header, the gallery, or any test.
 *
 * It is drawn with token colours through CSS classes, not attributes, because
 * the frontend gate is a stylesheet gate: `fill` is on stylelint's guarded
 * property list, so `header.css` is where a colour can be judged. `--color-accent`
 * and `--color-text-muted` are base tokens deliberately — the chart and map
 * slots carry data identity, and a brand mark borrowing one would make "the
 * product" and "a selected site" the same colour. A final mark wanting its own
 * hue asks the design system for a brand token rather than spelling one here.
 *
 * `aria-hidden` because the wordmark beside it already says "Cumulo": a reader
 * who hears both hears the product named twice.
 *
 * ## Why the `<h1>` keeps its class
 *
 * `.app-title` stays on the heading. It is the shell's type treatment *and* the
 * frame the token gallery borrows (`preview/TokensHarness.tsx`, whose own `<h1>`
 * wears it), so dropping it here would silently restyle a page this component
 * never appears on. `.brand-name` is added beside it for what is genuinely new:
 * the wordmark's relationship to the mark.
 */
export const Brand = (): ReactElement => (
  <div className="brand">
    <svg className="brand-mark" viewBox="0 0 32 32" aria-hidden="true">
      <circle className="brand-mark-sun" cx="22.5" cy="9" r="5.5" />
      <path
        className="brand-mark-cloud"
        d="M8 26a5.5 5.5 0 0 1 0-11 7 7 0 0 1 13.2-2 6.6 6.6 0 0 1 .8 13z"
      />
    </svg>
    <h1 className="app-title brand-name">Cumulo</h1>
  </div>
);
