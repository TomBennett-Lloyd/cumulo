import type { ReactElement } from 'react';
import type { Theme } from './theme';

export interface ThemeToggleProps {
  /** The theme in force, which the switch reports as its checked state. */
  readonly theme: Theme;
  /** What a press means — ordinarily the `toggle` from `useTheme`. */
  readonly onToggle: () => void;
}

/**
 * The shell's theme control — a switch, not a toggle button.
 *
 * `role="switch"` on a native `<button>`, with `aria-checked` carrying whether
 * dark is on, so a screen reader reaches it as "Dark Mode, switch, on" rather
 * than as a button that happens to be pressed. That is the honest shape for
 * what this is: a setting with an on and an off, which is also why the header
 * menu seats it with the settings at the foot of its list rather than among the
 * things that open something (`header/HeaderMenu.tsx` owns that seat).
 *
 * The label names the state being switched *on* and `aria-checked` carries
 * whether it is, so the words stay put while the state moves under them — a
 * label that rewrote itself mid-press would leave a reader unsure which of the
 * two states they had just been told about.
 *
 * The track and thumb are `aria-hidden`: they draw the state `aria-checked`
 * already carries, and a reader told about it twice learns nothing the second
 * time. Their treatment is `app.css`'s, their seat the surface's — the split
 * `header.css`'s `.header-menu-popover .theme-toggle` comment describes.
 *
 * Keyboard operability is the native button's — Enter and Space both fire
 * `click` — and the ring is the design system's zero-specificity
 * `:focus-visible` rule in `packages/ui/src/styles.css`, so nothing here or in
 * the stylesheets beside it writes focus CSS of its own.
 *
 * It is a shared component for the same reason `useTheme` is a shared hook: the
 * token gallery wears the product's chrome deliberately, so a change to this
 * control is a change the gallery wants too (structure.md rule 7). The gallery
 * inheriting the switch is therefore the intended outcome rather than fallout —
 * `preview/TokensHarness.tsx` states the converse hazard outright, that a
 * gallery demonstrating a mechanism the product had since changed would be
 * demonstrating nothing.
 */
export const ThemeToggle = ({ theme, onToggle }: ThemeToggleProps): ReactElement => (
  <button
    type="button"
    role="switch"
    className="theme-toggle"
    aria-checked={theme === 'dark'}
    onClick={onToggle}
  >
    Dark Mode
    <span className="theme-toggle-track" aria-hidden="true">
      <span className="theme-toggle-thumb" />
    </span>
  </button>
);
