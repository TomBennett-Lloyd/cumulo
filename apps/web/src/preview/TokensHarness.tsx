import type { ReactElement } from 'react';
import { ThemeToggle } from '../ThemeToggle';
import { useTheme } from '../use-theme';
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
 * That last point is why the theming here is the app's own `useTheme` and
 * `ThemeToggle` rather than a copy of them: a gallery demonstrating a mechanism
 * the product had since changed would be demonstrating nothing. What stays
 * local is only what differs — this page's header, its prose, and its body.
 */
export const TokensHarness = (): ReactElement => {
  const { theme, toggle } = useTheme();

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
        <ThemeToggle theme={theme} onToggle={toggle} />
      </header>

      <TokensPreview />
    </div>
  );
};
