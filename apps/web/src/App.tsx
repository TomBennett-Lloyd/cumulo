import type { ReactElement } from 'react';
import { useEffect, useState } from 'react';
import { TokensPreview } from './preview/TokensPreview';

type Theme = 'light' | 'dark';

/**
 * The web app shell. Until the real dashboard lands (#17), the only surface it
 * hosts is the token preview — the rendered proof that the design system in
 * `@cumulo/ui` resolves in both themes.
 *
 * Theme is deliberately not persisted and does not read `prefers-color-scheme`:
 * that belongs to the app shell in #17, and guessing at it here would create a
 * second place where theming is decided.
 */
export const App = (): ReactElement => {
  const [theme, setTheme] = useState<Theme>('light');

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
          <h1 className="app-title">Cumulo design tokens</h1>
          <p className="app-subtitle">
            Every token in <code className="token-name">@cumulo/ui</code>, rendered. Flip the theme
            to see the dark palette — the same token names, independently chosen values.
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

      <TokensPreview />
    </div>
  );
};
