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

  it('gives the chart a table twin that distinguishes measured hours from forecast ones', () => {
    render(<TokensPreview />);

    const measured = within(screen.getByRole('row', { name: /12:00/ })).getAllByRole('cell');
    const forecastOnly = within(screen.getByRole('row', { name: /14:00/ })).getAllByRole('cell');

    expect(measured.at(-1)?.textContent).toBe('5.9');
    expect(forecastOnly.at(-1)?.textContent).toBe('—');
  });
});
