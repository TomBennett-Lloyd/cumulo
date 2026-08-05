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
          <h2 className="about-dialog-title" id={headingId}>
            About Cumulo
          </h2>

          <p className="about-dialog-lede">{PRODUCT_TAGLINE}</p>

          <p>
            Every site on the map gets its own forecast with an uncertainty band, and the fleet view
            is those forecasts summed. Drop a new site anywhere and the aggregate moves with it.
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

          <button type="button" className="about-dialog-close" onClick={onClose}>
            Close
          </button>
        </div>
      ) : null}
    </dialog>
  );
};
