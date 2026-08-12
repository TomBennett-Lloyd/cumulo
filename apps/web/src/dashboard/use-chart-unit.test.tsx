// @vitest-environment jsdom

import type { Site } from '@cumulo/shared';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import type { ChartUnit } from './chart-unit';
import { useChartUnit } from './use-chart-unit';

/**
 * The hook's job is the seam between a prop and a machine, so this file asks
 * only what the machine's own table cannot: does a *prop change* raise the
 * right event, and does a site-to-site move raise none? `chart-unit.test.ts`
 * owns the semantics; duplicating its rows here would be a slow copy of a fast
 * test (`testing.md` rule 10).
 *
 * The other thing only this lane can see is that the adjustment lands before
 * anything is painted: every assertion below reads the DOM straight after a
 * synchronous `rerender`, with no flush in between, so a hook that corrected
 * the unit in an effect would be caught showing the stale one.
 */

/** Two sites, so a move between them can be told from a fresh selection. */
const SITE_A: Site['id'] = '7f1a2c3d-0000-4000-8000-00000000000a';
const SITE_B: Site['id'] = '7f1a2c3d-0000-4000-8000-00000000000b';

const CHART_UNITS: readonly ChartUnit[] = ['kw', 'percent'];

interface UnitProbeProps {
  readonly selectedSiteId: Site['id'] | null;
}

/**
 * The hook wearing the smallest component that can show what it says.
 *
 * A probe rather than `FleetPanel`, because the panel is not the subject and
 * would drag a fleet query, a chart and a toggle's markup into a test about two
 * state slots. The buttons are labelled with the unit values themselves so a
 * press reads as the reader's own choice of unit rather than as a fixture
 * convention.
 */
const UnitProbe = ({ selectedSiteId }: UnitProbeProps): ReactElement => {
  const { unit, onToggle } = useChartUnit(selectedSiteId);

  return (
    <>
      <p>{unit}</p>
      {CHART_UNITS.map((candidate) => (
        <button
          key={candidate}
          type="button"
          onClick={() => {
            onToggle(candidate);
          }}
        >
          {candidate}
        </button>
      ))}
    </>
  );
};

/** What the probe currently says the chart is drawn in. */
const shownUnit = (container: HTMLElement): string => {
  const readout = container.querySelector('p');

  if (readout === null) {
    throw new Error('The unit probe rendered no readout to read a unit off.');
  }

  return readout.textContent;
};

/** The reader pressing the toggle. */
const pressToggle = (unit: ChartUnit): void => {
  fireEvent.click(screen.getByRole('button', { name: unit }));
};

afterEach(cleanup);

describe('useChartUnit', () => {
  it('starts the unselected panel in absolute kW', () => {
    const { container } = render(<UnitProbe selectedSiteId={null} />);

    expect(shownUnit(container)).toBe('kw');
  });

  it('normalises to percent when a site becomes selected', () => {
    const { container, rerender } = render(<UnitProbe selectedSiteId={null} />);

    rerender(<UnitProbe selectedSiteId={SITE_A} />);

    expect(shownUnit(container)).toBe('percent');
  });

  it('normalises to percent for a selection that is already there on first render', () => {
    // The `?site=` deep link: nobody pressed anything, and the overlay is on
    // the chart from the first frame, so it needs the same comparable axis.
    const { container } = render(<UnitProbe selectedSiteId={SITE_A} />);

    expect(shownUnit(container)).toBe('percent');
  });

  it('hands the axis back on deselect when the reader never touched the toggle', () => {
    const { container, rerender } = render(<UnitProbe selectedSiteId={null} />);

    rerender(<UnitProbe selectedSiteId={SITE_A} />);
    rerender(<UnitProbe selectedSiteId={null} />);

    expect(shownUnit(container)).toBe('kw');
  });

  it('leaves the axis where the reader put it when they toggled during the selection', () => {
    const { container, rerender } = render(<UnitProbe selectedSiteId={null} />);

    rerender(<UnitProbe selectedSiteId={SITE_A} />);
    pressToggle('kw');
    pressToggle('percent');
    rerender(<UnitProbe selectedSiteId={null} />);

    // Back on the unit the auto-switch had chosen — but by the reader's hand,
    // which is what the revert must not undo.
    expect(shownUnit(container)).toBe('percent');
  });

  it('does not re-normalise when the reader moves from one site to another', () => {
    const { container, rerender } = render(<UnitProbe selectedSiteId={null} />);

    rerender(<UnitProbe selectedSiteId={SITE_A} />);
    pressToggle('kw');
    rerender(<UnitProbe selectedSiteId={SITE_B} />);

    // A hook watching the id rather than the edges would treat this as a fresh
    // selection and put the reader back on percent.
    expect(shownUnit(container)).toBe('kw');
  });

  it('keeps a manual choice through a move and past the deselect that ends it', () => {
    const { container, rerender } = render(<UnitProbe selectedSiteId={null} />);

    rerender(<UnitProbe selectedSiteId={SITE_A} />);
    pressToggle('kw');
    rerender(<UnitProbe selectedSiteId={SITE_B} />);
    rerender(<UnitProbe selectedSiteId={null} />);

    expect(shownUnit(container)).toBe('kw');
  });

  it('leaves a reader already on percent exactly where they were', () => {
    const { container, rerender } = render(<UnitProbe selectedSiteId={null} />);

    pressToggle('percent');
    rerender(<UnitProbe selectedSiteId={SITE_A} />);
    expect(shownUnit(container)).toBe('percent');

    rerender(<UnitProbe selectedSiteId={null} />);
    expect(shownUnit(container)).toBe('percent');
  });

  it('is unmoved by a re-render that changes nothing about the selection', () => {
    const { container, rerender } = render(<UnitProbe selectedSiteId={null} />);

    pressToggle('percent');
    rerender(<UnitProbe selectedSiteId={null} />);

    // No episode was open, so the deselect edge is never crossed and there is
    // nothing to revert to — a hook dispatching on every render would find one.
    expect(shownUnit(container)).toBe('percent');
  });
});
