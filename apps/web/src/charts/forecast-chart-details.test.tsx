// @vitest-environment jsdom

import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { renderChart, SERIES } from './forecast-chart-test-fixture';

/**
 * The table twin's disclosure (#284 D3).
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
