import type { ReactElement } from 'react';

import { AppErrorBoundary } from './AppErrorBoundary';
import { Dashboard } from './dashboard/Dashboard';
import type { MapRegionComponent } from './dashboard/MapRegion';
import type { FleetDataSource } from './data/fleet-data-source';
import { selectFleetDataSource } from './data/fleet-source-selection';
import { ThemeToggle } from './ThemeToggle';
import { useTheme } from './use-theme';

/**
 * The web app shell: a compact header bar, the theme toggle, and the one place
 * the app decides where its data comes from.
 *
 * There is one surface now. The nav that toggled three unmounted-on-leave views
 * is gone (#148): the map is the canvas, the panel column beside it tells the
 * fleet's story or one site's, and moving between them is a selection rather
 * than a page change. That deletes the shell's only state — nothing here is
 * switched any more — so the shell's whole job is the frame around the
 * dashboard and the boundary under it.
 *
 * Theming is deliberately not spelled out here: `useTheme` owns the whole
 * mechanism — where the app starts, the document attribute, the persisted
 * choice — and the shell only says where the toggle sits and passes the theme
 * down to the map, which paints its basemap in it. The token gallery consumes
 * the same hook, so what a reviewer checks on that page is what ships here.
 */

/**
 * The app's fleet, chosen once at module scope.
 *
 * One source for the whole surface — the map that writes to the fleet and the
 * panels that read it — which is what makes a site added on the map a site the
 * fleet aggregate counts. `apps/web` briefly had two of these, built in
 * parallel against two interfaces (#105); this single binding is what closing
 * that issue means in practice.
 *
 * The dashboard takes the source as a prop and holds no opinion about which one
 * it got, so this line is the whole seam: the deterministic demo fleet unless
 * the build was pointed at a deployed Fleet API, in which case the HTTP source
 * over it. Choosing per render would hand each render a different fleet.
 *
 * This is also the app's only read of `import.meta.env`; what the value means,
 * and what a malformed one does, is `selectFleetDataSource`'s to say.
 */
const fleetDataSource: FleetDataSource = selectFleetDataSource(import.meta.env.VITE_API_BASE_URL);

export interface AppProps {
  /**
   * The map half, when the caller has to supply its own.
   *
   * This is the seam that replaced `initialView`, and it exists for the same
   * single reason: the app opens on the map, maplibre needs WebGL, and jsdom
   * implements none of it — so a shell rendered in a test has to be able to put
   * something else where the map goes. Standing up a fake maplibre instead
   * would leave the suite asserting that a mock was called (`testing.md`
   * rule 3).
   *
   * Left out in the app, so `Dashboard`'s own `LazyMapRegion` default is the
   * one statement of what the map actually is. What that default does — the
   * on-demand chunk, its placeholder and its local failure surface — is proven
   * in `dashboard/LazyMapRegion.test.tsx` and in a browser, not here (#107).
   */
  readonly mapRegion?: MapRegionComponent;
}

export const App = ({ mapRegion }: AppProps = {}): ReactElement => {
  const { theme, toggle } = useTheme();

  return (
    <div className="app">
      <header className="app-header">
        <h1 className="app-title">Cumulo</h1>
        <p className="app-tagline">
          Residential solar fleet forecasting — per-site forecasts with uncertainty, summed across a
          fleet you can add to.
        </p>
        <ThemeToggle theme={theme} onToggle={toggle} />
      </header>

      <AppErrorBoundary>
        <main className="app-main">
          {/*
           * Spread rather than `mapRegion={mapRegion}`: `exactOptionalPropertyTypes`
           * makes an explicit `undefined` a type error on an optional prop, and
           * "the caller said nothing" has to stay a genuine absence for the
           * dashboard's own default to be the value that wins.
           */}
          <Dashboard
            theme={theme}
            dataSource={fleetDataSource}
            {...(mapRegion === undefined ? {} : { mapRegion })}
          />
        </main>
      </AppErrorBoundary>
    </div>
  );
};
