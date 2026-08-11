// @vitest-environment jsdom

import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { CHART_VIEW_BOX_HEIGHT } from './chart-geometry';
import {
  anchorCount,
  attributeNumber,
  banded,
  bare,
  JSDOM_PLOT,
  marks,
  pathCoordinates,
  renderChart,
  requireMark,
  requireSvg,
  SERIES,
  tableCells,
} from './forecast-chart-test-fixture';
import { DEFAULT_CHART_WIDTH } from './use-chart-width';

/**
 * The table twin's disclosure (#284 D3), the chart's own view box (D15), and
 * what the curved marks (D8) do at a gap.
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
 * limitation. Two guards put it there and not one (`use-chart-width.ts`, which
 * states the pair): `useChartWidth` does attempt a measurement on every mount,
 * but jsdom lays every box out at zero and a zero is not a measurement, so the
 * seed survives the initial read; and jsdom ships no `ResizeObserver`, so no
 * later resize adopts anything either. Every chart in every jsdom suite in this
 * directory is therefore drawn at `DEFAULT_CHART_WIDTH` — which is what makes
 * the exact coordinates the rest of those suites assert reproducible at all.
 *
 * The measured arm is reachable from this lane only by stubbing the rect, which
 * `use-chart-width.test.tsx` does deliberately and nothing here has any reason
 * to. What no stub can reach is whether that measurement lands *before paint*,
 * which is the browser lane's alone (`e2e/chart-first-paint.spec.ts`, with
 * `e2e/chart-surfaces.spec.ts` on where the marks land once it has;
 * `testing.md` rules 7 and 10).
 */
describe('forecast chart drawing space', () => {
  it('draws at the fallback width, because jsdom lays out nothing to measure', () => {
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

/*
 * The band's chrome, and the series that must not get any (#295).
 *
 * Live forecasts are point estimates until the envelope reaches a stored row, so
 * a chart is genuinely handed band-less series — and the legend row and the two
 * table columns are the chart *claiming* a P10–P90 it was never given. These
 * three cases are the negative half of that rule; the positive half is already
 * in `ForecastChart.test.tsx`, whose draw-order and table cases run the banded
 * `SERIES` and would fail if the chrome stopped rendering where a band exists.
 *
 * Here rather than there for the reason the whole file exists: that suite is on
 * `structure.md` rule 4's ceiling.
 */

/** The legend's rows, in draw order, as the words a reader sees. */
const legendEntries = (container: HTMLElement): readonly string[] =>
  [...container.querySelectorAll('.forecast-chart-legend li')].map((entry) =>
    entry.textContent.trim(),
  );

/** The table twin's column headings, in document order. */
const columnHeaders = (container: HTMLElement): readonly (string | null)[] =>
  [...container.querySelectorAll('.forecast-chart-table thead th')].map(
    (header) => header.textContent,
  );

/** Two point estimates and nothing else — no `band` key on either. */
const BARE_SERIES = [bare(6, 1, 0.9), bare(9, 4, 3.8)];

describe('forecast chart band chrome', () => {
  it('omits the band legend row when no point carries a band', () => {
    const entries = legendEntries(renderChart(BARE_SERIES));

    // Exactly the two series that are on the plot. The band row would name a
    // third the reader can neither see nor find a number for.
    expect(entries).toStrictEqual(['Forecast (median)', 'Actuals (simulated)']);
  });

  it('omits the P10 and P90 columns when no point carries a band', () => {
    const container = renderChart(BARE_SERIES);

    expect(columnHeaders(container)).toStrictEqual(['Time (UTC)', 'Median', 'Actual']);
    // The cells go with the headings: two columns of em dashes down every row
    // is the same false claim, made in the table's own voice.
    expect(tableCells(container, 0)).toStrictEqual(['1.0', '0.9']);
  });

  it('keeps the columns for a mixed series, where the em dash means one missing hour', () => {
    // One hour with a band, one without. Here the em dash is doing its ordinary
    // job — "no value at this hour", against a neighbour that has one — so
    // dropping the columns would throw away a value the series really carries.
    const container = renderChart([banded(6, 1, 0.9), bare(9, 4, 3.8)]);

    expect(columnHeaders(container)).toStrictEqual([
      'Time (UTC)',
      'P10',
      'Median',
      'P90',
      'Actual',
    ]);
    expect(tableCells(container, 0)).toStrictEqual(['0.0', '1.0', '2.0', '0.9']);
    expect(tableCells(container, 1)).toStrictEqual(['—', '4.0', '—', '3.8']);
    // And the legend keeps its row, because a band really is drawn.
    expect(legendEntries(container)[0]).toBe('Forecast (P10–P90, simulated)');
  });
});

/*
 * What smoothing the marks did and did not change (#284 D8).
 *
 * Here for the same reason the cases above are: `ForecastChart.test.tsx` sits on
 * `structure.md` rule 4's ceiling. That suite owns what a gap does to the run
 * machinery — a lone hour becomes a marker, a partial run keeps its own path;
 * these two own the properties interpolation could have quietly taken away.
 */
describe('forecast chart curved marks', () => {
  it('never bridges a gap with a curve', () => {
    // Two measured hours, a hole, two more. Both sides carry enough samples to
    // be stroked, so a builder that smoothed the *series* rather than each run
    // would answer with one path — sweeping through an hour nobody measured,
    // and doing it smoothly enough to look like data.
    const container = renderChart([
      banded(6, 1, 0.9),
      banded(9, 4, 3.8),
      banded(12, 6, null),
      banded(15, 5, 4.9),
      banded(18, 2, 2.1),
    ]);
    const actuals = marks(container, '.forecast-chart-actuals');

    expect(actuals).toHaveLength(2);
    // Two hours each, and neither reaching over the hole between them.
    expect(actuals.map(anchorCount)).toStrictEqual([2, 2]);
  });

  it('never dips a smoothed line below the zero it ramps up from', () => {
    // A flat dawn and then a ramp is the case that separates monotone
    // interpolation from the alternatives: a Catmull-Rom or natural cubic
    // through these same five hours pulls the curve under the axis on the way
    // up, drawing generation the fleet could not have made
    // (chart-treatment.md, "Median forecast and actuals"). Measured against
    // 3.2.0 of `d3-shape`, both overshoot here and monotone does not.
    const container = renderChart([
      bare(4, 0, null),
      bare(5, 0, null),
      bare(6, 4, null),
      bare(7, 9, null),
      bare(8, 12, null),
    ]);
    const ys = pathCoordinates(requireMark(container, '.forecast-chart-median')).map(
      (vertex) => vertex.y,
    );

    // Control points included, which is what makes this a claim about the whole
    // curve rather than about the samples: a cubic segment stays inside the hull
    // of its four coordinates, so all of them on or above the zero line puts
    // every pixel of ink there too. y grows downwards, hence the direction.
    expect(ys).not.toStrictEqual([]);
    for (const y of ys) {
      expect(y).toBeLessThanOrEqual(JSDOM_PLOT.bottom);
    }
  });
});
