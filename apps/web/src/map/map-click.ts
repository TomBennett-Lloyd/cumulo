/**
 * maplibre's own class, added to every marker element it wraps — default or
 * custom (`Marker`'s constructor sets it outside the default-element branch, so
 * a supplied element gets it too).
 */
const MARKER_CLASS = 'maplibregl-marker';

/**
 * Whether a click on the map belongs to an overlay rather than to the basemap
 * under it.
 *
 * This exists because maplibre mounts markers *inside* the same canvas container
 * its own click handler is bound to, so a click on a site marker also arrives as
 * a map click. Without this test the dashboard would answer one press twice —
 * selecting the site and opening "add a site here" on top of it — and the second
 * answer is the one the visitor did not ask for.
 *
 * A predicate over the event target rather than a `stopPropagation` on each
 * marker: markers here are not draggable, so nothing else depends on those
 * events reaching the map, and one rule stated once covers every overlay
 * maplibre mounts (markers today, popups later) instead of every overlay having
 * to remember to opt out.
 *
 * `closest` rather than an identity check because the click lands on whatever is
 * *inside* the marker element — the site's `<button>`, or the tooltip `<span>`
 * within it — never on the marker shell itself.
 */
export const isMarkerClick = (target: EventTarget | null): boolean =>
  target instanceof Element && target.closest(`.${MARKER_CLASS}`) !== null;
