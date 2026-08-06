import { useEffect, useRef, useState, type KeyboardEvent, type ReactElement } from 'react';

import type { Theme } from '../theme';
import { ThemeToggle } from '../ThemeToggle';
import { AboutDialog } from './AboutDialog';

export interface HeaderMenuProps {
  /** The theme in force, passed through to the toggle this menu now houses. */
  readonly theme: Theme;
  /** What flipping the theme means — ordinarily the `toggle` from `useTheme`. */
  readonly onToggleTheme: () => void;
}

/**
 * The header's catch-all: a disclosure button over the shell's odds and ends.
 *
 * It was the bar's only control until the site search landed beside it, and the
 * product's (i) after that (`AppHeader.tsx`). What decides which side of this
 * button a thing sits on is not importance, and it is not frequency either — the
 * tip is read about once a session and is out on the bar. It is what a thing
 * costs the bar weighed against what it gives back there: the search is its own
 * affordance, and the tip is one round button over a sentence that folds away
 * again, so both answer where they stand. What is behind this button acts
 * somewhere else — the theme toggle repaints the whole page, About opens a
 * dialog over it — and neither is made worse by costing a press first.
 *
 * ## A disclosure, not a menu
 *
 * There is no `role="menu"` here, and that is a decision rather than an
 * omission. The ARIA menu pattern is an application menu bar: it takes arrow
 * keys over Tab, owns Home/End and type-ahead, and manages a roving tabindex —
 * a contract this owes in full the moment it claims the role, and one that
 * makes ordinary buttons stop behaving like buttons. What is actually behind
 * this button is two ordinary controls, so it is a button with `aria-expanded`
 * revealing them, which is the smaller and more honest of the two patterns.
 *
 * The theme toggle lives in here now rather than bare in the header. It is the
 * same shared `ThemeToggle` the token gallery renders (which keeps its own, in
 * its own header) — this component decides where it sits, not what it is.
 *
 * ## Two dismissals, kept apart
 *
 * Escape closes the popover and hands focus back to the button that opened it,
 * because a reader who dismisses a popover with the keyboard has nowhere to go
 * otherwise: the control they were on is about to unmount.
 *
 * The About dialog renders as a *sibling* of the popover, not inside it, and
 * that placement is load-bearing. React's synthetic events bubble along the
 * React tree rather than the DOM one, so a dialog rendered inside the popover
 * would deliver its Escape keydown to the popover's handler as well — and one
 * keypress would dismiss the dialog and the popover together, leaving the
 * browser restoring focus to a button that no longer exists. As siblings, the
 * dialog's Escape is the dialog's alone; a second Escape then closes the
 * popover behind it. That is also why the popover stays open behind the dialog
 * rather than closing as it opens.
 *
 * ## Outside clicks
 *
 * A press anywhere outside dismisses the popover, which is a subscription to
 * something outside React (`react.md` rule 1) and so genuinely an effect.
 * `mousedown` rather than `click`: a reader pressing on a control elsewhere on
 * the page should see the popover go before that control reacts. Focus is
 * deliberately not moved on this path — the pointer is already where the reader
 * wants to be.
 *
 * The listener stands down while the About dialog is open. The dialog is modal:
 * the page behind it is inert, so any press that reaches the document at all is
 * the dialog's own, and closing the popover under it would remove the control
 * the browser is going to restore focus to.
 */
export const HeaderMenu = ({ theme, onToggleTheme }: HeaderMenuProps): ReactElement => {
  const [menuOpen, setMenuOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!menuOpen || aboutOpen) {
      return undefined;
    }

    const closeOnOutsidePress = (event: MouseEvent): void => {
      const container = containerRef.current;
      const pressedInside =
        container !== null && event.target instanceof Node && container.contains(event.target);

      if (!pressedInside) {
        setMenuOpen(false);
      }
    };

    document.addEventListener('mousedown', closeOnOutsidePress);

    return () => {
      document.removeEventListener('mousedown', closeOnOutsidePress);
    };
  }, [menuOpen, aboutOpen]);

  const dismissMenu = (): void => {
    setMenuOpen(false);
    buttonRef.current?.focus();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape' && menuOpen) {
      dismissMenu();
    }
  };

  return (
    <>
      <div className="header-menu" ref={containerRef} onKeyDown={handleKeyDown}>
        <button
          type="button"
          className="header-menu-button"
          ref={buttonRef}
          aria-expanded={menuOpen}
          onClick={() => {
            setMenuOpen((wasOpen) => !wasOpen);
          }}
        >
          Menu
        </button>

        {menuOpen ? (
          <div className="header-menu-popover">
            <ThemeToggle theme={theme} onToggle={onToggleTheme} />
            <button
              type="button"
              className="header-menu-item"
              onClick={() => {
                setAboutOpen(true);
              }}
            >
              About Cumulo
            </button>
          </div>
        ) : null}
      </div>

      <AboutDialog
        open={aboutOpen}
        onClose={() => {
          setAboutOpen(false);
        }}
      />
    </>
  );
};
