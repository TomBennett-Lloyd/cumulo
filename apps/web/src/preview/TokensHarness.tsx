import type { ReactElement } from 'react';
import { useEffect, useState } from 'react';
import type { Theme } from '../theme';
import { resolveInitialTheme, THEME_STORAGE_KEY } from '../theme';
import { TokensPreview } from './TokensPreview';

/**
 * The gallery's own shell: a header, a theme toggle, and {@link TokensPreview}.
 *
 * The whole point of the page is that a token set is two palettes, so the
 * toggle is not decoration — it is how a reviewer checks that dark was designed
 * rather than inverted. That makes theming the one piece of app chrome this
 * surface genuinely needs, and it borrows the shell's classes so the frame
 * around the gallery is the frame around the product.
 *
 * The theme wiring below reads like `App.tsx` because both are the same two
 * browser readings handed to the same pure resolver — but the *rule* is already
 * shared (`resolveInitialTheme`, `THEME_STORAGE_KEY` in `../theme`), and what
 * remains is wiring for a local-only page that ships in no bundle. If the app
 * shell grew a router, a nav, or a persisted view, none of it would belong
 * here, and this component would be no more wrong for lacking it — incidental
 * duplication, which structure.md rule 7 leaves standing.
 */
export const TokensHarness = (): ReactElement => {
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

  return (
    <div className="app">
      <header className="app-header">
        <div>
          <h1 className="app-title">Cumulo design tokens</h1>
          <p className="app-subtitle">
            The local-only gallery of the design system: every token in <code>@cumulo/ui</code>, on
            screen, in both themes. It is a development surface served from <code>tokens.html</code>
            and is not part of the shipped app.
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

      <TokensPreview />
    </div>
  );
};
