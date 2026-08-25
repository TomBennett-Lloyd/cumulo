// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import {
  CountingFleetSource,
  FULL_FLEET,
  NO_SELECTION,
  panel,
  renderSettled,
  rowCells,
  settle,
  SITE_A_SELECTED,
} from './fleet-panel-test-fixture';

/*
 * The unit the fleet chart is drawn in, driven from the row and from the selection.
 *
 * A file of its own rather than more cases in `FleetPanel.test.tsx`, which sits at 265 of
 * `structure.md` rule 4's 300 code lines — the same wall that produced
 * `FleetPanel.overlay/structure/listing/memo.test.tsx`, and the same cut: one suite, one subject.
 * The subject here is the seam. That the toggle is *on* the row is furniture and lives in
 * `FleetPanel.structure.test.tsx`; the rules about when the unit moves are a pure state machine
 * and are tabled exhaustively in `chart-unit.test.ts`, with the prop-edge wiring in
 * `use-chart-unit.test.tsx`. What is left, and what only a mounted panel can answer, is whether
 * that machine actually reaches the three surfaces a reader sees: the value axis's title, the
 * table twin's caption, and the numbers themselves.
 *
 * **All three together, in every case that switches**, because each is satisfiable by a bug the
 * others catch. A panel that retitled the axis without rescaling the points would draw kW under a
 * percent axis — the same numbers read as a fleet running at 6% of nameplate. One that rescaled
 * the points and left the caption alone would hand the table's reader percentages labelled kW,
 * which is the one surface with no axis beside it to correct the impression.
 *
 * Asserted through the table twin for the values, as the overlay suite is and for its reason: the
 * plotted numbers are readable as text there, where the SVG carries them as coordinates nobody can
 * assert on without re-deriving the geometry. The axis title is read off the plot because that is
 * the only place it exists.
 */

afterEach(cleanup);

/** The chart's caption for the demo capabilities, without its unit clause. */
const CAPTION_STEM = 'Table view — fleet forecast and simulated actuals, 24 h range';

/**
 * The value axis's title — the first of the two the chart prints.
 *
 * Order rather than a second class name, because that is the contract
 * `charts/forecast-chart-axes.tsx` writes: `axisTitleElements` returns the value axis's title and
 * then the time axis's, and `charts/forecast-chart-axes.test.tsx` pins the pair. Reading the first
 * here rather than searching for either unit's words is what lets the agreement case below derive
 * the unit from the chart instead of asserting two literals against each other.
 */
const valueAxisTitle = (container: HTMLElement): string => {
  const [title] = container.querySelectorAll('.forecast-chart-axis-title');

  if (title === undefined) {
    throw new Error('The fleet chart drew no axis titles at all.');
  }

  return title.textContent;
};

/** The table twin's caption, which is where the table says what its columns count. */
const tableCaption = (container: HTMLElement): string => {
  const caption = container.querySelector('caption');

  if (caption === null) {
    throw new Error('The fleet chart’s table twin rendered no caption at all.');
  }

  return caption.textContent;
};

/** Every row of the table twin, in column order — the plotted numbers as text. */
const tableRows = (container: HTMLElement): readonly (readonly string[])[] => {
  const table = within(container).getByRole('table');

  return within(table).getAllByRole('row').map(rowCells);
};

/**
 * One press of the unit control, named by the unit the reader is moving *to*.
 *
 * The control is one button labelled with the unit that is showing, so the
 * destination is not in its visible text — it is in the accessible name, which
 * says both. Querying on that half rather than clicking whatever button is there
 * makes the press assert the control's state on the way through: a panel already
 * in the target unit offers no button matching, and the case fails at the press
 * rather than three assertions later.
 */
const pressUnitTo = (container: HTMLElement, target: string): void => {
  fireEvent.click(
    within(container).getByRole('button', { name: new RegExp(`Press to show ${target}$`, 'u') }),
  );
};

