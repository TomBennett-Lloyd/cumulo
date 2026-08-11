// @vitest-environment jsdom

import { cleanup, render } from '@testing-library/react';
import { useRef, type ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CHART_WIDTH, useChartWidth } from './use-chart-width';

/**
 * The hook's two answers before any `ResizeObserver` has spoken — which under
 * jsdom is every moment there is, since jsdom ships none.
 *
 * That absence is what makes this file possible and what bounds it. The
 * observed arm has no coverage in this lane at all and never could
 * (`use-chart-width.ts` says so where the fallback is taken, and
 * `e2e/chart-surfaces.spec.ts` owns it); what is provable here is the initial
 * measurement, because it happens during the commit rather than on a later
 * frame, and jsdom does run commits. Whether that measurement lands before the
 * *paint* is a browser fact and belongs to `e2e/chart-first-paint.spec.ts`
 * (`testing.md` rule 10) — this file proves only that the measurement is taken
 * and adopted, which is the half a stubbed rect can see.
 */

/**
 * A plausible column at a phone width, and deliberately not `DEFAULT_CHART_WIDTH`.
 *
 * The same order as the column `e2e/chart-first-paint.spec.ts` puts the chart in
 * at a 390px viewport, so the number a reader meets in both lanes is recognisably
 * the same situation. Nothing here depends on the exact value beyond its being a
 * width the hook could not have produced on its own.
 */
const MEASURED_WIDTH = 344;

/** A layout box of a given width — everything else zero, which is all the hook reads. */
const rectOfWidth = (width: number): DOMRect => ({
  x: 0,
  y: 0,
  left: 0,
  top: 0,
  right: width,
  bottom: 0,
  width,
  height: 0,
  toJSON: () => ({}),
});

/**
 * The hook, attached to an element and rendering what it says.
 *
 * A probe rather than `ForecastChart`, because the chart is not the subject: the
 * hook's contract is "measure the element this ref is on", and a component whose
 * whole body is that ref and that number is the smallest thing that can hold it
 * (`testing.md` rule 1 — the exported API, through the only surface a hook has).
 * It also keeps the two apart in a way the chart cannot: the fixture's
 * `stubRenderedSize` stubs the *svg*, while the hook measures the *figure*
 * (`ForecastChart.tsx`), so a test rendering the chart would be reading a rect
 * some other helper owns.
 */
const WidthProbe = (): ReactElement => {
  const ref = useRef<HTMLDivElement>(null);
  const width = useChartWidth(ref);

  return <div ref={ref}>{width}</div>;
};

/** What the probe currently says, as a number. */
const probedWidth = (): number => {
  const { container } = render(<WidthProbe />);
  const probe = container.firstElementChild;

  if (probe === null) {
    throw new Error('The width probe rendered no element to read a width off.');
  }

  return Number(probe.textContent);
};

afterEach(cleanup);
afterEach(() => {
  vi.restoreAllMocks();
});

describe('useChartWidth', () => {
  /*
   * The regression, in the lane that can hold it. jsdom has no
   * `ResizeObserver`, so nothing else in this environment ever measures
   * anything — the width the probe reports is the initial measurement or it is
   * the seed, with no third possibility to confuse the reading. Against a hook
   * that measures only through an observer this asserts 344 and gets 640.
   */
  it("adopts the container's measured width on the first render pass", () => {
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(
      rectOfWidth(MEASURED_WIDTH),
    );

    expect(probedWidth()).toBe(MEASURED_WIDTH);
  });

  /*
   * The guard, and the reason every other chart suite in this package can
   * assert exact view-box coordinates: unstubbed jsdom lays everything out at
   * zero, a zero is not a measurement, and the hook has to keep its seed
   * through one. Without it the whole `src/charts` suite would be drawing at
   * width 0 — which is what the mutant on that guard demonstrates.
   */
  it('keeps the default width where layout reports zero', () => {
    expect(probedWidth()).toBe(DEFAULT_CHART_WIDTH);
  });
});
