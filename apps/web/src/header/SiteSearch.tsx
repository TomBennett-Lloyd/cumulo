import type { Site } from '@cumulo/shared';
import type { KeyboardEvent, ReactElement } from 'react';
import { useId, useState } from 'react';

import { capacityLabel } from '../dashboard/site-format';

/**
 * How many matches the popup offers at once.
 *
 * A ceiling on the *list*, not on the search: a query that matches thirty sites
 * shows the first eight, because a popup taller than the map it hangs over stops
 * being a shortcut and starts being a second site list. Narrowing the query is
 * the affordance for the rest, and it is one more keystroke.
 */
const MAX_VISIBLE_MATCHES = 8;

/**
 * The control's accessible name, and the hint inside it.
 *
 * Both live here rather than in `header-copy.ts`: that module owns what the
 * *product* says about itself (its one tagline, which the About dialog quotes
 * too), and these are a control's name and placeholder with a single carrier
 * apiece. `dashboard/state-copy.ts` is not their home either — it owns the
 * app's pending, failure and empty-fleet vocabulary, and this is none of the
 * three.
 */
const SEARCH_LABEL = 'Search sites by name';
const SEARCH_PLACEHOLDER = 'Search sites';

/**
 * What the popup says when nothing matches.
 *
 * Deliberately not the words "no sites": that phrase belongs to the empty
 * *fleet*, which `dashboard/state-copy.ts` answers in one sentence and
 * `state-copy-contract.test.ts` sweeps the app to keep unique. A fleet with
 * sixty sites and a query matching none of them is a different fact, and saying
 * it in the fleet's words would make the two indistinguishable to the sweep and
 * to a reader.
 */
const NO_MATCHES_LABEL = 'No matching sites';

/**
 * The sites whose name contains `query`, case-insensitively, capped at
 * {@link MAX_VISIBLE_MATCHES}.
 *
 * A plain substring rather than a prefix: the fleet's names are
 * `<place> rooftop <n>`, so a prefix match would make the place the only
 * searchable half and "rooftop 3" unfindable. Untrimmed, because a space is a
 * character sites really do contain and pretending otherwise would make the
 * match rule depend on where in the string the reader is.
 */
const matchingSites = (sites: readonly Site[], query: string): readonly Site[] => {
  const needle = query.toLowerCase();

  return sites
    .filter((site) => site.name.toLowerCase().includes(needle))
    .slice(0, MAX_VISIBLE_MATCHES);
};

/**
 * Where the active option lands after a step of `step` through `count` options.
 *
 * Top-level and pure, taking the count as a parameter rather than reading the
 * match list out of the component's scope (`structure.md` rule 1) — which is
 * also what makes the clamping legible without the caller.
 *
 * It clamps rather than wraps. Wrapping is optional in the WAI-ARIA combobox
 * pattern, and clamping is the half that cannot surprise: a reader holding
 * ArrowDown to reach the end of eight matches never finds themselves back at the
 * top wondering whether they missed one.
 */
const stepActiveIndex = (current: number, step: number, count: number): number =>
  Math.max(0, Math.min(current + step, count - 1));

export interface SiteSearchProps {
  /** Everything the fleet knows about, listing plus anything created this session. */
  readonly sites: readonly Site[];
  /** Selecting a match — the dashboard's own reader-initiated selection. */
  readonly onSelectSite: (siteId: Site['id']) => void;
}

/**
 * Find a site by name from the header, without hunting the map for it.
 *
 * The fleet is sixty markers on two islands, most of them in knots that only
 * separate two or three zooms in. Reaching one site therefore meant either
 * scrolling the list under the map or expanding clusters until the marker
 * appeared — so the header carries the fleet's index, and a selection made here
 * is the same selection a marker or a row makes.
 *
 * ## The ARIA semantics, stated because nothing lints them
 *
 * This is the app's first combobox, and the repo has no a11y linter
 * (`docs/tech-debt.md`), so review attention is the only gate on the pattern
 * below. Every choice, explicitly:
 *
 * - The **input** carries `role="combobox"`, `aria-expanded`, `aria-controls`
 *   naming the popup, and `aria-autocomplete="list"` — the value is never
 *   rewritten by the app, so it is the list that completes, not the text.
 * - **Focus never leaves the input.** The active option is pointed at with
 *   `aria-activedescendant`, which is what lets ArrowDown move the highlight
 *   while the reader keeps typing into a field that still has the caret. The
 *   options are therefore `<li>`s and not buttons: a focusable option would
 *   contradict the attribute that says focus is elsewhere.
 * - **`aria-selected` marks the active option**, and only ever one of them. In a
 *   single-select listbox driven by `aria-activedescendant` that attribute *is*
 *   the highlight, so it is set from the same index the id points at rather than
 *   from a second piece of state free to disagree.
 * - **The first match is active on arrival.** Typing a name and pressing Enter
 *   is the whole gesture this control exists for, and a pattern that demanded an
 *   ArrowDown first would make the common case two keystrokes longer for no
 *   ambiguity it resolves.
 * - **`aria-controls` names an id that only exists while the popup is open.**
 *   That is the APG's own shape for a collapsed combobox; the alternative —
 *   rendering an empty listbox permanently — announces a list with nothing in it
 *   on every page load.
 * - **No matches is a disabled option, not an empty list or silence.** A listbox
 *   may contain only options, so the message is one `role="option"` marked
 *   `aria-disabled` — it is announced with the popup, it is never the active
 *   descendant, and Enter on it does nothing because there is no site to select.
 *
 * Presentational (`react.md` rule 4): it holds the query and the highlight, which
 * are this control's own, and nothing else. Which site is selected belongs to the
 * dashboard, because the markers, the rows and the chart all read it.
 */
