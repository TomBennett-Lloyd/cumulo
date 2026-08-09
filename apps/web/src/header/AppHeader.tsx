import type { Site } from '@cumulo/shared';
import type { ReactElement } from 'react';

import type { Theme } from '../theme';
import { Brand } from './Brand';
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
 * The header bar: the product's name on the left, the fleet's index in the
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
 * a shell that has none anywhere (#265). The search takes the space the brand
 * and the menu leave, and wraps to its own line when there is not enough of it.
 *
 * What the product is has left the bar entirely (#284 D13). It was a line of
 * prose here, then a toggletip beside the brand once #265 decided the bar's
 * height was the map's to have — and the toggletip kept the cost the prose had
 * only reduced: a control on the bar, in the tab order ahead of the search,
 * saying a sentence the About dialog two presses away already says in full.
 * `PRODUCT_TAGLINE` stays where it was (`header-copy.ts`) because that dialog
 * still quotes it; what went is the second carrier, not the words.
 */
export const AppHeader = ({
  theme,
  onToggleTheme,
  sites,
  onSelectSite,
}: AppHeaderProps): ReactElement => (
  <header className="app-header">
    <Brand />
    <SiteSearch sites={sites} onSelectSite={onSelectSite} />
    <HeaderMenu theme={theme} onToggleTheme={onToggleTheme} />
  </header>
);
