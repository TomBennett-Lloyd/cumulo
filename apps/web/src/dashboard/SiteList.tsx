import type { Site } from '@cumulo/shared';
import type { ReactElement } from 'react';

import { capacityLabel } from './site-format';

export interface SiteListProps {
  readonly sites: readonly Site[];
  readonly selectedSiteId: Site['id'] | null;
  readonly onSelectSite: (siteId: Site['id']) => void;
}

/**
 * The fleet as rows — the map's table view.
 *
 * `map-treatment.md` requires it: the marker palette carries a documented
 * contrast warning in light mode, so colour is never allowed to carry a state
 * alone, and every marker state needs a row equivalent. That is why the rows
 * borrow the *marker* tokens for hover and selection instead of a generic
 * highlight — the same state wears the same colour in both views — and why
 * selection is also announced (`aria-current`) and set in a heavier weight,
 * which a reader who cannot separate the hues still gets.
 *
 * Each row is a real `<button>`, not a clickable `<li>`. That single choice is
 * what makes the list keyboard-reachable, focusable in site order and
 * announced as actionable, with no key handling of our own to get wrong.
 *
 * `data-site-id` is how the dashboard finds one row again: closing a site panel
 * unmounts the Close button under the reader's focus, and the row that opened
 * the panel is where that focus belongs. An attribute rather than a ref per row
 * because the list is unbounded and the dashboard wants exactly one of them,
 * once, in an event handler.
 *
 * Presentational (`react.md` rule 4): it holds no selection state and fetches
 * nothing. The dashboard owns `selectedSiteId`, because the map markers read
 * the very same value.
 */
export const SiteList = ({ sites, selectedSiteId, onSelectSite }: SiteListProps): ReactElement => (
  <ul className="site-list" aria-label="Fleet sites">
    {sites.map((site) => {
      const selected = site.id === selectedSiteId;

      return (
        <li key={site.id}>
          <button
            type="button"
            className={selected ? 'site-row site-row-selected' : 'site-row'}
            aria-current={selected ? true : undefined}
            data-site-id={site.id}
            onClick={() => {
              onSelectSite(site.id);
            }}
          >
            <span className="site-row-name">{site.name}</span>
            <span className="site-row-capacity">{capacityLabel(site.capacityKw)}</span>
          </button>
        </li>
      );
    })}
  </ul>
);
