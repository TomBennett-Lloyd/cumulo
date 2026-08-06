import type { Site } from '@cumulo/shared';
import type { ReactElement } from 'react';

import { capacityLabel, coordinatesLabel } from './site-format';

export interface SiteTableProps {
  readonly sites: readonly Site[];
  readonly selectedSiteId: Site['id'] | null;
  readonly onSelectSite: (siteId: Site['id']) => void;
}

/**
 * The fleet as a table, behind a disclosure — the map's table view.
 *
 * `map-treatment.md` requires the view itself: the marker palette carries a
 * documented contrast warning in light mode, so colour is never allowed to carry
 * a state alone, every marker state needs a row equivalent, and the map is never
 * the only way to reach a site. That is why the rows borrow the *marker* tokens
 * for hover and selection instead of a generic highlight — the same state wears
 * the same colour in both views — and why selection is also announced
 * (`aria-current`) and set in a heavier weight, which a reader who cannot
 * separate the hues still gets.
 *
 * What changed in #265 is its *prominence*, not its existence. Looking a site up
 * by name is the header search's job now (`header/SiteSearch.tsx`), and sixty
 * rows open under a chart pushed everything else off the page to serve a lookup
 * a combobox answers in three keystrokes. So the table is collapsed by default:
 * still one keystroke away, still the equivalent the treatment demands, and no
 * longer the tallest thing on the page. The disclosure is a native
 * `<details>`/`<summary>` rather than a button toggling state — the platform
 * gives the open/closed semantics, the keyboard operation and the announcement
 * for free, and none of it is ours to get wrong.
 *
 * The summary counts the fleet from `sites.length` and never from a literal.
 * Fleet size is a value with a known prose-restatement family (#249 owns the
 * class): sixty is the seed's, the demo's answer today, and a table that spelled
 * it would be wrong the moment a reader added a site.
 *
 * A real `<table>`, so the three facts each site has are three columns with
 * headers rather than a run-on line, and the name cell is a `<th scope="row">`:
 * the name is what identifies the row, and it is what the other two cells are
 * about. Each name cell holds a real `<button>`, not a clickable cell. That
 * single choice is what makes the fleet keyboard-reachable, focusable in site
 * order and announced as actionable, with no key handling of our own.
 *
 * `data-site-id` names each row's site on the element itself. Nothing in the app
 * reads it — the focus hand-off that used to search the list for a row is a
 * capture-and-restore inside the site's card (`map/SitePopoverCard.tsx`), which
 * is the same answer for every opener rather than only for a row. What still
 * reads it is the browser lane, where it is how a spec says "a site row" without
 * knowing the fleet: `e2e/site-table.ts` opens the disclosure and hands one over,
 * and `e2e/composition.spec.ts` counts them — a closed `<details>` keeps its
 * children in the DOM, so the count holds either way.
 *
 * Presentational (`react.md` rule 4): it holds no selection state and fetches
 * nothing. The dashboard owns `selectedSiteId`, because the map markers read the
 * very same value.
 */
export const SiteTable = ({
  sites,
  selectedSiteId,
  onSelectSite,
}: SiteTableProps): ReactElement => (
  <details className="site-table">
    <summary className="site-table-summary">Sites ({sites.length})</summary>

    <table className="site-table-grid" aria-label="Fleet sites">
      <thead>
        <tr>
          <th scope="col">Name</th>
          <th scope="col">Capacity</th>
          <th scope="col">Coordinates</th>
        </tr>
      </thead>
      <tbody>
        {sites.map((site) => {
          const selected = site.id === selectedSiteId;

          return (
            <tr key={site.id}>
              <th scope="row" className="site-table-name">
                <button
                  type="button"
                  className={
                    selected ? 'site-table-select site-table-select-selected' : 'site-table-select'
                  }
                  aria-current={selected ? true : undefined}
                  data-site-id={site.id}
                  onClick={() => {
                    onSelectSite(site.id);
                  }}
                >
                  {site.name}
                </button>
              </th>
              <td className="site-table-number">{capacityLabel(site.capacityKw)}</td>
              <td className="site-table-number">{coordinatesLabel(site)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  </details>
);
