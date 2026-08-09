import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
} from 'react';

export interface InfoTipProps {
  /**
   * The button's accessible name — what the reader is asking about, not "i".
   *
   * A glyph is not a name: "About this chart" is what a screen reader announces
   * and what a voice-control user says out loud, and both are useless if the
   * control is called "i". It names the *subject* rather than the action for the
   * same reason, since two of these on one page would otherwise be two controls
   * called "More information".
   */
  readonly label: string;
  /**
   * The sentence itself. Phrasing content — this mounts inside a `<span>`, so a
   * caller handing it a `<p>` would be writing invalid markup.
   */
  readonly children: ReactNode;
}

/**
 * A description, behind an (i).
 *
 * The page had three sentences explaining things that were on screen: what the
 * product is, what the fleet chart is a sum of, and which window the chart
 * covers. Each was true, each was read once, and each took a line of vertical
 * space from the surfaces it described on every render for every reader (#265).
 * This is where they went — reachable in one press, and costing nothing while
 * nobody is asking.
 *
 * Two of the three are left. The window sentence was deleted rather than moved
 * again (#284 D5): it only ever rendered on the arm of the fleet panel that had
 * no range picker, and that arm now has one, so the sentence was a description
 * of a control standing beside it. Which is the shape worth noticing — a tip is
 * the right home for a description, and no home at all is the right one for a
 * description the interface has since made redundant.
 *
 * ## A disclosure, and deliberately not a live region
 *
 * The canonical toggletip is a persistent `role="status"` container that the
 * content is injected into, so the injection is announced. This is not that, and
 * the reason is `react.md`'s budget: **at most one live region per panel**, and
 * the fleet panel's one is the chart's own readout — the announcement a reader
 * asked for by moving the chart's selection. Two of these in that panel would
 * make three regions competing to be heard, and the reader would get whichever
 * won. So the change is announced the way a disclosure announces it: the button
 * carries `aria-expanded`, which is state on the control the reader just pressed
 * rather than an interruption. (A `role="status"` mounted with its text already
 * inside it announces nothing anyway — it has no change to report, #161 — so the
 * live-region version of this would have had to keep an empty container on every
 * page for every tip, which is the cost the budget rule exists to refuse.)
 *
 * The content is mounted only while open rather than hidden with CSS. A
 * description nobody has asked for is not in the document at all: no text for a
 * screen reader to run into out of context, and nothing for a `textContent`
 * assertion elsewhere to trip over.
 *
 * ## Dismissal, and what it shares with the header's menu
 *
 * Three routes: the button again, Escape, and a press outside. They are the same
 * three `HeaderMenu` has, in the same shapes — `mousedown` rather than `click`
 * so the popup is gone before the control the reader is pressing reacts, and
 * Escape putting focus back on the button that opened it.
 *
 * That resemblance is deliberate and it is also deliberately *not* extracted
 * (`structure.md` rule 7). Ask the rule's question — if the menu changed, would
 * this be wrong until it changed the same way? For the dismissal *policy*, yes:
 * two overlays in one app dismissing on different gestures is an inconsistency a
 * reader can feel. For the code around it, no: the menu's listener stands down
 * while its modal dialog is open, and this has no modal to stand down for. So
 * what they genuinely share is one rule, and the shared portion is smaller than
 * the hook that would carry it. The moment extraction becomes right is already
 * written down: `docs/tech-debt.md` holds a pending decision about adding a
 * fourth route (dismissal on focus leaving), noted there as the thing the next
 * popover will copy — and applying that decision means applying it to both, in
 * one place, which is when the shared hook earns its keep.
 *
 * Presentational (`react.md` rule 4): all it owns is whether it is open.
 */
export const InfoTip = ({ label, children }: InfoTipProps): ReactElement => {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLSpanElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // A subscription to something outside React (`react.md` rule 1), and so
  // genuinely an effect. Only while open: a listener on the document for every
  // tip on the page at rest is a cost paid by readers who never press one.
  useEffect(() => {
    if (!open) {
      return undefined;
    }

    const closeOnOutsidePress = (event: MouseEvent): void => {
      const container = containerRef.current;
      const pressedInside =
        container !== null && event.target instanceof Node && container.contains(event.target);

      if (!pressedInside) {
        setOpen(false);
      }
    };

    document.addEventListener('mousedown', closeOnOutsidePress);

    return () => {
      document.removeEventListener('mousedown', closeOnOutsidePress);
    };
  }, [open]);

  const handleKeyDown = (event: KeyboardEvent<HTMLSpanElement>): void => {
    if (event.key === 'Escape' && open) {
      setOpen(false);
      // Ordinarily a no-op, because the panel takes no focus and the reader is
      // still standing on the button. It is here for the case that is not
      // ordinary: content with a link in it, dismissed from inside, which would
      // otherwise drop focus onto `body` as the panel leaves the document.
      buttonRef.current?.focus();
    }
  };

  return (
    <span className="info-tip" ref={containerRef} onKeyDown={handleKeyDown}>
      <button
        type="button"
        className="info-tip-button"
        ref={buttonRef}
        aria-label={label}
        aria-expanded={open}
        onClick={() => {
          setOpen((wasOpen) => !wasOpen);
        }}
      >
        i
      </button>

      {open ? <span className="info-tip-panel">{children}</span> : null}
    </span>
  );
};
