// @vitest-environment jsdom

import { tokens } from '@cumulo/ui';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { TokensPreview } from './TokensPreview';

afterEach(cleanup);

// Walked from `tokens` rather than from the component, and walked whole: naming
// the groups here would mean a brand-new group — the case most likely to have no
// section in the preview — passing unnoticed. A token that stops being rendered,
// or any token in any group the preview has no section for, fails below.
const tokenNames = Object.values(tokens)
  .flatMap((group) => Object.values(group))
  .map((reference) => reference.replace(/^var\(|\)$/g, ''));

describe('TokensPreview', () => {
  it('shows every token in the design system, named', () => {
    render(<TokensPreview />);

    const unshown = tokenNames.filter((name) => screen.queryAllByText(name).length === 0);

    expect(unshown).toEqual([]);
  });

  it('carries the Open-Meteo credit on the rendered surface', () => {
    render(<TokensPreview />);

    const credit = screen.getByRole('link', { name: 'Open-Meteo.com' });

    expect(credit.getAttribute('href')).toBe('https://open-meteo.com/');
  });

  it('names all three chart series in the legend, so identity is never colour alone', () => {
    render(<TokensPreview />);

    expect(screen.getByText('Forecast (P10–P90)')).toBeDefined();
    expect(screen.getByText('Forecast (median)')).toBeDefined();
    expect(screen.getByText('Actuals')).toBeDefined();
  });

  it('marks the sample chart’s horizon with the rule alone, never with words on the canvas', () => {
    /*
     * The preview's half of #429. The owner's 2026-08-11 round deleted the words
     * `forecast horizon` from both canvases; the real chart's deletion is pinned
     * in `charts/forecast-chart-axes.test.tsx` and this one was not pinned at
     * all, so the label could have come back here unnoticed.
     *
     * Scoped to the `<svg>`'s text nodes rather than to the container, and that
     * is what makes the assertion possible: the same phrase is still in the
     * chart's `aria-label`, where it describes what the plot shows to a reader
     * who cannot see it. Drawn words are what went, not the description.
     *
     * The rule is asserted alongside, for the reason the real chart's case gives
     * about the same pair: a preview that drew nothing at all would satisfy an
     * absence on its own, so the mark being present is what makes the absence
     * mean "the rule speaks without words". The phrase is written out rather
     * than imported, since a test that imports the string it forbids cannot
     * notice the string coming back.
     */
    const { container } = render(<TokensPreview />);
    const chart = container.querySelector('.chart');
    const drawnWords = [...(chart?.querySelectorAll('text') ?? [])].map(
      (label) => label.textContent,
    );

    expect(chart?.querySelectorAll('.chart-horizon')).toHaveLength(1);
    expect(drawnWords).not.toHaveLength(0);
    expect(drawnWords).not.toContain('forecast horizon');
  });

  it('gives the chart a table twin that distinguishes measured hours from forecast ones', () => {
    render(<TokensPreview />);

    const measured = within(screen.getByRole('row', { name: /12:00/ })).getAllByRole('cell');
    const forecastOnly = within(screen.getByRole('row', { name: /14:00/ })).getAllByRole('cell');

    expect(measured.at(-1)?.textContent).toBe('5.9');
    expect(forecastOnly.at(-1)?.textContent).toBe('—');
  });
});
