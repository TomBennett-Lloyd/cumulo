// @vitest-environment jsdom

import { tokens } from '@cumulo/ui';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { TokensPreview } from './TokensPreview';

afterEach(cleanup);

// Derived from the design system rather than from the component, so this stays
// a real check: a token that stops being rendered — or a new token that lands
// in a group the preview does not have a section for — fails here.
const tokenNames = [
  ...Object.values(tokens.color),
  ...Object.values(tokens.space),
  ...Object.values(tokens.text),
  ...Object.values(tokens.font),
  ...Object.values(tokens.radius),
].map((reference) => reference.replace(/^var\(|\)$/g, ''));

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
