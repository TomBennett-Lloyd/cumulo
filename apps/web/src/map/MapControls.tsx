import type { ReactElement } from 'react';
import { useContext } from 'react';

import { INITIAL_CAMERA } from './framing';
import { MapContext } from './MapContext';

/*
 * The two things a reader can ask of the map itself, drawn on top of it.
 *
 * They are one component rather than two because they are one control group in
 * one corner: the box is what positions them, and a second component would mean
 * a second caller deciding where map chrome lives.
 *
 * The pair is deliberately asymmetric, and the asymmetry is the interesting
 * part. **Reset** is the map's own business — it speaks to the camera through
 * `MapContext` and the dashboard never hears about it, because where the camera
 * points is not application state. **Add a site** is the opposite: the map has
 * no opinion about whether the reader is placing a site, so the toggle is
 * controlled, and `Dashboard` holds the flag that its own click handler reads.
 *
 * Why an explicit mode at all: before it, every click on the basemap opened a
 * draft, which made panning past a marker a way to be handed a form nobody
 * asked for, and made the whole affordance something the panel had to explain in
 * prose. A pressed control says it instead, which is why `ADD_SITE_HINT` left
 * `state-copy.ts` with this file's arrival.
 */

export interface MapControlsProps {
  /** Whether the next basemap click drops a draft. Owned by the dashboard. */
  readonly armed: boolean;
  readonly onToggleArmed: () => void;
}

/**
 * The map's control group: reset the camera, and arm add-site mode.
 *
 * Rendered as a `MapView` child, so it lands inside `MapSurface`'s box and above
 * the canvas — `map.css` puts it in the top-right corner specifically, because
 * the credits hold the bottom-right one, and a control tucked beside them is a
 * control they can occlude (`docs/design/map-treatment.md`). Their retreat into
 * that corner (#428) freed the bottom *left* rather than the bottom edge, and
 * splitting these two controls across opposite corners is not a composition
 * worth having, so the corner they sit in is unchanged.
 *
 * The reset button is `disabled` until the map instance exists rather than
 * quietly doing nothing when pressed. That window is one frame — `MapView`
 * creates the instance in its mount effect and `MapContext` is `null` until then
 * — but "there is no camera to reset" is a real state, and a control that looks
 * live and is not is the failure this avoids. The handler still asks, because
 * `disabled` is a fact about the DOM that the type checker cannot read.
 *
 * The toggle is *not* gated the same way: arming is dashboard state and is
 * meaningful before the first tile, and a control that flickered from disabled
 * to enabled on the map's arrival would be chrome moving under the reader for a
 * reason it could not see.
 *
 * `INITIAL_CAMERA` is imported from `framing.ts`, which owns the opening camera,
 * and it is spread **whole**. Restating any of it here would give "reset" a
 * second definition, free to disagree with what the map actually opened on —
 * which is not hypothetical: this reset used to name `center` and `zoom` only,
 * so a reader who right-dragged (maplibre's `dragRotate` and `pitchWithRotate`
 * are both on by default) got a rotated, tilted map that "Reset map view"
 * politely left rotated and tilted. Taking the whole object is what makes a
 * partial reset unrepresentable rather than merely discouraged.
 */
export const MapControls = ({ armed, onToggleArmed }: MapControlsProps): ReactElement => {
  const map = useContext(MapContext);

  const resetView = (): void => {
    if (map === null) {
      return;
    }

    map.easeTo({ ...INITIAL_CAMERA });
  };

  return (
    <div className="map-controls">
      {/*
       * A recentre mark, with the words moved to the accessible name.
       *
       * `design.md` rule 2: a label whose only job is naming a control for
       * assistive technology becomes an accessible name rather than visible
       * text. Nothing is lost to a screen reader — the button is still found by
       * the name `Reset map view`, which is what `MapControls.test.tsx` queries
       * by — and the map gets back the corner the two phrases were taking from
       * the tiles they float on. The card's Close (#340) and the range picker's
       * trigger (#329) are the settled instances of the same move.
       *
       * Both marks are drawn on the header's terms (`header/HeaderMenu.tsx`'s
       * burger): a 20-unit `viewBox`, `aria-hidden` so the name is said once,
       * and stroked in `currentColor` so they follow the button through both
       * themes and through the pressed inversion below. `map.css` says why the
       * drawing declarations are restated there rather than shared.
       *
       * A ring with four ticks rather than a circular arrow: what this control
       * does is put the camera back where it was framed, and a recentre mark
       * says that where an undo arrow would say "take back the last thing you
       * did", which is not what pressing it does.
       */}
      <button
        type="button"
        className="map-control-reset"
        aria-label="Reset map view"
        disabled={map === null}
        onClick={resetView}
      >
        <svg className="map-control-icon" viewBox="0 0 20 20" aria-hidden="true">
          <circle cx="10" cy="10" r="4" />
          <path d="M10 1v3M10 16v3M1 10h3M16 10h3" />
        </svg>
      </button>

      {/*
       * `aria-pressed` rather than a second button or a class alone: this is one
       * control with two states, and the pressed state is what a screen reader
       * has instead of the fill `map.css` paints. `map-treatment.md`'s rule that
       * colour never carries a state alone applies to the map's chrome as much
       * as to its markers. It is why the name in `aria-label` says what the
       * control does rather than what mode it is in: the mode is `aria-pressed`'s
       * to report, and a name that moved with it would say it twice and disagree
       * with itself the first time only one of them changed.
       *
       * A pin carrying a plus, and deliberately not a bare `+`: a plus on its own
       * next to a map is the zoom-in button every other map has, and this one
       * places a site. The pin is what says which.
       */}
      <button
        type="button"
        className="map-control-add"
        aria-label="Add a site"
        aria-pressed={armed}
        onClick={onToggleArmed}
      >
        <svg className="map-control-icon" viewBox="0 0 20 20" aria-hidden="true">
          <path d="M10 17c3.2-4.2 4.5-6.6 4.5-8.5a4.5 4.5 0 0 0-9 0c0 1.9 1.3 4.3 4.5 8.5z" />
          <path d="M10 6.5v4M8 8.5h4" />
        </svg>
      </button>
    </div>
  );
};
