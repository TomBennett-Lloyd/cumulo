// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Brand } from './Brand';

/*
 * The lockup has two obligations and no behaviour, so there are two cases.
 *
 * The mark's *shape* is deliberately not asserted anywhere: it is a placeholder
 * whose whole point is that swapping it costs one component's internals
 * (`Brand.tsx`), and a test pinning its paths would be the one thing making
 * that swap expensive. What is asserted is what a swap must preserve — the
 * heading the page is named by, and the mark staying out of the accessibility
 * tree.
 */

afterEach(cleanup);

describe('Brand', () => {
  it('names the product as the page heading, in the class the shell styles', () => {
    render(<Brand />);

    const heading = screen.getByRole('heading', { name: 'Cumulo', level: 1 });

    // `.app-title` is also the token gallery's heading treatment
    // (`preview/TokensHarness.tsx`), so dropping it here would restyle a page
    // this component never appears on.
    expect(heading.classList.contains('app-title')).toBe(true);
  });

  it('keeps the mark out of the accessibility tree, so the product is named once', () => {
    const { container } = render(<Brand />);

    const mark = container.querySelector('.brand-mark');

    expect(mark?.getAttribute('aria-hidden')).toBe('true');
    // A reader hears the wordmark and nothing else: an exposed mark would be
    // the same product name a second time, in a voice nobody wrote.
    expect(screen.queryByRole('img')).toBe(null);
  });
});
