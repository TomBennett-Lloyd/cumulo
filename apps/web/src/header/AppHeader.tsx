import type { Site } from '@cumulo/shared';
import type { ReactElement } from 'react';

import { InfoTip } from '../info/InfoTip';
import type { Theme } from '../theme';
import { Brand } from './Brand';
import { PRODUCT_TAGLINE } from './header-copy';
import { HeaderMenu } from './HeaderMenu';
import { SiteSearch } from './SiteSearch';

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
 * The header bar: what the product is on the left, the fleet's index in the
 * middle, and everything else behind one control on the right.
 *
 * A component of its own, and rendered by `Dashboard` rather than by `App`,
 * because of the middle item. `SiteSearch` needs the fleet and it selects into
 * the same `selectedSiteId` the markers and the rows read, and both of those
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
 * Layout is `app.css`'s `.app-header` — one wrapping flex row, no breakpoint, in
 * a shell that has none anywhere (#265). The search takes the space the brand,
 * the product's (i) and the menu leave, and wraps to its own line when there is
 * not enough of it,
 * which is the same thing the tagline used to do when it was a line of prose on
 * the bar rather than the (i) beside the brand it is now (`info/InfoTip.tsx`).
 */
export const AppHeader = ({
  theme,
  onToggleTheme,
  sites,
  onSelectSite,
}: AppHeaderProps): ReactElement => (
  <header className="app-header">
    <Brand />
    {/*
     * What the product is, one press away rather than always on the bar (#265).
     * The bar is height the map does not get, and a sentence every reader has
     * read by their second visit was spending that height on every render. The
     * words are still `header-copy.ts`'s — this moved where they are shown, not
     * what they say, and the About dialog behind the menu still quotes the same
     * constant for the reader who wants more than a tip.
     */}
    <InfoTip label="About this product">{PRODUCT_TAGLINE}</InfoTip>
    <SiteSearch sites={sites} onSelectSite={onSelectSite} />
    <HeaderMenu theme={theme} onToggleTheme={onToggleTheme} />
  </header>
);
