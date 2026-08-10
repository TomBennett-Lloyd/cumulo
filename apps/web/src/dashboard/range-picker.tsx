import type { ReactElement } from 'react';

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
  /** Names the group for assistive technology — the panels mean different windows. */
  readonly ariaLabel: string;
  readonly onSelect: (range: RangeHours) => void;
}

/**
 * Buttons rather than a select: there are three options, and the current one
 * should be readable without opening anything. `aria-pressed` is what states the
 * choice — the pressed styling in `range-picker.css` is the same fact rendered
 * visually.
 *
 * Nothing outside points at these buttons, and nothing puts focus on them:
 * `design.md` rule 11 leaves focus where the reader put it, so this control is
 * reached the way every other control on the page is.
 */
export const RangePicker = (props: RangePickerProps): ReactElement => (
  <div className="range-picker" role="group" aria-label={props.ariaLabel}>
    {RANGE_OPTIONS.map((option) => (
      <button
        key={option}
        type="button"
        className="range-picker-button"
        aria-pressed={option === props.range}
        onClick={() => {
          props.onSelect(option);
        }}
      >
        {RANGE_LABELS[option]}
      </button>
    ))}
  </div>
);
