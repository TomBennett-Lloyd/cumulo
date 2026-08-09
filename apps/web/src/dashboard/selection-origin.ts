/**
 * How the current selection came to be — the fact the focus rule turns on.
 *
 * - `reader` — somebody did something: pressed a marker, pressed a row, added a
 *   site. Focus is theirs to move, because they moved it: it goes to the fleet
 *   panel's range picker, the control that decides what the selection they just
 *   made is drawn over (#284 D14).
 * - `deep-link` — the selection arrived in the address bar (`selection-url.ts`).
 *   Nobody asked for it *now*, so focus is never moved for it.
 *
 * This type is about *whether* focus moves and says nothing about where it goes;
 * D14 revised the second question and left this one exactly as #260 settled it.
 *
 * The distinction exists because "when did the site's surface mount" is not the
 * same question as "when did the reader arrive". On a `?site=` link the surface
 * mounts when the *fleet listing resolves*, which can be seconds after first
 * paint — so a mount-time focus move takes focus off whatever the reader had
 * reached in the meantime, with no action of theirs (WCAG 3.2.5;
 * [#260](https://github.com/TomBennett-Lloyd/cumulo/issues/260)). Skipping the
 * first run on that path was the other candidate fix and is weaker: it is a rule
 * about run counts rather than about who acted, so it says nothing about the
 * second late arrival, and it cannot be read off a call site.
 *
 * Declared in its own module, like `forecast-view-state.ts`, because two sides
 * meet on it and neither owns the other: `Dashboard` decides the value, and the
 * map's `SitePopoverCard` is what obeys it.
 */
export type SelectionOrigin = 'reader' | 'deep-link';
