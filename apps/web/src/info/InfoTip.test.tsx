// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { InfoTip } from './InfoTip';

afterEach(cleanup);

const LABEL = 'About this chart';
const SENTENCE = 'Every site’s forecast, summed hour by hour.';

const renderTip = (): HTMLElement => {
  const { container } = render(<InfoTip label={LABEL}>{SENTENCE}</InfoTip>);

  return container;
};

/** The control, reached the way a reader reaches it: by its name, not its glyph. */
const tipButton = (): HTMLElement => screen.getByRole('button', { name: LABEL });

describe('InfoTip', () => {
  it('shows a named button and nothing else until it is asked', () => {
    const container = renderTip();

    expect(tipButton().getAttribute('aria-expanded')).toBe('false');
    // Not merely hidden: a description nobody asked for is not in the document,
    // so there is no stray sentence for a reader to run into out of context and
    // none for a `textContent` assertion on a surrounding panel to trip over.
    expect(screen.queryByText(SENTENCE)).toBeNull();
    expect(container.querySelector('.info-tip-panel')).toBeNull();
  });

  it('reveals its sentence on press, and says so on the button', () => {
    renderTip();

    fireEvent.click(tipButton());

    expect(screen.getByText(SENTENCE)).toBeDefined();
    // The state change is on the control the reader just pressed, which is how a
    // disclosure announces itself — this panel deliberately mounts no live
    // region of its own (`react.md`'s one-per-panel budget; the component's
    // docblock has the argument).
    expect(tipButton().getAttribute('aria-expanded')).toBe('true');
  });

  it('closes again when the same button is pressed twice', () => {
    renderTip();

    fireEvent.click(tipButton());
    fireEvent.click(tipButton());

    expect(screen.queryByText(SENTENCE)).toBeNull();
    expect(tipButton().getAttribute('aria-expanded')).toBe('false');
  });

  it('closes on Escape with focus left on the button', () => {
    renderTip();

    const button = tipButton();
    button.focus();
    fireEvent.click(button);

    fireEvent.keyDown(button, { key: 'Escape' });

    expect(screen.queryByText(SENTENCE)).toBeNull();
    // A dismissal that dropped focus would leave a keyboard reader on `body`,
    // which is the failure the panel unmounting could otherwise cause.
    expect(document.activeElement).toBe(button);
  });

  it('closes when a press lands outside it', () => {
    renderTip();

    fireEvent.click(tipButton());

    // `mousedown` rather than `click`, because that is the event the component
    // listens for: a reader pressing some other control should see the panel go
    // before that control reacts.
    fireEvent.mouseDown(document.body);

    expect(screen.queryByText(SENTENCE)).toBeNull();
    expect(tipButton().getAttribute('aria-expanded')).toBe('false');
  });

  it('stays open when the press lands inside it', () => {
    const container = renderTip();

    fireEvent.click(tipButton());

    const panel = container.querySelector('.info-tip-panel');

    if (panel === null) {
      throw new Error('The tip was opened but rendered no panel to press inside.');
    }

    fireEvent.mouseDown(panel);

    // The other half of the case above, and the reason that one is about
    // *outside*: a listener that closed on any press at all would pass there and
    // would make selecting the sentence with a mouse impossible.
    expect(screen.getByText(SENTENCE)).toBeDefined();
  });
});
