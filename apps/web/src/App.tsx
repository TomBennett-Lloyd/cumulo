import type { ReactElement } from 'react';
import { useEffect, useState } from 'react';
import { Dashboard } from './dashboard/Dashboard';
import { TokensPreview } from './preview/TokensPreview';
import type { Theme } from './theme';
import { resolveInitialTheme, THEME_STORAGE_KEY } from './theme';

/**
 * The token preview is still worth reaching — it is the rendered proof of the
 * design system — but it is no longer the app. Until `apps/web` has a router it
 * hangs off a hash, which is a stopgap and is tracked as one.
 */
const TOKENS_PREVIEW_HASH = '#tokens';

/**
 * The web app shell: it decides the theme, tells the document about it, and
 * picks the surface to render.
 *
 * Theme resolution is deliberately not spelled out here — `resolveInitialTheme`
 * owns the precedence rule so it can be tested as the pure function it is, and
 * this component supplies only the two browser readings it needs. Both are read
 * once, in the lazy `useState` initialiser: a stored preference and a system
 * preference are the app's *starting* conditions, and re-reading them on every
 * render would let the browser quietly overrule a visitor who has since used
 * the toggle.
 */
export const App = (): ReactElement => {
  const [theme, setTheme] = useState<Theme>(() =>
    resolveInitialTheme(
      window.localStorage.getItem(THEME_STORAGE_KEY),
      window.matchMedia('(prefers-color-scheme: dark)').matches,
    ),
  );

  // The `data-theme` attribute on <html> is what `tokens.css` keys its dark
  // block off, and the document is outside React's tree — synchronising it is
  // exactly the external-system case an effect is for (react.md rule 1).
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const isDark = theme === 'dark';
  const showTokensPreview = window.location.hash === TOKENS_PREVIEW_HASH;

  return (
    <div className="app">
      <header className="app-header">
        <div>
          <h1 className="app-title">Cumulo</h1>
          <p className="app-subtitle">
            Residential solar sites across Ireland and the UK, each with its own forecast.
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

      {showTokensPreview ? <TokensPreview /> : <Dashboard theme={theme} />}
    </div>
  );
};
