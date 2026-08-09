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
 * It was the bar's only control until the site search landed beside it
 * (`AppHeader.tsx`), and those two are what the bar carries — the search wearing
 * one of two forms, the field or the icon that stands in for it below
 * `header.css`'s breakpoint, rather than being a third thing on the row.
 *
 * What decides which side of this button a thing sits on is not importance, and
 * it is not frequency either. It is what a thing costs the bar weighed against
 * what it gives back out there — the bar is height the map does not get, so a
 * permanent control has to earn its width by being an affordance a reader *acts
 * through*. The search earns it: one field, and finding a site by name has
 * nowhere else to live. What is behind this button acts somewhere else — the
 * theme toggle repaints the whole page, About opens a dialog over it — and
 * neither is made worse by costing a press first.
 *
 * The rule has settled a removal as well as those placements. The product's (i)
 * sat out on the bar until #284 D13 took it off: it was a permanent control
 * paying for a *description* — one that repeated the About dialog's own opening
 * sentence — rather than for an action, which is the side of the weighing that
 * loses. `app.css`'s `.app-header` rule and `App.test.tsx`'s "leaves the header
 * bar with the search and one disclosure" both point here for that reasoning;
 * the assertion that notices if something bare comes back is the test's.
 *
 * ## The button is a burger, and its name is still a word
 *
 * The word `Menu` became three lines in #284 D16, which is the same weighing
 * applied to the disclosure itself rather than to what sits beside it: the bar
 * is width the map does not get, and a glyph readers already parse as "the rest
 * of it" gives back the width the word was spending without giving back what
 * the word was *for*. So the name is unchanged — `aria-label="Menu"`, exactly
 * the string that used to be the button's text — and the `<svg>` under it is
 * `aria-hidden`, for `Brand.tsx`'s reason: a mark that says nothing its name
 * does not already say should not be in the accessibility tree twice. A screen
 * reader, a voice-control user saying "click Menu", and every
 * `getByRole('button', { name: 'Menu' })` in the suite are all still reaching
 * the control they were reaching before.
 *
 * That trade has an edge worth naming. This is the app's first control whose
 * accessible name lives *only* in an attribute: the (i) tips carry an
 * `aria-label` too, but over a visible `i`, so losing the attribute leaves one
 * of those badly named rather than unnamed — losing this one leaves a button
 * announced as "button". Nothing on screen would look wrong and no gate would
 * fire, which is why `docs/tech-debt.md`'s a11y-linting entry carries this
 * button as a named member, and why `HeaderMenu.test.tsx` asserts the name and
 * the absence of a text node in the same case.
 *
 * The three strokes are drawn here rather than fetched, on `Brand.tsx`'s terms:
 * no test asserts their geometry and nothing outside this file imports them, so
 * a designed glyph replaces this `<svg>` and reaches nothing else. Their colour
 * is `header.css`'s, because the frontend gate is a stylesheet gate.
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
          aria-label="Menu"
          aria-expanded={menuOpen}
          onClick={() => {
            setMenuOpen((wasOpen) => !wasOpen);
          }}
        >
          <svg className="header-menu-icon" viewBox="0 0 20 20" aria-hidden="true">
            <path d="M3 5h14M3 10h14M3 15h14" />
          </svg>
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
