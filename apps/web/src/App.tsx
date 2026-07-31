import type { ReactElement } from 'react';
import { useEffect, useState } from 'react';
import { fixtureProvider } from './data/fixture-provider';
import type { FleetDataProvider } from './data/provider';
import { TokensPreview } from './preview/TokensPreview';
import { FleetAggregateView } from './views/FleetAggregateView';
import { SiteDetailView } from './views/SiteDetailView';

/**
 * The web app shell: a view switcher, the theme toggle, and the one place the
 * app decides where its data comes from.
 *
 * Three surfaces sit behind the nav — the fleet aggregate (the headline demo),
 * one site's forecast against its measurements, and the design-token preview
 * that proves `@cumulo/ui` resolves in both themes. The switcher is local state
 * rather than a router: there is no URL to share yet, and inventing one here
 * would decide routing for #17's real app shell by accident.
 *
 * Theme is deliberately not persisted and does not read `prefers-color-scheme`:
 * that belongs to the app shell in #17, and guessing at it here would create a
 * second place where theming is decided.
 */

type Theme = 'light' | 'dark';
type View = 'fleet' | 'site' | 'tokens';

interface ViewOption {
  readonly id: View;
  readonly label: string;
}

const VIEW_OPTIONS: readonly ViewOption[] = [
  { id: 'fleet', label: 'Fleet aggregate' },
  { id: 'site', label: 'Site forecast' },
  { id: 'tokens', label: 'Design tokens' },
];

/** The fleet is what the product is about; tokens are the supporting evidence. */
const DEFAULT_VIEW: View = 'fleet';

/**
 * The data source, chosen once at module scope.
 *
 * Every view takes its provider as a prop and holds no opinion about which one
 * it got, so this single binding is the whole seam: #19 ships the deterministic
 * fixtures, and C8 replaces this line with the Fleet API provider (#14) once
 * that exists. Choosing per render would give two mounted views two different
 * fleets.
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
 * chart holds an in-flight provider query, and keeping three of them alive
 * would make the nav a fan-out of requests nobody is looking at.
 */
const viewBody = (view: View, dataProvider: FleetDataProvider): ReactElement => {
  if (view === 'fleet') {
    return <FleetAggregateView provider={dataProvider} />;
  }
  if (view === 'site') {
    return <SiteDetailView provider={dataProvider} />;
  }
  return <TokensPreview />;
};

export const App = (): ReactElement => {
  const [theme, setTheme] = useState<Theme>('light');
  const [view, setView] = useState<View>(DEFAULT_VIEW);

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
            Residential solar fleet forecasting. Modelled output with its uncertainty band against
            what the panels actually generated — per site and summed across the fleet — plus the
            design tokens both views are built from.
          </p>
        </div>
        <button
          type="button"
          className="theme-toggle"
          aria-pressed={isDark}
          onClick={() => {
            setTheme(isDark ? 'light' : 'dark');
          }}
        >
          Dark theme
        </button>
      </header>

      <ViewNav view={view} onSelect={setView} />

      {viewBody(view, provider)}
    </div>
  );
};
