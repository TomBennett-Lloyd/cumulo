import type { ReactElement } from 'react';
import { useEffect, useState } from 'react';
import { Dashboard } from './dashboard/Dashboard';
import { fixtureProvider } from './data/fixture-provider';
import type { FleetDataProvider } from './data/provider';
import { TokensPreview } from './preview/TokensPreview';
import type { Theme } from './theme';
import { resolveInitialTheme, THEME_STORAGE_KEY } from './theme';
import { FleetAggregateView } from './views/FleetAggregateView';
import { SiteDetailView } from './views/SiteDetailView';

/**
 * The web app shell: a view switcher, the theme toggle, and the one place the
 * app decides where its data comes from.
 *
 * Four surfaces sit behind the nav — the fleet map a visitor can add a site to,
 * the fleet aggregate, one site's forecast against its measurements, and the
 * design-token preview that proves `@cumulo/ui` resolves in both themes. The
 * switcher is local state rather than a router: there is no URL to share yet,
 * and a router is a decision in its own right rather than something to arrive
 * at sideways here.
 *
 * Theme resolution is deliberately not spelled out here — `resolveInitialTheme`
 * owns the precedence rule so it can be tested as the pure function it is, and
 * this component supplies only the two browser readings it needs. Both are read
 * once, in the lazy `useState` initialiser: a stored preference and a system
 * preference are the app's *starting* conditions, and re-reading them on every
 * render would let the browser quietly overrule a visitor who has since used
 * the toggle.
 */

type View = 'map' | 'fleet' | 'site' | 'tokens';

interface ViewOption {
  readonly id: View;
  readonly label: string;
}

const VIEW_OPTIONS: readonly ViewOption[] = [
  { id: 'map', label: 'Fleet map' },
  { id: 'fleet', label: 'Fleet aggregate' },
  { id: 'site', label: 'Site forecast' },
  { id: 'tokens', label: 'Design tokens' },
];

/**
 * The map opens the app: it is the surface a visitor can act on — add a site,
 * watch its first forecast arrive — and the charts explain what came out. Tokens
 * are the supporting evidence and sit last.
 */
const DEFAULT_VIEW: View = 'map';

/**
 * The data source for the chart views, chosen once at module scope.
 *
 * Every view takes its provider as a prop and holds no opinion about which one
 * it got, so this single binding is the whole seam: #19 ships the deterministic
 * fixtures, and the Fleet API provider (#14) replaces this line once that
 * exists. Choosing per render would give two mounted views two different fleets.
 *
 * The map dashboard reaches the fleet through its own `FleetDataSource` instead,
 * because it also *writes* — creating a site, then polling for the forecast that
 * follows. That `apps/web` now has two read surfaces is a real duplication and a
 * deliberate, temporary one: unifying them is #105, and it wants settling before
 * either surface grows an HTTP implementation.
 */
const provider: FleetDataProvider = fixtureProvider;

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
const viewBody = (view: View, dataProvider: FleetDataProvider, theme: Theme): ReactElement => {
  if (view === 'map') {
    return <Dashboard theme={theme} />;
  }
  if (view === 'fleet') {
    return <FleetAggregateView provider={dataProvider} />;
  }
  if (view === 'site') {
    return <SiteDetailView provider={dataProvider} />;
  }
  return <TokensPreview />;
};

export interface AppProps {
  /**
   * The view to open on; defaults to {@link DEFAULT_VIEW}.
   *
   * This is the seam a router fills once `apps/web` has one — a URL decides the
   * view, and until then the default does. It is also the only way the shell can
   * be tested: the map view mounts maplibre, which needs WebGL, which jsdom does
   * not implement, so the tests below open on views they can actually render.
   * That leaves the shipping default asserted by nothing in this suite — a real
   * gap, logged in `docs/tech-debt.md`, and one only a browser harness closes.
   */
  readonly initialView?: View;
}

export const App = ({ initialView = DEFAULT_VIEW }: AppProps = {}): ReactElement => {
  const [theme, setTheme] = useState<Theme>(() =>
    resolveInitialTheme(
      window.localStorage.getItem(THEME_STORAGE_KEY),
      window.matchMedia('(prefers-color-scheme: dark)').matches,
    ),
  );
  const [view, setView] = useState<View>(initialView);

  // The `data-theme` attribute on <html> is what `tokens.css` keys its dark
  // block off, and the document is outside React's tree — synchronising it is
  // exactly the external-system case an effect is for (react.md rule 1).
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const isDark = theme === 'dark';

  return (
    <div className="app">
      <header className="app-header">
        <div>
          <h1 className="app-title">Cumulo</h1>
          <p className="app-subtitle">
            Residential solar fleet forecasting. Sites on a map you can add to, modelled output with
            its uncertainty band against what the panels actually generated — per site and summed
            across the fleet — plus the design tokens every view is built from.
          </p>
        </div>
        <button
          type="button"
          className="theme-toggle"
          aria-pressed={isDark}
          onClick={() => {
            // Persisting belongs in the handler rather than in an effect
            // watching `theme`: the write is what the visitor's click *means*,
            // and an effect would also fire on first render, turning a system
            // preference nobody chose into a stored choice.
            const next: Theme = isDark ? 'light' : 'dark';

            window.localStorage.setItem(THEME_STORAGE_KEY, next);
            setTheme(next);
          }}
        >
          Dark theme
        </button>
      </header>

      <ViewNav view={view} onSelect={setView} />

      {viewBody(view, provider, theme)}
    </div>
  );
};
