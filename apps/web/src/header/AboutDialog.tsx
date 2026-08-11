import { OpenMeteoAttribution } from '@cumulo/ui';
import { useEffect, useId, useRef, type ReactElement } from 'react';

import { syncDialogOpen } from '../dialog-modality';
import { PRODUCT_TAGLINE } from './header-copy';

export interface AboutDialogProps {
  /** Whether the dialog is showing. The parent owns this; the element follows it. */
  readonly open: boolean;
  /** What the dialog asking to be dismissed means — Escape, or its own Close. */
  readonly onClose: () => void;
}

/**
 * What Cumulo is and where its data comes from, behind the header menu.
 *
 * ## The element is the external system
 *
 * A dialog's open-ness lives in the DOM, not in React: `showModal()` is an
 * imperative call into an element that then owns a top layer, a backdrop, an
 * inert page and a focus stack. So the effect below is `react.md` rule 1's
 * sanctioned case — synchronising an external system with a prop — and it is
 * the only effect here. Everything else is a plain render.
 *
 * `cancel` is the element telling *us* it has been dismissed (Escape is the
 * only way to raise it here). It is not prevented: letting the browser run its
 * own close steps is what restores focus to the control that opened the dialog,
 * which is precisely the behaviour a hand-rolled modal gets wrong.
 *
 * ## The content mounts with the dialog, not with the component
 *
 * The `<dialog>` element is always in the tree — the effect needs a stable ref
 * — but its children render only while it is open. A closed dialog holding a
 * full copy of the tagline and a third Open-Meteo credit would put both in the
 * document at rest, where `App.test.tsx`'s "once" and "exactly two" counts
 * would find them and where a text-scraping reader could too.
 *
 * ## The way out is an X in the title row
 *
 * The close control is an icon whose accessible name is the word it used to
 * show (`design.md` rule 2: a label naming a control for assistive technology
 * becomes an accessible name, not visible text). Losing the word means losing
 * the one thing that made a button at the foot of the card legible as the way
 * out, so the control moves to where an icon-only close is conventionally found
 * and therefore needs no words — the dialog's top-right, sharing a row with the
 * title (`design.md` rule 1: use the standard idiom where one exists).
 *
 * What the old bottom button was for is unchanged by the move: **a modal a
 * pointer user cannot dismiss is a trap**, and Escape is not a pointer. The
 * dialog still has exactly one control, it is still the whole of the dialog's
 * say in whether it closes, and it is still reachable by pointer and by tab —
 * it is now first in the reading order rather than last, which is where a
 * reader looking for a way out of a modal looks.
 *
 * ## Copy
 *
 * Placeholder, pending the design pass's own words — with one exception that is
 * not placeholder and not editorial: the data-sources block is a licence
 * obligation. The Open-Meteo credit is `OpenMeteoAttribution`'s, composed rather
 * than restyled or re-worded, and the tile credit carries the same two links the
 * map's own strip does (`map/MapAttributionStrip.tsx`; this file is ledgered as
 * a carrier of the provider's identity beside its owner in `map/basemap.ts`).
 */
export const AboutDialog = ({ open, onClose }: AboutDialogProps): ReactElement => {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const headingId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;

    if (dialog !== null) {
      syncDialogOpen(dialog, open);
    }
  }, [open]);

  return (
    <dialog className="about-dialog" ref={dialogRef} aria-labelledby={headingId} onCancel={onClose}>
      {open ? (
        <div className="about-dialog-body">
          <div className="about-dialog-header">
            <h2 className="about-dialog-title" id={headingId}>
              About Cumulo
            </h2>

            {/*
             * The X is drawn on the burger's terms one file over
             * (`HeaderMenu.tsx`): a 20-unit `viewBox`, `aria-hidden` so the
             * button's name is said once, stroked in `currentColor`. The
             * accessible name is the word this button no longer shows.
             */}
            <button
              type="button"
              className="about-dialog-close"
              aria-label="Close"
              onClick={onClose}
            >
              <svg className="about-dialog-close-icon" viewBox="0 0 20 20" aria-hidden="true">
                <path d="M5 5 15 15" />
                <path d="M15 5 5 15" />
              </svg>
            </button>
          </div>

          <p className="about-dialog-lede">{PRODUCT_TAGLINE}</p>

          <p>
            Every site on the map gets its own forecast with a simulated uncertainty band, and the
            fleet view is those forecasts summed. Drop a new site anywhere and the aggregate moves
            with it.
          </p>

          <section className="about-dialog-sources">
            <h3 className="about-dialog-sources-title">Data sources</h3>

            <p>
              <OpenMeteoAttribution />
            </p>

            <p>
              <small className="about-dialog-basemap">
                Basemap:{' '}
                <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">
                  © OpenStreetMap contributors
                </a>
                , tiles by{' '}
                <a href="https://openfreemap.org/" target="_blank" rel="noreferrer">
                  OpenFreeMap
                </a>
              </small>
            </p>
          </section>
        </div>
      ) : null}
    </dialog>
  );
};
