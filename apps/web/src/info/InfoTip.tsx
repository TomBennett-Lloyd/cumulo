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
   * What is behind the press. Flow content — this mounts inside a `<div>`, so a
   * list or a paragraph is valid here.
   *
   * It was phrasing content in a `<span>` until 2026-08-11, when the fleet
   * chart's legend moved in beside its sentence (#429): a `<ul>` is flow content
   * and a `<span>` may not contain one, so the container is the element that had
   * to give way rather than the content. Nothing about what a tip is *for*
   * changed with it — a description, and now a key, which is description of the
   * same kind.
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
 * One of the three is left, and the other two went for the same reason in
 * different words: a tip is the right home for a description, and no home at all
 * is the right one for a description something else on the page already gives.
 * The window sentence went first (#284 D5) — it rendered only on the arm of the
 * fleet panel that had no range picker, and that arm now has one, so it had
 * become a description of a control standing beside it. The product's line went
 * with the bar's (i) (#284 D13), because the About dialog behind the header menu
 * opens with that same sentence in full. What is left is the fleet chart's: what
 * the chart is a sum of, which nothing else on the page says.
 *
 * ## A disclosure, and deliberately not a live region
 *
 * The canonical toggletip is a persistent `role="status"` container that the
 * content is injected into, so the injection is announced. This is not that, and
 * the reason is `react.md`'s budget: **at most one live region per panel**, and
 * the fleet panel's one is the chart's own readout — the announcement a reader
 * asked for by moving the chart's selection. Two of these in that panel would
 * make three regions competing to be heard, and the reader would get whichever
 * won. The budget is also already at its limit there in one state: `react.md`
 * sanctions a second `role="alert"` mounting beside that readout when the fleet
 * read fails — since #452 the chart's own in-figure failure overlay
 * (`charts/forecast-chart-error.tsx`) rather than a `PanelError` above the plot,
 * which changes where the alert is drawn and nothing about the budget. The
 * grounds are unchanged too: a failed chart has no sample to speak and so cannot
 * compete with it. A live-region tip would be the one that genuinely does. So the change is announced the way a disclosure announces it: the button
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
 * ## What the consumer owes it: a positioned ancestor
 *
 * **The panel is not anchored to this component.** `.info-tip` carries no
 * `position` of its own, so the panel's containing block is whatever positioned
 * ancestor the consuming surface supplies — and it is clamped to *that* box's
 * width and right edge (`info.css`). Every consumer must therefore give it one.
 * The fleet chart's controls row is the one consumer today and does it in
 * `dashboard/fleet-panel.css`, whose `.fleet-chart-controls` rule states the
 * obligation where it is discharged.
 *
 * It is a requirement rather than an implementation detail because of what
 * happens when it is not met: the panel falls back to the initial containing
 * block — the page — and hangs off whichever edge it was opened near, which is
 * exactly the defect this arrangement was adopted to fix (the owner, 2026-08-11:
 * *"the (i) tooltip hangs off the edge of the page"*). Anchoring to `.info-tip`
 * itself is what produced that: a 24px button near the right edge of the page is
 * not a box a 22rem panel can be clamped inside, so the panel's own measure
 * decided its width and its width ran past the viewport. The row is, which is
 * why the anchor moved outwards rather than the measure inwards. A new consumer
 * that cannot offer a positioned ancestor is a design question for that surface,
 * not a case for a second rule here.
 *
 * Presentational (`react.md` rule 4): all it owns is whether it is open.
 */
export const InfoTip = ({ label, children }: InfoTipProps): ReactElement => {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
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

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
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
    <div className="info-tip" ref={containerRef} onKeyDown={handleKeyDown}>
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

      {open ? <div className="info-tip-panel">{children}</div> : null}
    </div>
  );
};
