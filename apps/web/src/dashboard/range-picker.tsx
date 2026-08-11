import { useEffect, useRef, useState, type KeyboardEvent, type ReactElement } from 'react';

import type { RangeHours } from '../data/fleet-data-source';

/**
 * The window picker, and the labels that name a window anywhere else on screen.
 *
 * Extracted when two panels carried one, because the two copies had the same
 * intent (`structure.md` rule 7): the offered windows are a property of what
 * `FleetDataSource` can serve, not of the panel asking, so adding a 72 h window
 * or renaming `7 d` would leave any copy that missed the change simply wrong.
 *
 * One caller carries the picker today — the fleet panel — because #265 took the
 * site's own chart off the page and made a selected site a series on the fleet's
 * (`site-overlay.ts`), which put both series under one window control. The
 * module stays a module rather than folding back into `FleetPanel.tsx` for two
 * reasons that outlive the count: `rangeLabel` names a window in copy that is
 * not the picker's (the chart's accessible name and its table caption), and the
 * `RangeHours` → label mapping is the one place a fourth window has to be added.
 * The accessible name stays a parameter for the same reason it always was — it
 * is what a second caller would differ in, and nothing in the markup branches
 * on it.
 *
 * The *default* window deliberately stays with the caller. A panel could
 * reasonably open wider than another without making either wrong, so that one is
 * an independent choice rather than a shared fact.
 *
 * It lives in `dashboard/` because that is where its caller lives: the three
 * chart *views* it was extracted from are gone (#148), and a control used only
 * by the reading under the map has no business sitting in a directory named
 * after the pages that used to exist. Its styling moved with it, into
 * `range-picker.css`.
 */

/**
 * A `Record` over the union, so a fourth `RangeHours` fails to compile until it
 * has a label — the list below is display order and would only fall silently
 * short.
 */
const RANGE_LABELS: Record<RangeHours, string> = { 24: '24 h', 48: '48 h', 168: '7 d' };

/** Ascending, because the control reads as a scale of how far out to look. */
const RANGE_OPTIONS: readonly RangeHours[] = [24, 48, 168];

/**
 * The label a panel puts in a chart title or table caption for a window.
 *
 * The same strings as the buttons, from the same map: a caption reading "168 h
 * range" beside a control labelled "7 d" is two names for one window.
 */
export const rangeLabel = (range: RangeHours): string => RANGE_LABELS[range];

export interface RangePickerProps {
  readonly range: RangeHours;
  /**
   * Names the control for assistive technology — the panels mean different
   * windows. It reaches two elements since the fold below: the trigger, whose
   * name lives only in this attribute, and the group of options it reveals.
   */
  readonly ariaLabel: string;
  readonly onSelect: (range: RangeHours) => void;
}

