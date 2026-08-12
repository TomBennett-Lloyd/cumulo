import type { Site } from '@cumulo/shared';
import type { KeyboardEvent, ReactElement } from 'react';
import { useRef, useState } from 'react';
import { flushSync } from 'react-dom';

import type { Theme } from '../theme';
import { Brand } from './Brand';
import { HeaderMenu } from './HeaderMenu';
import { SiteSearch } from './SiteSearch';

/**
 * The name the icon carries, since the icon carries nothing else.
 *
 * `Search sites`, not the field's own `Search sites by name`: this control opens
 * the search, and the field it opens keeps its own longer name. Two controls
 * announced identically would be two things a voice-control user cannot tell
 * apart by saying either.
 */
const SEARCH_TOGGLE_LABEL = 'Search sites';

export interface AppHeaderProps {
  /** The theme in force, passed through to the toggle inside the menu. */
  readonly theme: Theme;
  /** What flipping the theme means — ordinarily the `toggle` from `useTheme`. */
  readonly onToggleTheme: () => void;
  /** The fleet the search searches: the listing, plus anything created this session. */
  readonly sites: readonly Site[];
  /** Selecting a match, which is the dashboard's own reader-initiated selection. */
  readonly onSelectSite: (siteId: Site['id']) => void;
}

/**
 * The header bar: the product's name on the left, the fleet's index in the
 * middle, and everything else behind one control on the right — the middle item
 * being a field only while the row is wide enough to hold one, and an icon
 * beside that control below the breakpoint (the section on it below).
 *
 * A component of its own, and rendered by `Dashboard` rather than by `App`,
 * because of the middle item. `SiteSearch` needs the fleet and it selects into
 * the same `selectedSiteId` the markers read, and both of those
 * live in the dashboard — so either the bar moves down to the state or the state
 * moves up to the bar. Moving the state up would put the fleet listing, the
 * selection and the first-forecast poll in the shell purely so a text input
 * could see them, which is the larger of the two changes by a distance.
 *
 * The cost of that choice, stated because it is real: the bar is inside
 * `AppErrorBoundary` now, so a render failure below takes the header with it
 * rather than leaving the brand and the theme toggle standing over a failure
 * card. `App.test.tsx` pins that as an assertion rather than leaving it to be
 * discovered, and the boundary still discharges the Open-Meteo credit itself,
 * which is the part that is a licence obligation rather than chrome.
 *
 * Layout is `app.css`'s `.app-header` — one wrapping flex row. The search takes
 * the space the brand and the menu leave, down to a basis wide enough to read a
 * site name in.
 *
 * What the product is has left the bar entirely (#284 D13). It was a line of
 * prose here, then a toggletip beside the brand once #265 decided the bar's
 * height was the map's to have — and the toggletip kept the cost the prose had
 * only reduced: a control on the bar, in the tab order ahead of the search,
 * saying a sentence the About dialog two presses away already says in full.
 * `PRODUCT_TAGLINE` stays where it was (`header-copy.ts`) because that dialog
 * still quotes it; what went is the second carrier, not the words.
 *
 * ## Where the bar runs out, the search folds behind an icon
 *
 * Below the width at which the brand, the field and the menu stop fitting on one
 * line, the row used to wrap and the bar became two lines tall — 63px of chrome
 * becoming 114px, all of it height the map does not get, which is the same
 * weighing `HeaderMenu.tsx` states and the reason that button exists at all. So
 * at those widths the field is replaced by an icon of its own and opens a
 * full-width bar directly under the row, which is one line tall while it is up
 * and no lines tall the rest of the time.
 *
 * The width itself is `header.css`'s and is measured rather than picked; that
 * file owns the number and the argument for it. Nothing here knows it, which is
 * the point — this component renders both the field and the toggle at every
 * width and the stylesheet decides which of them a reader is looking at. A
 * JavaScript breakpoint would put the same decision behind a resize listener and
 * a re-render, and would answer differently for the first frame after load.
 *
 * That means two `SiteSearch` renderings, not one moved between two places.
 * React has no way to move a live element between parents without a portal, and
 * a portal would buy state continuity across a resize nobody performs mid-query
 * at the price of a second tree to reason about. What it does mean is that the
 * *closed* state has to be genuinely closed: exactly one of the two is ever in
 * the accessibility tree, because the wide copy is `display: none` below the
 * breakpoint, the bar is `display: none` above it, and the bar is not rendered
 * at all until the toggle is pressed.
 *
 * ## The focus happens inside the press, not after it
 *
 * `flushSync` around the state change is load-bearing rather than defensive.
 * React 19 batches an event handler's updates and commits them after the handler
 * returns, so a plain `setSearchOpen(true)` followed by `focus()` would call
 * `focus()` on a ref that is still `null` — the input is not in the document
 * yet. Focusing from an effect on the next render would fix the ordering and
 * break the thing the ordering is for: iOS and Android raise the on-screen
 * keyboard only for a `focus()` that happens inside the user gesture that asked
 * for it, and an effect runs after that gesture is over. Flushing the commit
 * inside the handler is what keeps both true at once — the field exists, and the
 * press is still in progress when it takes the focus. `AppHeader.test.tsx`
 * asserts `document.activeElement` after the press, which is exactly the
 * assertion that fails if the wrapper goes.
 *
 * ## Two dismissals, and why they are one press rather than two
 *
 * Escape hands the focus back to the toggle, which is `HeaderMenu`'s idiom for
 * the same reason: the control the reader is standing on is about to unmount.
 * Blur closes the bar too — a search bar left standing over the map after the
 * reader has gone elsewhere is chrome nobody asked to keep.
 *
 * That blur arm takes any focus-out at all, which is right only while the bar
 * holds one focusable thing, and the reasons it does are `SiteSearch`'s
 * internals rather than anything visible from here. `docs/tech-debt.md` carries
 * that dependency, and the shared `relatedTarget` rule three components now want,
 * as its own entry; the pointer is bidirectional, so neither end can be edited
 * in ignorance of the other.
 *
 * Escape dismisses the whole bar in one press even when the combobox's own popup
 * is open under it, and that is deliberately unlike the menu's dialog-then-
 * popover pair. There, two surfaces sat one inside the other and each had
 * content of its own to go back to. Here the bar holds the search and nothing
 * else, so a two-step Escape would make a reader press twice to leave a surface
 * one press opened, in order to land back on a field that is about to disappear
 * anyway.
 *
 * The toggle opens rather than toggles, despite carrying `aria-expanded`. A
 * press while the bar is open necessarily blurs the field first, which has
 * already closed it — so by the time the click arrives there is nothing left to
 * collapse and re-opening is the only thing the press can honestly mean.
 */
