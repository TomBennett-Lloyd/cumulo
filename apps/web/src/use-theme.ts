import { useEffect, useState } from 'react';
import type { Theme } from './theme';
import { resolveInitialTheme, THEME_STORAGE_KEY } from './theme';

export interface ThemeControl {
  /** The theme the document is in right now. */
  readonly theme: Theme;
  /** Switches to the other theme and records it as the visitor's own choice. */
  readonly toggle: () => void;
}

/**
 * The app's theming, whole: where a page starts, how the document follows, and
 * what a visitor's click is remembered as.
 *
 * It lives beside `theme.ts` rather than in it because that module is
 * deliberately pure — a precedence rule tested with plain inputs and no browser
 * at all — and this is the wiring that rule needs to reach a document. Two
 * shells consume it: the product shell (`App.tsx`) and the token gallery
 * (`preview/TokensHarness.tsx`), which exists to show the app's own chrome
 * around a different body. That is why the mechanism is shared rather than
 * copied: the gallery demonstrating a theming mechanism the app no longer has
 * would be a gallery lying about the product (structure.md rule 7).
 *
 * Both browser readings happen once, in the lazy `useState` initialiser: a
 * stored preference and a system preference are a page's *starting* conditions,
 * and re-reading them on every render would let the browser quietly overrule a
 * visitor who has since used the toggle.
 */
export const useTheme = (): ThemeControl => {
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

  return {
    theme,
    toggle: () => {
      // Persisting belongs in the handler rather than in an effect watching
      // `theme`: the write is what the visitor's click *means*, and an effect
      // would also fire on first render, turning a system preference nobody
      // chose into a stored choice.
      const next: Theme = theme === 'dark' ? 'light' : 'dark';

      window.localStorage.setItem(THEME_STORAGE_KEY, next);
      setTheme(next);
    },
  };
};