export const SiteSearch = ({ sites, onSelectSite }: SiteSearchProps): ReactElement => {
  const [query, setQuery] = useState('');
  const [listOpen, setListOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);

  const baseId = useId();
  const listboxId = `${baseId}-listbox`;
  const optionId = (index: number): string => `${baseId}-option-${String(index)}`;

  // Derived during render rather than mirrored into state (`react.md` rule 1):
  // the matches are a function of the query and the fleet, and a copy in state
  // would be a copy free to go stale the moment a site is added.
  const matches = matchingSites(sites, query);
  const expanded = listOpen && query.length > 0;
  // Clamped here rather than trusted from state: the fleet can gain a site while
  // a query is open, so the match list can shrink under an index that was valid
  // when it was set. `-1` on an empty list, which reads out as no highlight.
  const activeIndexInRange = Math.min(activeIndex, matches.length - 1);
  const activeSite = matches[activeIndexInRange] ?? null;

  const select = (site: Site): void => {
    onSelectSite(site.id);
    // Cleared on the way out, so the next search starts from the fleet rather
    // than from the last answer — and so the popup cannot sit open over the map
    // describing a selection the reader has already made.
    setQuery('');
    setListOpen(false);
    setActiveIndex(0);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      // Otherwise the browser's own meaning for these keys — jump the caret to
      // either end of the text — fires as well as the highlight moving.
      event.preventDefault();

      if (!expanded) {
        setListOpen(true);
        return;
      }

      const step = event.key === 'ArrowDown' ? 1 : -1;
      setActiveIndex((current) => stepActiveIndex(current, step, matches.length));
      return;
    }

    if (event.key === 'Enter' && expanded && activeSite !== null) {
      event.preventDefault();
      select(activeSite);
      return;
    }

    if (event.key === 'Escape') {
      setListOpen(false);
    }
  };

  return (
    <div className="site-search">
      <input
        type="text"
        className="site-search-input"
        role="combobox"
        aria-label={SEARCH_LABEL}
        aria-expanded={expanded}
        aria-controls={listboxId}
        aria-autocomplete="list"
        aria-activedescendant={activeSite === null ? undefined : optionId(activeIndexInRange)}
        autoComplete="off"
        placeholder={SEARCH_PLACEHOLDER}
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setListOpen(event.target.value.length > 0);
          setActiveIndex(0);
        }}
        onKeyDown={handleKeyDown}
        onBlur={() => {
          setListOpen(false);
        }}
      />

      {expanded && (
        <ul className="site-search-listbox" id={listboxId} role="listbox" aria-label={SEARCH_LABEL}>
          {matches.length === 0 ? (
            <li
              className="site-search-option site-search-option-empty"
              role="option"
              aria-disabled={true}
              aria-selected={false}
            >
              {NO_MATCHES_LABEL}
            </li>
          ) : (
            matches.map((site, index) => (
              <li
                key={site.id}
                id={optionId(index)}
                className="site-search-option"
                role="option"
                aria-selected={index === activeIndexInRange}
                // `mousedown` rather than `click`, with the default prevented:
                // the input's blur would otherwise close the popup out from
                // under the pointer before the click landed on anything.
                onMouseDown={(event) => {
                  event.preventDefault();
                  select(site);
                }}
              >
                <span className="site-search-option-name">{site.name}</span>
                <span className="site-search-option-capacity">
                  {capacityLabel(site.capacityKw)}
                </span>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
};