/**
 * A calendar icon, and the three windows behind it.
 *
 * Still buttons rather than a select, and still `aria-pressed` stating the
 * choice — the pressed styling in `range-picker.css` is that same fact rendered
 * visually. What changed on 2026-08-11 is only whether the three are on the row
 * at rest, and the owner asked for it in those words: *"perhaps if we made the
 * time period selection into a dropdown from a calendar icon there might always
 * be space"*.
 *
 * The trade is deliberate and it is a loss on one side, so it is written down
 * rather than implied. The virtue this control had is the one it has given up:
 * the current window was readable without opening anything, and a reader now
 * has to press to see which of the three is pressed. What that buys is the
 * row's width — ~144px of it, measured — and the width is what the fleet's own
 * numbers need in order to be on screen at all. `fleet-panel.css` owns the
 * container width below which those numbers hide and re-derived it against this
 * trigger; the point of the fold is that the number came down, not that the
 * control looks tidier. The window itself is not lost with the chips, either:
 * the chart's own accessible name and its table caption both state it, from
 * `rangeLabel` above by way of `fleet-panel-copy.ts`. So the row gives up a
 * restatement and gets back a fact nothing else on the page says.
 *
 * ## A disclosure, not a menu
 *
 * `HeaderMenu.tsx` :69–:74 settles this, and its reasoning is unchanged here.
 * The ARIA menu pattern is an application menu bar: it takes arrow keys over
 * Tab, owns Home/End and type-ahead, and manages a roving tabindex — a contract
 * owed in full the moment the role is claimed, and one that makes ordinary
 * buttons stop behaving like buttons. What is behind this trigger is three
 * ordinary buttons, so this is a button with `aria-expanded` revealing them.
 *
 * The trigger's name lives only in `aria-label` and the glyph is `aria-hidden`,
 * which is that same file's :39–:60 shape for its reason: a mark that says
 * nothing its name does not already say should not be in the accessibility tree
 * twice. It also inherits that shape's named edge — this is now the second
 * control in the app whose accessible name exists only in an attribute, so
 * losing the attribute leaves a button announced as "button" with nothing on
 * screen looking wrong and no gate firing. `HeaderMenu.tsx` states that edge for
 * the first and points at the missing-a11y-linting debt (#351) as what would
 * one day catch it mechanically; until that lands the catch is a suite's, and
 * for this control it is `FleetPanel.structure.test.tsx`'s accessible-name case.
 *
 * The `<svg>` is drawn here rather than fetched, on `Brand.tsx`'s terms: no test
 * asserts its geometry and nothing outside this file imports it, so a designed
 * glyph replaces it and reaches nothing else. Its colour is the stylesheet's,
 * because the frontend gate is a stylesheet gate.
 *
 * ## Dismissal, and why the shape is copied rather than shared
 *
 * Three routes, the same three `InfoTip` and `HeaderMenu` have and in the same
 * shapes: the trigger again, Escape, and a press outside — `mousedown` rather
 * than `click`, so the popover is gone before the control the reader is pressing
 * reacts. A fourth is this one's own, because this popover is the only one of
 * the three with something to *choose*: picking a window closes it, since
 * nothing is left to do in it and leaving it up would sit over the chart the
 * choice just changed.
 *
 * Escape and a choice both hand focus back to the trigger, and here that is
 * load-bearing rather than the precaution it is in the tip. The buttons the
 * reader is standing on leave the document either way, so without the hand-back
 * focus drops to `body` and a keyboard reader is returned to the top of the
 * page. That is `design.md` rule 11's own carve-out rather than an exception to
 * it: the page changed in answer to their action, and the trigger is where
 * their next act lives. An outside press deliberately moves nothing — the
 * pointer is already where the reader wants to be.
 *
 * The resemblance to `InfoTip` is deliberate and, like the tip's own
 * resemblance to the menu, deliberately **not** extracted. Its docblock (:79–:90)
 * is where `structure.md` rule 7's question is asked, and the answer here is the
 * same one: for the dismissal *policy*, yes, two overlays in one app dismissing
 * on different gestures is an inconsistency a reader can feel; for the code
 * around it, no. This one closes on a selection and hands focus back on that
 * path, the tip has no selection to close on, and the menu's listener stands
 * down for a modal neither of the others has. What the three genuinely share is
 * one rule, and it is smaller than the hook that would carry it. The moment
 * extraction becomes right is already written down and unchanged by there being
 * a third copy: `docs/tech-debt.md` holds a pending decision about a fourth
 * dismissal route, and applying it means applying it in one place. A third copy
 * is a reason to take that decision, not a licence to pre-empt it here.
 *
 * Presentational (`react.md` rule 4): all it owns is whether it is open.
 */
export const RangePicker = ({ range, ariaLabel, onSelect }: RangePickerProps): ReactElement => {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  // A subscription to something outside React (`react.md` rule 1), and so
  // genuinely an effect. Only while open, for the tip's reason: a listener on
  // the document while nothing is revealed is a cost paid by readers who never
  // press the trigger.
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

  /** Close, and put the reader back on the control that opened it. */
  const dismiss = (): void => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape' && open) {
      dismiss();
    }
  };

  return (
    <div className="range-picker" ref={containerRef} onKeyDown={handleKeyDown}>
      <button
        type="button"
        className="range-picker-trigger"
        ref={triggerRef}
        aria-label={ariaLabel}
        aria-expanded={open}
        onClick={() => {
          setOpen((wasOpen) => !wasOpen);
        }}
      >
        <svg className="range-picker-icon" viewBox="0 0 20 20" aria-hidden="true">
          <path d="M3 5h14v12H3zM3 9h14M7 2v4M13 2v4" />
        </svg>
      </button>

      {open ? (
        <div className="range-picker-popover" role="group" aria-label={ariaLabel}>
          {RANGE_OPTIONS.map((option) => (
            <button
              key={option}
              type="button"
              className="range-picker-button"
              aria-pressed={option === range}
              onClick={() => {
                onSelect(option);
                dismiss();
              }}
            >
              {RANGE_LABELS[option]}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
};
