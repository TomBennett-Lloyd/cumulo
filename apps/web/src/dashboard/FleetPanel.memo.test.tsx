// @vitest-environment jsdom

import { cleanup, render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ForecastChartPoint, ForecastChartProps } from '../charts/ForecastChart';
import { CountingFleetSource, FULL_FLEET, panel, settle } from './fleet-panel-test-fixture';

/*
 * What the fleet panel hands its chart when nothing about the fleet has changed.
 *
 * The panel's third suite, and the only one that needs the chart replaced. The
 * subject is not what is drawn — `FleetPanel.structure.test.tsx` owns that — but
 * whether the *same* points are drawn: `FleetPanel` re-renders for reasons that
 * have nothing to do with the fleet's numbers (the range picker, three retry
 * counters, and the dashboard's once-a-second poll while a new site generates),
 * and until #293 each of those re-summed a 60-site fleet's series and re-joined
 * them from scratch. What proves the memo is that the array survives the
 * re-render, and an array's identity is invisible in the DOM.
 *
 * So the chart is stood in for rather than read, which `testing.md` rule 10
 * allows at exactly this line: the stand-in is a seam at a component boundary
 * (the `mapRegion` precedent), not a mock being asserted against. Nothing below
 * asserts that the stub was called — the assertions are about the value the
 * panel computed, with the render count only there to prove the comparison is
 * not vacuous.
 *
 * The mock is file-scoped, which is why this is a file: `vi.mock` applies to
 * every test in the module it appears in, and both sibling suites read the real
 * chart's table, marks and accessible name.
 */

/** Every `points` array the chart has been handed, in render order. */
const chartPoints = vi.hoisted((): (readonly ForecastChartPoint[])[] => []);

vi.mock('../charts/ForecastChart', () => ({
  ForecastChart: ({ points }: ForecastChartProps): ReactElement => {
    chartPoints.push(points);
    return <figure className="forecast-chart-figure" />;
  },
}));

afterEach(() => {
  cleanup();
  chartPoints.length = 0;
});

describe('FleetPanel’s aggregation', () => {
  it('hands the chart the identical points array across unrelated re-renders', async () => {
    const dataSource = new CountingFleetSource(FULL_FLEET);
    const { rerender } = render(panel(dataSource));

    await settle();
    const settledRenders = chartPoints.length;
    const settledPoints = chartPoints[settledRenders - 1];

    /*
     * A fresh element carrying the same prop values, rather than the same
     * element object: React bails out of re-rendering a child whose element is
     * referentially identical, so re-rendering *that* would prove nothing at
     * all. These props are equal and stable by construction — the fixture's
     * `sites` is a module constant and the rest are literals — so the two
     * queries keep their keys, `useFleetQuery` keeps its state objects, and the
     * memo's dependencies are untouched.
     */
    rerender(panel(dataSource));

    // The re-render really reached the chart. Without this the identity below
    // would hold just as well if the panel had never rendered again.
    expect(chartPoints.length).toBeGreaterThan(settledRenders);
    // And it really is the fleet's two joined hours, not a shared empty array:
    // an identity that only holds because both sides are `[]` proves nothing
    // about the pipeline this memo exists to skip.
    expect(settledPoints).toHaveLength(2);
    // `toBe` is `Object.is` — the same array, not an equal one.
    expect(chartPoints.at(-1)).toBe(settledPoints);
  });
});
