/**
 * How the current selection came to be — the fact the card's hand-back turns on.
 *
 * - `reader` — somebody did something: pressed a marker, picked a site out of
 *   the header's search, added a site. Their focus is not moved for it (#328, `design.md` rule 11): they are
 *   still on the control they pressed. What `reader` decides is that the card
 *   captures whatever held focus as it opened and returns it on close *if the
 *   card is holding it by then* — the reader who tabs or presses into the card
 *   and dismisses it from inside.
 * - `deep-link` — the selection arrived in the address bar (`selection-url.ts`).
 *   Nobody acted, so there is nobody to return anywhere: the card captures no
 *   opener and moves no focus at either end.
 *
 * The type therefore says whether a selection is somebody's, not where anything
 * lands — it never moved focus in for a `deep-link`, and since #328 it moves
 * focus in for nobody, which left the capture as the whole of what it gates.
 *
 * The distinction exists because "when did the site's surface mount" is not the
 * same question as "when did the reader arrive". On a `?site=` link the surface
 * mounts when the *fleet listing resolves*, which can be seconds after first
 * paint — a moment the reader had no part in. That is what made a mount-time
 * focus move here a theft of focus from somebody who did nothing to ask for it
 * (WCAG 3.2.5;
 * [#260](https://github.com/TomBennett-Lloyd/cumulo/issues/260)), and it is the
 * same reason the capture is refused: whatever happened to hold focus at that
 * arbitrary instant is not an opener anyone chose to be returned to. Skipping the
 * first run on that path was the other candidate fix and is weaker: it is a rule
 * about run counts rather than about who acted, so it says nothing about the
 * second late arrival, and it cannot be read off a call site.
 *
 * Declared in its own module, like `forecast-view-state.ts`, because two sides
 * meet on it and neither owns the other: `Dashboard` decides the value, and the
 * map's `SitePopoverCard` is what obeys it.
 */
export type SelectionOrigin = 'reader' | 'deep-link';
