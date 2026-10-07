/** `packages/ui/src/styles.css`'s ring selector, `a` narrowed to the anchors that take focus. */
const FOCUSABLE = 'button, a[href], input, select, textarea, summary, [tabindex]';

/**
 * Give a pressed control the focus its host cancelled, without a ring.
 *
 * maplibre's `Marker` constructor prevents `mousedown`'s default on the element
 * it wraps ("prevent focusing on click", `maplibre-gl/src/ui/marker.ts`), so a
 * press inside a marker focuses nothing (#446); a press whose default survived
 * was focused natively. A script focus paints a ring unless told otherwise, and a
 * pointer press paints none (`docs/standards/design.md` rule 11). Asserted by
 * `marker-press-focus.test.ts` and `apps/web/e2e/pointer-focus.spec.ts`, whose
 * map-edge cluster case pins `preventScroll`.
 */
export const focusPressedControl = (event: MouseEvent): void => {
  if (!event.defaultPrevented || !(event.target instanceof Element)) {
    return;
  }

  const control = event.target.closest(FOCUSABLE);

  if (control instanceof HTMLElement || control instanceof SVGElement) {
    control.focus({ focusVisible: false, preventScroll: true });
  }
};