describe('FleetPanel’s unit toggle', () => {
  it('opens in kW, on the axis, in the caption and in the numbers', async () => {
    /*
     * The default, asserted on all three surfaces so that the cases below are comparisons of two
     * states rather than assertions about one. kW is the fleet's own unit and the one its
     * aggregate is legible in, so a panel with nothing selected has no reason to normalise
     * (`chart-unit.ts`'s `INITIAL_CHART_UNIT_STATE`).
     */
    const container = await renderSettled(new CountingFleetSource(FULL_FLEET));

    expect(valueAxisTitle(container)).toBe('Power (kW)');
    expect(tableCaption(container)).toBe(`${CAPTION_STEM}, kW`);
    expect(tableRows(container)).toEqual([
      ['Time (UTC)', 'P10', 'Median', 'P90', 'Actual'],
      ['06:00', '4.0', '6.0', '9.0', '5.0'],
      ['07:00', '6.0', '8.0', '11.0', '—'],
    ]);
  });

  it('moves the axis, the caption and the numbers together when the reader presses %', async () => {
    /*
     * The whole seam in one press. Both sites are 4 kW, so the fleet's divisor is 8 at both hours:
     * 6 kW of median is 75.0%, the 9 kW P90 is 112.5% — unclamped, because a fleet outrunning its
     * nameplate is a real reading — and the 5 kW measured hour is 62.5%.
     *
     * The numbers are the assertion that makes the other two mean something. An axis retitled over
     * unchanged points is the defect this case exists for, and it would satisfy both of the
     * string comparisons on its own.
     */
    const container = await renderSettled(new CountingFleetSource(FULL_FLEET));

    pressUnitTo(container, '% of capacity.');

    expect(valueAxisTitle(container)).toBe('% of capacity');
    expect(tableCaption(container)).toBe(`${CAPTION_STEM}, % of capacity`);
    expect(tableRows(container)).toEqual([
      ['Time (UTC)', 'P10', 'Median', 'P90', 'Actual'],
      ['06:00', '50.0', '75.0', '112.5', '62.5'],
      ['07:00', '75.0', '100.0', '137.5', '—'],
    ]);
  });

  it('never lets the axis title and the table caption disagree about the unit', async () => {
    /*
     * The agreement guard, and it is deliberately not two more literal assertions. The unit word
     * is read *off the axis* and the caption is then required to end in it, so the case cannot be
     * satisfied by two surfaces that were each updated to a different unit — which is the failure
     * a chart with no single unit descriptor is exposed to (`architecture.md` rule 9; the words
     * have one owner in `charts/chart-copy.ts` and three consumers).
     *
     * The axis spells the two units differently on purpose — `Power (kW)` names the quantity
     * around the unit where `% of capacity` already names both — so the word is unwrapped from
     * the `Power (…)` frame before the comparison. That unwrapping is the whole of what this case
     * knows about either spelling, and it is why the case keeps biting if the words change.
     *
     * Both modes in one case, because a guard that only held in the unit the panel opens in would
     * pass against a switch that updated one surface.
     */
    const container = await renderSettled(new CountingFleetSource(FULL_FLEET));

    const expectAgreement = (): void => {
      const title = valueAxisTitle(container);
      const spokenUnit = /^Power \((?<unit>.+)\)$/u.exec(title)?.groups?.unit ?? title;

      expect(spokenUnit).not.toBe('');
      expect(tableCaption(container)).toBe(`${CAPTION_STEM}, ${spokenUnit}`);
    };

    expectAgreement();

    pressUnitTo(container, '% of capacity.');
    expectAgreement();

    pressUnitTo(container, 'kW.');
    expectAgreement();
  });

  it('selecting a site switches the chart to % of capacity', async () => {
    /*
     * The heart of the ticket, and the reason the unit is a machine rather than a boolean: a
     * ~4 kW roof drawn against a ~330 kW fleet is a flat line on an absolute axis, so the panel
     * takes the liberty of switching to the unit both curves are comparable in.
     *
     * One panel rerendered rather than two mounts, so what is asserted is a *change* under a
     * reader: a fresh mount with a site already selected would reach percent by the same path and
     * could not tell a switch from a different initial state.
     */
    const dataSource = new CountingFleetSource(FULL_FLEET);
    const { container, rerender } = render(panel(dataSource, NO_SELECTION));
    await settle();

    // The premise. Without it the assertions below would agree with a panel that had opened in
    // percent and never switched at all.
    expect(valueAxisTitle(container)).toBe('Power (kW)');

    rerender(panel(dataSource, SITE_A_SELECTED));

    await waitFor(() => {
      expect(valueAxisTitle(container)).toBe('% of capacity');
    });
    expect(tableCaption(container)).toBe(`${CAPTION_STEM}, % of capacity`);
  });

  it('leaves a reader’s own kW alone for the rest of the selection, and after it', async () => {
    /*
     * Manual wins, which is the clause the courtesy switch is only tolerable because of. A reader
     * who presses the toggle during a selection has taken the decision back, and the panel must
     * stop moving under them — including at the moment the selection ends, where the revert would
     * otherwise hand back a unit they had already left.
     *
     * Asserted through the caption as well as the axis, because "the panel is in kW" is a claim
     * about what the reader sees rather than about one element: a revert that reached only the
     * chart would leave the table twin captioned in the unit the machine thinks it is in.
     */
    const dataSource = new CountingFleetSource(FULL_FLEET);
    const { container, rerender } = render(panel(dataSource, SITE_A_SELECTED));
    await settle();
    await waitFor(() => {
      expect(valueAxisTitle(container)).toBe('% of capacity');
    });

    pressUnitTo(container, 'kW.');

    expect(valueAxisTitle(container)).toBe('Power (kW)');

    rerender(panel(dataSource, NO_SELECTION));

    await waitFor(() => {
      expect(screen.queryByRole('columnheader', { name: /Ashford/u })).toBeNull();
    });
    expect(valueAxisTitle(container)).toBe('Power (kW)');
    expect(tableCaption(container)).toBe(`${CAPTION_STEM}, kW`);
  });

  it('hands kW back when a selection nobody touched the toggle during ends', async () => {
    /*
     * The other side of the same debt. The panel switched the unit without being asked, so it owes
     * the reader the unit it displaced when the selection it switched for is over — otherwise a
     * reader who pressed one marker and closed it is left in a unit they never chose, on a fleet
     * chart whose own numbers beside it are still stated in kW.
     */
    const dataSource = new CountingFleetSource(FULL_FLEET);
    const { container, rerender } = render(panel(dataSource, SITE_A_SELECTED));
    await settle();
    await waitFor(() => {
      expect(valueAxisTitle(container)).toBe('% of capacity');
    });

    rerender(panel(dataSource, NO_SELECTION));

    await waitFor(() => {
      expect(valueAxisTitle(container)).toBe('Power (kW)');
    });
    expect(tableCaption(container)).toBe(`${CAPTION_STEM}, kW`);
  });

  it('says which unit is showing and what a press would do, in both units', async () => {
    /*
     * What the control tells a reader who cannot see which unit is inked. The visible label is
     * the unit that is showing; the accessible name carries that plus the destination, because a
     * name reading only `kW` would announce a button whose effect is unstated, and one reading
     * only the destination would announce percent on a chart drawn in kW.
     *
     * Both states asserted, as the pair rather than as a single positive: a control whose name
     * never changed would satisfy either assertion alone while telling the reader nothing about
     * the press it just took.
     */
    const container = await renderSettled(new CountingFleetSource(FULL_FLEET));
    const toggle = (): HTMLElement =>
      within(container).getByRole('button', { name: /^Chart unit:/u });

    expect(toggle().textContent).toBe('kW');
    expect(toggle().getAttribute('aria-label')).toBe(
      'Chart unit: kW. Press to show % of capacity.',
    );

    pressUnitTo(container, '% of capacity.');

    expect(toggle().textContent).toBe('%');
    expect(toggle().getAttribute('aria-label')).toBe(
      'Chart unit: % of capacity. Press to show kW.',
    );
  });
});
