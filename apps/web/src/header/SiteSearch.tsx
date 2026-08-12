import type { Site } from '@cumulo/shared';
import type { KeyboardEvent, ReactElement, RefObject } from 'react';
import { useId, useState } from 'react';

import { capacityLabel } from '../dashboard/site-format';

/**
 * How many matches the popup offers at once.
 *
 * A ceiling on the *list*, not on the search: a query that matches most of the
 * fleet still shows only this many, because a popup taller than the map it hangs
 * over stops being a shortcut and starts being a second site list. Narrowing the
 * query is the affordance for the rest, and it is one more keystroke.
 *
 * That the cap is silent — nothing says how many matched — is recorded in
 * `docs/tech-debt.md` rather than answered here, because the count it wants is
 * copy with an owner (`dashboard/state-copy.ts`).
 */
const MAX_VISIBLE_MATCHES = 8;

/**
 * The control's accessible name, and the hint inside it.
 *
 * Both live here rather than in `header-copy.ts`: that module owns what the
 * *product* says about itself (its one tagline, which the About dialog is now
 * the only carrier of), and these are a control's name and placeholder with a
 * single carrier apiece. `dashboard/state-copy.ts` is not their home either —
 * it owns the app's pending, failure and empty-fleet vocabulary, and this is
 * none of the three.
 */
const SEARCH_LABEL = 'Search sites by name';
const SEARCH_PLACEHOLDER = 'Search sites';

/**
 * What the status region says once a site has been picked.
 *
 * Copy this control owns, for the same reason as the two above: it is a widget
 * describing its own answer to the reader who just used it, and
 * `dashboard/state-copy.ts` owns the app's pending, failure and empty-fleet
 * vocabulary — none of which this is. `header-copy.ts` is not its home either;
 * that module says what the *product* is, and this says what just happened.
 *
 * A function rather than a template spelled at the call site so the sentence,
 * word order included, is legible in one place — the name leads because it is
 * what the reader was hunting for, and a screen reader reaching them mid-word
 * has said the useful half first.
 */
const selectionAnnouncement = (name: string): string => `${name} selected`;

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
 * ArrowDown to the end of the list never finds themselves back at the top
 * wondering whether they missed one.
 */
const stepActiveIndex = (current: number, step: number, count: number): number =>
  Math.max(0, Math.min(current + step, count - 1));

export interface SiteSearchProps {
  /** Everything the fleet knows about, listing plus anything created this session. */
  readonly sites: readonly Site[];
  /** Selecting a match — the dashboard's own reader-initiated selection. */
  readonly onSelectSite: (siteId: Site['id']) => void;
  /**
   * A handle on the field, for a caller that has to focus it itself.
   *
   * Optional, and unset on the copy that sits on the bar: nothing focuses that
   * one but the reader. `AppHeader` passes one to the copy inside the collapsed
   * search bar because opening that bar and putting the caret in it are one
   * gesture, and a mobile browser only raises its keyboard for a `focus()` made
   * inside the press that asked for it — so the focus cannot wait for an effect
   * a render later (`AppHeader.tsx` states the whole of it).
   *
   * A ref rather than an `autoFocus` prop, because `autoFocus` fires on mount
   * and this control is also mounted permanently on the wide bar, where taking
   * the focus on arrival would steal it from a reader who did nothing to ask.
   */
  readonly inputRef?: RefObject<HTMLInputElement | null>;
}

/**
 * Find a site by name from the header, without hunting the map for it.
 *
 * The fleet is sixty markers on two islands, most of them in knots that only
 * separate two or three zooms in. Reaching one site therefore meant either
 * scrolling the list under the map or expanding clusters until the marker
 * appeared — so the header carries the fleet's index, and a selection made here
 * is the same selection a marker makes.
 *
 * ## The ARIA semantics, stated because nothing lints them
 *
 * This is the app's first combobox, and the repo has no a11y linter — it is a
 * member of `docs/tech-debt.md`'s "No a11y linting" entry, which names this
 * file in return — so review attention is the only gate on the pattern below.
 * Every choice, explicitly:
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
 *   on every page load. `aria-activedescendant` is the opposite case and is
 *   dropped entirely while the popup is closed: `aria-controls` may name a
 *   popup that is not currently rendered, but an active descendant that
 *   resolves to no element is simply an invalid value.
 * - **A selection is announced, because it is no longer anywhere to be seen.**
 *   Focus stays in the input (`design.md` rule 11), the input's value is cleared
 *   rather than rewritten, and the card opens over a map that may be nowhere near
 *   the reader's attention — so a `role="status"` region carries the hit. Its
 *   rules are stated where it is rendered, below.
 * - **No matches is a disabled option, not an empty list or silence.** A listbox
 *   may contain only options, so the message is one `role="option"` marked
 *   `aria-disabled` — it is announced with the popup, it is never the active
 *   descendant, and Enter on it does nothing because there is no site to select.
 *
 * Presentational (`react.md` rule 4): it holds the query and the highlight, which
 * are this control's own, and nothing else. Which site is selected belongs to the
 * dashboard, because the markers and the chart both read it.
 */