export const AppHeader = ({
  theme,
  onToggleTheme,
  sites,
  onSelectSite,
}: AppHeaderProps): ReactElement => {
  const [searchOpen, setSearchOpen] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const barInputRef = useRef<HTMLInputElement>(null);

  const handleBarKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    /*
     * The same guard, on the same key, that `SiteSearch.tsx` documents at the
     * top of its own keydown handler — and it is owed twice because this is a
     * second listener on one press: the field's keydown bubbles up to this
     * wrapper, so an Escape abandoning a composition arrives here after the
     * search itself has correctly ignored it, and would take the whole bar away
     * from a reader who was mid-word. Why the composition owns the key is that
     * file's argument; this is the second listener obeying it.
     */
    if (event.nativeEvent.isComposing) {
      return;
    }

    if (event.key === 'Escape') {
      setSearchOpen(false);
      toggleRef.current?.focus();
    }
  };

  return (
    <header className="app-header">
      <Brand />
      <SiteSearch sites={sites} onSelectSite={onSelectSite} />

      <button
        type="button"
        className="header-search-toggle"
        ref={toggleRef}
        aria-label={SEARCH_TOGGLE_LABEL}
        aria-expanded={searchOpen}
        onClick={() => {
          flushSync(() => {
            setSearchOpen(true);
          });
          barInputRef.current?.focus();
        }}
      >
        {/* A magnifier, `aria-hidden` for `Brand.tsx`'s reason: a mark that says
            nothing the button's name does not already say should not be in the
            accessibility tree twice. Drawn here rather than fetched, and its
            weight and colour are `header.css`'s, exactly as the burger's are. */}
        <svg className="header-search-icon" viewBox="0 0 20 20" aria-hidden="true">
          <circle cx="9" cy="9" r="5" />
          <path d="M12.5 12.5 17 17" />
        </svg>
      </button>

      <HeaderMenu theme={theme} onToggleTheme={onToggleTheme} />

      {searchOpen ? (
        <div
          className="header-search-bar"
          onKeyDown={handleBarKeyDown}
          onBlur={() => {
            setSearchOpen(false);
          }}
        >
          <SiteSearch sites={sites} onSelectSite={onSelectSite} inputRef={barInputRef} />
        </div>
      ) : null}
    </header>
  );
};
