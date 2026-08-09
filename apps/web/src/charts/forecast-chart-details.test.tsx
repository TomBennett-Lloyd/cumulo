// @vitest-environment jsdom

import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { CHART_VIEW_BOX_HEIGHT } from './chart-geometry';
import {
  attributeNumber,
  JSDOM_PLOT,
  renderChart,
  requireMark,
  requireSvg,
  SERIES,
} from './forecast-chart-test-fixture';
import { DEFAULT_CHART_WIDTH } from './use-chart-width';

/**
 * The table twin's disclosure (#284 D3), and the chart's own view box (D15).
 *
 * Its own file rather than more cases in `ForecastChart.test.tsx`, which is at
 * `structure.md` rule 4's ceiling — the same split
 * `packages/storage/src/client-retry-classification.test.ts` is, and for the
 * same reason: a suite at the ceiling is where the next assertion goes missing.
 * The chart's own suite still owns what the *table* says; this file owns only
 * what the fold does to it.
 *
 * What jsdom can answer here is the semantics — the element's `open`, the
 * summary's words, and whether the accessible table still resolves through a
 * closed disclosure — because jsdom omits the `<details>` shadow-tree styles, so
 * nothing here is actually hidden. The half that needs a rendered box (a reader
 * seeing the summary and not the rows until they press it, and the plot filling
 * its panel once the rows are out of the way) is the browser lane's, and
 * `e2e/chart-surfaces.spec.ts` is where it is asserted (`testing.md` rule 10).
 */

// Vitest runs without global test hooks, so Testing Library's automatic cleanup
// never registers itself.
afterEach(cleanup);

/**
 * The caption `forecast-chart-test-fixture.tsx` renders, written out rather than
 * imported: this case asserts that the table is still findable *by its
 * accessible name*, and a name taken from the same constant the component was
 * given would follow any rename straight past the reader.
 */
const TABLE_NAME = 'Table view — Sunnyside Farm, kW';

/**
 * The disclosure, read off the DOM. `instanceof` rather than a cast — `open`
 * exists only on a real `<details>`, and a `.forecast-chart-details` that
 * stopped being one is the defect, not something to assert around
 * (`typing.md` rule 2).
 */
const disclosure = (container: HTMLElement): HTMLDetailsElement => {
  const element = container.querySelector('.forecast-chart-details');

  if (!(element instanceof HTMLDetailsElement)) {
    throw new Error('The chart rendered no <details> around its table twin.');
  }

  return element;
};

describe('forecast chart table disclosure', () => {
  it('folds the table behind a closed Raw data disclosure', () => {
    const container = renderChart(SERIES);
    const details = disclosure(container);
    const summary = container.querySelector('.forecast-chart-summary');

    expect(details.open).toBe(false);
    expect(summary?.textContent).toBe('Raw data');

    // A DOM-and-name fact, and deliberately only that: through a *closed*
    // disclosure the twin is still in the document and still carries its caption
    // as its accessible name, so a rename of either fails here. It is not
    // evidence about the accessibility tree — a browser excludes content it does
    // not render, so a real screen reader meets the collapsed disclosure and
    // reaches the table by pressing it. This query can see through the fold at
    // all only because jsdom omits the `<details>` shadow-tree styles and hides
    // nothing; what a reader reaches by pressing is `e2e/chart-surfaces.spec.ts`'s.
    expect(screen.getByRole('table', { name: TABLE_NAME })).toBe(
      container.querySelector('.forecast-chart-table'),
    );

    if (summary === null) {
      throw new Error('The disclosure rendered no summary to press.');
    }

    fireEvent.click(summary);

    expect(details.open).toBe(true);
  });
});

/*
 * The chart's drawing space (#284 D15).
 *
 * Everything here is the *fallback* arm, and that is the point rather than a
 * limitation. jsdom ships no `ResizeObserver`, so `useChartWidth` never
 * measures and every chart in every jsdom suite in this directory is drawn at
 * `DEFAULT_CHART_WIDTH` — which is what makes the exact coordinates the rest of
 * those suites assert reproducible at all. The measured arm is unreachable from
 * this lane by construction and is the browser lane's to prove
 * (`e2e/chart-surfaces.spec.ts`, `testing.md` rules 7 and 10).
 */
describe('forecast chart drawing space', () => {
  it('draws at the fallback width, because jsdom has nothing to measure with', () => {
    /*
     * The vacuity guard, and the reason the two cases below mean anything. They
     * assert the fallback width; if this environment ever gained a
     * `ResizeObserver`, the chart would measure a jsdom box laid out at zero,
     * hold the fallback anyway (the hook ignores a zero reading), and both cases
     * would keep passing while testing a different arm. Stated as an assertion
     * rather than a comment so the day it changes is a failure, not a silent
     * change of subject.
     */
    expect(typeof ResizeObserver).toBe('undefined');
  });

  it('takes its view box from the measured width and its own height constant', () => {
    const svg = requireSvg(renderChart(SERIES));

    // Composed from the two constants rather than written out: the numbers are
    // theirs to state, and what this case is for is that the component wires
    // them into the view box the right way round — a width that came from the
    // measurement, a height that did not.
    expect(svg.getAttribute('viewBox')).toBe(
      `0 0 ${String(DEFAULT_CHART_WIDTH)} ${String(CHART_VIEW_BOX_HEIGHT)}`,
    );
    // Pinned as well, because the view box alone would let the element render at
    // whatever height its aspect ratio implied in a wider column.
    expect(svg.getAttribute('height')).toBe(String(CHART_VIEW_BOX_HEIGHT));
  });

  it('spans the pointer target across the whole plot at that width', () => {
    const target = requireMark(renderChart(SERIES), '.forecast-chart-pointer-target');

    // Readers aim at a time, not at a 2px line — so a target that stopped
    // covering the plot would leave hours with no readout at all. Asserted
    // against the plot the chart is actually drawing into, which is the same
    // rect every coordinate in the sibling suites is expressed in.
    expect(attributeNumber(target, 'x')).toBe(JSDOM_PLOT.left);
    expect(attributeNumber(target, 'y')).toBe(JSDOM_PLOT.top);
    expect(attributeNumber(target, 'x') + attributeNumber(target, 'width')).toBe(JSDOM_PLOT.right);
    expect(attributeNumber(target, 'y') + attributeNumber(target, 'height')).toBe(
      JSDOM_PLOT.bottom,
    );
  });
});
