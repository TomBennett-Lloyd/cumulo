import type { ReactElement } from 'react';
import { useState } from 'react';
import { Dashboard } from './dashboard/Dashboard';
import { DemoFleetDataSource } from './data/demo-fleet-data-source';
import type { FleetDataSource } from './data/fleet-data-source';
import type { Theme } from './theme';
import { ThemeToggle } from './ThemeToggle';
import { useTheme } from './use-theme';
import { FleetAggregateView } from './views/FleetAggregateView';
import { SiteDetailView } from './views/SiteDetailView';

/**
 * The web app shell: a view switcher, the theme toggle, and the one place the
 * app decides where its data comes from.
 *
 * Three surfaces sit behind the nav — the fleet map a visitor can add a site to,
 * the fleet aggregate, and one site's forecast against its measurements. The
 * switcher is local state rather than a router: there is no URL to share yet,
 * and a router is a decision in its own right rather than something to arrive
 * at sideways here.
 *
 * Theming is deliberately not spelled out here: `useTheme` owns the whole
 * mechanism — where the app starts, the document attribute, the persisted
 * choice — and the shell only says where the toggle sits and passes the theme
 * down to the map, which paints its basemap in it. The token gallery consumes
 * the same hook, so what a reviewer checks on that page is what ships here.
 */

type View = 'map' | 'fleet' | 'site';

interface ViewOption {
  readonly id: View;
  readonly label: string;
}

const VIEW_OPTIONS: readonly ViewOption[] = [
  { id: 'map', label: 'Fleet map' },
  { id: 'fleet', label: 'Fleet aggregate' },
  { id: 'site', label: 'Site forecast' },
];

/**
 * The map opens the app: it is the surface a visitor can act on — add a site,
 * watch its first forecast arrive — and the charts explain what came out.
 */
const DEFAULT_VIEW: View = 'map';

/**
 * The app's fleet, chosen once at module scope.
 *
 * One source for every surface — the map dashboard that writes to the fleet and
 * the two chart views that read it — which is what makes a site added on the map
 * a site the fleet aggregate counts. `apps/web` briefly had two of these, built
 * in parallel against two interfaces (#105); this single binding is what closing
 * that issue means in practice.
 *
 * Every view takes the source as a prop and holds no opinion about which one it
 * got, so this line is the whole seam: the deterministic demo fleet today, the
 * HTTP source over the Fleet API (#14) once that is deployed. Choosing per
 * render would give two mounted views two different fleets.
 */
const fleetDataSource: FleetDataSource = new DemoFleetDataSource();

interface ViewNavProps {
  readonly view: View;
  readonly onSelect: (view: View) => void;
}

const ViewNav = (props: ViewNavProps): ReactElement => (
  <nav className="app-nav" aria-label="Views">
    {VIEW_OPTIONS.map((option) => (
      <button
        key={option.id}
        type="button"
        className="app-nav-button"
        aria-pressed={option.id === props.view}
        onClick={() => {
          props.onSelect(option.id);
        }}
      >
        {option.label}
      </button>
    ))}
  </nav>
);

/**
 * The switcher unmounts the view it leaves rather than hiding it: a mounted
 * chart holds an in-flight provider query, and keeping several alive would make
 * the nav a fan-out of requests nobody is looking at. The map pays that rule
 * differently — leaving it tears down the maplibre instance and rebuilds it on
 * return, which costs a basemap fetch but keeps one WebGL context in play.
 */
const viewBody = (view: View, dataSource: FleetDataSource, theme: Theme): ReactElement => {
  if (view === 'map') {
    return <Dashboard theme={theme} dataSource={dataSource} />;
  }
  if (view === 'fleet') {
    return <FleetAggregateView dataSource={dataSource} />;
  }
  return <SiteDetailView dataSource={dataSource} />;
};

export interface AppProps {
  /**
   * The view to open on; defaults to {@link DEFAULT_VIEW}.
   *
   * This is the seam a router fills once `apps/web` has one — a URL decides the
   * view, and until then the default does. It is also the only way the shell can
   * be tested: the map view loads maplibre through a dynamic import and mounts
   * it, and maplibre needs WebGL, which jsdom does not implement — so a test
   * opening on the default gets the loading placeholder, then a failure the
   * moment that chunk resolves. The tests therefore open on views they can
   * render through. That leaves the shipping default asserted by nothing in
   * this suite — a real gap, logged in `docs/tech-debt.md` and tracked as #107,
   * and one only a browser harness closes.
   */
  readonly initialView?: View;
}

export const App = ({ initialView = DEFAULT_VIEW }: AppProps = {}): ReactElement => {
  const { theme, toggle } = useTheme();
  const [view, setView] = useState<View>(initialView);

  return (
    <div className="app">
      <header className="app-header">
        <div>
          <h1 className="app-title">Cumulo</h1>
          <p className="app-subtitle">
            Residential solar fleet forecasting. Sites on a map you can add to, modelled output with
            its uncertainty band against what the panels actually generated — per site and summed
            across the fleet.
          </p>
        </div>
        <ThemeToggle theme={theme} onToggle={toggle} />
      </header>

      <ViewNav view={view} onSelect={setView} />

      {viewBody(view, fleetDataSource, theme)}
    </div>
  );
};
