// @vitest-environment jsdom

import { cleanup, fireEvent } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  bare,
  renderChart,
  renderPercentChart,
  requireSvg,
  SERIES,
  tooltipValues,
} from './forecast-chart-test-fixture';

/**
 * The chart's live region — what a screen reader hears when a reader moves the
 * selection. The visual side of the same interaction is
 * `forecast-chart-hover.test.tsx`; these are separate files because they prove
 * separate behaviours over the one shared fixture (`structure.md` rule 4).
 *
 * Expected strings are literals rather than imports of the producer: a test
 * that imports the constant it checks asserts nothing. Note the en dashes in
 * `0.0–2.0` and `P10–P90`, and the em dash separating the time from the values.
 */

// Vitest runs without global test hooks, so Testing Library's automatic cleanup
// never registers itself.
afterEach(cleanup);

const readout = (container: HTMLElement): Element => {
  const region = container.querySelector('.forecast-chart-readout');
  if (region === null) {
    throw new Error('no chart readout');
  }
  return region;
};

describe('ForecastChart readout', () => {
  it('mounts the readout live region empty until a sample is selected', () => {
    const container = renderChart(SERIES);

    // Empty at mount is the whole point: a region that arrives with its text
    // already inside it has no change to report (react.md).
    expect(readout(container).getAttribute('aria-live')).toBe('polite');
    expect(readout(container).textContent).toBe('');
  });

  it('announces the focused sample and follows the keyboard selection', () => {
    const container = renderChart(SERIES);
    const svg = requireSvg(container);

    fireEvent.focus(svg);
    expect(readout(container).textContent).toBe(
      '06:00 (kW) — Actual 0.9, Median 1.0, P10–P90 0.0–2.0',
    );

    fireEvent.keyDown(svg, { key: 'ArrowRight' });
    expect(readout(container).textContent).toBe(
      '09:00 (kW) — Actual 3.8, Median 4.0, P10–P90 3.0–5.0',
    );

    fireEvent.keyDown(svg, { key: 'Escape' });
    expect(readout(container).textContent).toBe('');
  });

  it('the announcement and the visual tooltip read the same values', () => {
    const container = renderChart(SERIES);
    const svg = requireSvg(container);

    fireEvent.focus(svg);
    fireEvent.keyDown(svg, { key: 'ArrowRight' });
    const announced = readout(container).textContent;
    const values = tooltipValues(container);

    // One producer feeds both, so the reader who cannot see the tooltip hears
    // every number it is showing — not a second, drifting readout.
    expect(values).toStrictEqual(['3.8', '4.0', '3.0–5.0']);
    for (const value of values) {
      expect(announced).toContain(value);
    }
  });

  it('a point-estimate sample announces without a band row', () => {
    const container = renderChart([bare(6, 1, 0.9), bare(9, 4, 3.8)]);

    fireEvent.focus(requireSvg(container));

    // An absent row says "not modelled", spoken as well as drawn.
    expect(readout(container).textContent).toBe('06:00 (kW) — Actual 0.9, Median 1.0');
  });

  it('an unmeasured hour announces without a measured row, not as bare punctuation', () => {
    // SERIES[4] is past the horizon: forecast, no measurement. Spoken with the
    // row in it, the em dash `formatKw` renders is silent at default
    // punctuation verbosity, and the reader hears "Actual" with no number.
    const container = renderChart(SERIES);
    const svg = requireSvg(container);

    fireEvent.focus(svg);
    fireEvent.keyDown(svg, { key: 'End' });

    const announced = readout(container).textContent;

    expect(announced).toBe('18:00 (kW) — Median 2.0, P10–P90 1.0–3.0');
    expect(announced).not.toContain('— —');
    expect(announced).not.toContain('Actual');
  });

  /*
   * The unit half of tech-debt #235, which the unit toggle turned from an
   * omission into a defect (#291). The drawn tooltip needs no unit word — the
   * visible axis title carries it — but speech has no axis, so without this the
   * two modes announce `Median 4.0` identically and a screen-reader user cannot
   * tell which quantity they are hearing.
   *
   * Both modes are asserted over the same series on purpose: the numbers are
   * deliberately identical, so the unit word is the *only* thing distinguishing
   * the two sentences, which is exactly the claim. Once in the frame and never
   * per row — the rows are the drawn panel's own, and speech must not respell
   * them (`forecast-chart-hover.tsx`, one producer and two filters).
   */
  it('frames the announcement with the unit the chart is drawn in', () => {
    const kilowatts = renderChart(SERIES);
    fireEvent.focus(requireSvg(kilowatts));

    expect(readout(kilowatts).textContent).toBe(
      '06:00 (kW) — Actual 0.9, Median 1.0, P10–P90 0.0–2.0',
    );

    const percent = renderPercentChart(SERIES);
    fireEvent.focus(requireSvg(percent));

    expect(readout(percent).textContent).toBe(
      '06:00 (% of capacity) — Actual 0.9, Median 1.0, P10–P90 0.0–2.0',
    );
  });
});