export const SiteSearch = ({ sites, onSelectSite, inputRef }: SiteSearchProps): ReactElement => {
  const [query, setQuery] = useState('');
  const [listOpen, setListOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [announcement, setAnnouncement] = useState('');

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
  /*
   * The highlighted option's id — and only while the popup is on screen.
   *
   * `aria-activedescendant` names an element, so an id that resolves to nothing
   * is an invalid value rather than a harmless leftover, and the states it would
   * dangle in are the ones this control spends most of its life in: first paint
   * (an empty query matches the whole fleet, so there is a match without a list
   * to hold it), after Escape with text still in the field, after a blur, and in
   * the instant after a selection clears the query.
   */
  const activeOptionId = expanded && activeSite !== null ? optionId(activeIndexInRange) : undefined;

  const select = (site: Site): void => {
    onSelectSite(site.id);
    // The whole of what a reader is told, now that a selection moves the focus
    // nowhere (#328, `design.md` rule 11). The card opens over a map the reader
    // is not looking at and the field they are still standing in goes blank, so
    // without this the answer to a search is silence.
    setAnnouncement(selectionAnnouncement(site.name));
    // Cleared on the way out, so the next search starts from the fleet rather
    // than from the last answer — and so the popup cannot sit open over the map
    // describing a selection the reader has already made.
    setQuery('');
    setListOpen(false);
    setActiveIndex(0);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    /*
     * An input method's candidate window owns all three of these keys while it
     * is up: the arrows move through the candidates it is offering, and Enter
     * commits the one the reader has settled on. Acting on them here would
     * select a site with the very press that finishes a Japanese or Chinese
     * word, and would `preventDefault` the navigation the candidate list needs
     * — so the composition is left entirely alone and the keys mean what they
     * mean again once it ends.
     *
     * Read off the native event because that is where the flag lives; React's
     * synthetic event wraps it rather than restating it.
     */
    if (event.nativeEvent.isComposing) {
      return;
    }

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
        ref={inputRef}
        role="combobox"
        aria-label={SEARCH_LABEL}
        aria-expanded={expanded}
        aria-controls={listboxId}
        aria-autocomplete="list"
        aria-activedescendant={activeOptionId}
        autoComplete="off"
        placeholder={SEARCH_PLACEHOLDER}
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setListOpen(event.target.value.length > 0);
          setActiveIndex(0);
          // A reader typing again has moved on from the last answer, and a
          // region still holding it would repeat that answer the next time a
          // *different* site is picked only if the words happened to differ.
          // Emptying it here means every selection is a change to an empty
          // region, including the one that picks the same site twice.
          setAnnouncement('');
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

      {/*
       * What a selection says, given that it now says nothing by moving.
       *
       * Mounted from first paint and empty until a reader picks something
       * (`react.md`'s first-paint rule): an announcement reaches anybody only by
       * *arriving* in a region that was already there, so a region rendered with
       * its text already inside it would look accessible and announce nothing.
       *
       * The header panel's one live region, and it stays the only one
       * (`react.md`'s at-most-one rule). The two `SiteSearch` renderings do not
       * make it two: exactly one of them is ever in the accessibility tree —
       * `AppHeader.tsx` owns that fact and the breakpoint arithmetic behind it —
       * so the copy that can fill this is always the copy the reader is using,
       * and the hidden one is never filled because nothing can type into it.
       */}
      <p role="status" className="site-search-status">
        {announcement}
      </p>
    </div>
  );
};
