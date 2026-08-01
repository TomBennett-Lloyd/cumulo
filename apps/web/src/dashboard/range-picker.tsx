import type { ReactElement } from 'react';

import type { RangeHours } from '../data/fleet-data-source';

/**
 * The window picker both panels carry, and the labels that name a window
 * anywhere else on screen.
 *
 * Extracted rather than left duplicated because the two copies had the same
 * intent (`structure.md` rule 7): the offered windows are a property of what
 * `FleetDataSource` can serve, not of the panel asking, so adding a 72 h
 * window or renaming `7 d` would leave any copy that missed the change simply
 * wrong. What differs between the two call sites is the group's accessible name
 * — "which range?" means a forecast window in the site panel and an aggregation
 * window in the fleet panel — and that is a parameter, not a mode flag: nothing
 * in the markup branches on it.
 *
 * The *default* window deliberately stays with each panel. Both open on 24 h
 * today, but a panel could reasonably open wider without making the other
 * wrong, so that one is an independent choice rather than a shared fact.
 *
 * It lives in `dashboard/` because that is where both of its callers now live:
 * the three chart *views* it was extracted from are gone (#148), and a control
 * used only by the panel column has no business sitting in a directory named
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
