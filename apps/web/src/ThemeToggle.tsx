import type { ReactElement } from 'react';
import type { Theme } from './theme';

export interface ThemeToggleProps {
  /** The theme in force, which the button reports as its pressed state. */
  readonly theme: Theme;
  /** What a press means — ordinarily the `toggle` from `useTheme`. */
  readonly onToggle: () => void;
}

/**
 * The shell's theme switch — a toggle button, not a checkbox.
 *
 * The label names the state being switched *on* and `aria-pressed` carries
 * whether it is, so a screen reader announces "Dark theme, pressed" rather than
 * leaving the label to change under the visitor mid-interaction.
 *
 * It is a shared component for the same reason `useTheme` is a shared hook: the
 * token gallery wears the product's chrome deliberately, so a change to this
 * button is a change the gallery wants too (structure.md rule 7).
 */
export const ThemeToggle = ({ theme, onToggle }: ThemeToggleProps): ReactElement => (
  <button type="button" className="theme-toggle" aria-pressed={theme === 'dark'} onClick={onToggle}>
    Dark theme
  </button>
);
