import type { ReactElement } from 'react';
import { MapView } from '../map/MapView';
import type { Theme } from '../theme';

export interface DashboardProps {
  readonly theme: Theme;
}

/**
 * The fleet dashboard: the map, and the column beside it where the fleet is
 * also readable as text.
 *
 * This is the layout skeleton. The aside's slots are empty on purpose — the
 * site list, the detail panel and the add-site form are built separately and
 * wired in here once they exist, so this file's only current job is to fix the
 * two-region shape they land in.
 *
 * That shape is a design obligation rather than a layout preference:
 * `docs/design/map-treatment.md` requires the list beside the map as the table
 * view, so that every marker state has a row equivalent and the map is never
 * the only way to reach a site. The aside is that guarantee, reserved before
 * anything fills it.
 */
export const Dashboard = ({ theme }: DashboardProps): ReactElement => (
  <div className="dashboard">
    <div className="dashboard-map">
      <MapView theme={theme} />
    </div>

    <aside className="dashboard-aside">
      <section className="dashboard-slot" aria-labelledby="dashboard-sites-heading">
        <h2 className="dashboard-slot-heading" id="dashboard-sites-heading">
          Sites
        </h2>
        <p className="dashboard-slot-note">The fleet list appears here.</p>
      </section>

      <section className="dashboard-slot" aria-labelledby="dashboard-detail-heading">
        <h2 className="dashboard-slot-heading" id="dashboard-detail-heading">
          Site detail
        </h2>
        <p className="dashboard-slot-note">
          Selecting a site — on the map or in the list — opens its forecast here.
        </p>
      </section>
    </aside>
  </div>
);
