// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import {
  ACTUALS_ONLY_FLEET,
  CountingFleetSource,
  DISJOINT_WINDOW_FLEET,
  FAILED_FLEET,
  FORECASTLESS_FLEET,
  FULL_FLEET,
  HORIZON_ONLY_CAPABILITIES,
  panel,
  renderSettled,
  rowCells,
  settle,
  SIMULATED_ACTUALS_CAPABILITIES,
} from './fleet-panel-test-fixture';
import { EMPTY_FLEET_MESSAGE, NO_FLEET_FORECAST_MESSAGE } from './state-copy';

/*
 * The shape of the fleet chart section, as opposed to what it says.
 *
 * Split from `FleetPanel.test.tsx` when #284's restructure took that file past
 * the 300-line ceiling (`structure.md` rule 4), on the same subject line the
 * overlay suite was split on: that file owns the section's *copy* — which window
 * the chart names, what is and is not said about simulated actuals — and this
 * one owns its furniture. One slim controls row, one (i) — carrying the chart's
 * legend as well as its description since 2026-08-11 — a picker on every arm
 * that has a window to choose, and one chart present in every state the section
 * can be in.
 *
 * The furniture includes a visible heading again. #323 deleted it and moved the
 * name onto the section's `aria-label`; the owner reversed that on 2026-08-11,
 * so the name is an `<h2>` once more and the section borrows it by
 * `aria-labelledby`. Both halves are asserted together below, because either
 * alone is satisfiable by a bug — a heading with nothing pointing at it leaves
 * the landmark unnamed, and a named landmark with no heading is the state this
 * file used to pin.
 *
 * The messages below are imported from `state-copy.ts` rather than written out,
 * which is the opposite of what the copy suite does and for the same reason: a
 * case about structure should keep passing across a rewording, and a case about
 * wording must not. What is asserted here is that the sentence and the chart are
 * both on screen, not which sentence it is.
 *
 * **One state has no sentence, and since #448 that is deliberate.** The owner
 * asked for the fleet chart's wait to be shown rather than spelled — *"graph
 * loading state needs to be visual not words"* — so the loading arm renders no
 * notice at all and carries its state two other ways: a traced curve inside the
 * plot, and `aria-busy` on the body around it. Its case below therefore asserts
 * the *absence* of the pending treatment beside the presence of both
 * replacements, because "says nothing" and "forgot to say anything" are the same
 * DOM without them. The other complaint that round answered was a page jump, and
 * the jump has a case of its own: what jsdom can hold of it is that the two
 * renders put the same chart in the same place, and the pixels are
 * `e2e/chart-loading.spec.ts`'s (`testing.md` rule 10).
 */

afterEach(cleanup);

/** The controls row, as an element the queries can be scoped to. */
const fleetControls = (container: HTMLElement): HTMLElement => {
  const controls = container.querySelector('.fleet-chart-controls');

  if (!(controls instanceof HTMLElement)) {
    throw new Error('The fleet chart section rendered no controls row at all.');
  }

  return controls;
};

/**
 * The chart's figure, as an element the child-order assertion can be made about.
 *
 * Exactly one, not "at least one" — a state that grew a second chart beside the
 * first would satisfy a presence check while doubling the tallest thing on the
 * page.
 */
const chartFigure = (container: HTMLElement): HTMLElement => {
  const figures = container.querySelectorAll('.forecast-chart-figure');

  expect(figures).toHaveLength(1);

  const [figure] = figures;

  if (!(figure instanceof HTMLElement)) {
    throw new Error('The fleet panel rendered no chart figure at all.');
  }

  return figure;
};

/**
 * The body the states are rendered inside — the grid holding the notice slot and
 * the chart, and the element carrying `aria-busy` while a read is out.
 */
const panelBody = (container: HTMLElement): HTMLElement => {
  const body = container.querySelector('.fleet-panel-body');

  if (!(body instanceof HTMLElement)) {
    throw new Error('The fleet panel rendered no body at all.');
  }

  return body;
};

/** The plot itself, as the element whose view box the no-jump case compares. */
const chartSvg = (container: HTMLElement): Element => {
  const svg = container.querySelector('svg.forecast-chart');

  if (svg === null) {
    throw new Error('The fleet panel rendered no chart svg at all.');
  }

  return svg;
};

/**
 * The tip's panel, opened — the legend's address since 2026-08-11.
 *
 * Pressing rather than reading a hidden node, because there is no hidden node:
 * `InfoTip` mounts its children only while open, which is the component's own
 * decision and the reason a legend behind it is *reachable* rather than merely
 * present. So the gesture is part of the criterion.
 */
const openFleetTip = (container: HTMLElement): HTMLElement => {
  fireEvent.click(
    within(fleetControls(container)).getByRole('button', { name: 'About this chart' }),
  );

  const panel = container.querySelector('.info-tip-panel');

  if (!(panel instanceof HTMLElement)) {
    throw new Error('The fleet panel’s (i) was pressed and revealed no panel.');
  }

  return panel;
};

/**
 * The furniture every state owes the reader, whatever that state has to say.
 *
 * #284 D3 asks for three things in every state and not only for the figure: the
 * section's name, the chart, and the chart's legend. The figure alone is the
 * weakest of the three to assert, because the states that used to return *in
 * place of* the chart took the name's siblings and the key down with it — and
 * a chart the reader cannot find a key for reads as a plot of anonymous lines,
 * which is the regression this pair exists to catch.
 *
 * The name is queried by role over the whole document rather than by class,
 * because what the criterion is about is a landmark a reader can navigate to.
 * The `region` is what is queried and stays queried across both reversals of
 * where the name lives: it was the `<section>`'s own `aria-label` between #323
 * and 2026-08-11, and it is the `<h2>` the section points at by
 * `aria-labelledby` now. Either way the landmark answers to "Fleet forecast",
 * which is the criterion. Which element carries it is the subject of the
 * dedicated case below; what is asserted here is only that no *state* takes it
 * away.
 *
 * **The legend is asserted behind the (i), which is D3's clause at its new
 * address rather than a weakening of it.** The owner's 2026-08-11 round moved
 * the key off the plot and into the description popover — *"the legend can go in
 * the (i) section"* — so "in every state" is now a claim about a press, and the
 * press is what this helper performs. What makes that the same guarantee is
 * where the (i) lives: on the controls row, which is outside the state switch,
 * so no state of the panel can take it or its contents away. What would falsify
 * it is a state that rendered no tip, a tip that opened empty, or a panel that
 * lost the wiring which puts a legend in it — and each of those fails here.
 *
 * The legend's entries are counted rather than read: *which* series it names is
 * copy, and this suite owns furniture (see the file header), so a rewording must
 * not fail here. Counting is what keeps an empty `<ul>` from satisfying a bare
 * presence check.
 *
 * **Two, not the three D3 was written against — deliberately, and this is the
 * clause reinterpreted rather than eroded.** #295 makes the band's legend row
 * conditional on the data: a series of point estimates gets no P10–P90 row,
 * because a legend naming a band nothing produced is the chart claiming an
 * uncertainty it does not have. That is mutually exclusive with a fixed count of
 * three, so D3's literal number could not survive the change whatever it did.
 * What D3 actually asked for does survive untouched, and is what is asserted
 * here: the chart's key is never taken away by a *state*. The two unconditional
 * rows — median and actuals — are the fixed set, and every state below is
 * band-less: nothing is selected, so there is no overlay row either, and in each
 * of the five states asserted here no forecast row has reached the chart at all
 * — the loading arm has not settled, the failed and forecastless arms have no
 * rows to draw, the empty-fleet arm has no sites to draw them for, and the
 * actuals-only arm carries measured hours alone. That is a fact about the
 * states, not about the fixtures: two of the arms are built on `FULL_FLEET`,
 * whose rows do carry bands, and those bands do reach the chart in the settled
 * controls-row cases above. A state that returned early past the legend still
 * fails here, which is the regression the clause exists for; a series that
 * honestly has no band no longer does.
 *
 * **And the figure's children are a contract** — [#410](https://github.com/TomBennett-Lloyd/cumulo/issues/410)'s
 * ask, written against the order this round creates rather than the one it
 * inherited. Two moves on 2026-08-11 emptied the `<figure>` down to the plot and
 * the announcement about it: the table twin became the figure's next sibling
 * (#284 D3's fold, relocated) and the legend went behind the (i). What is left
 * is `[svg.forecast-chart, p.forecast-chart-readout]` in that order, and the
 * order is the point — the live region a reader meets *after* the plot it
 * describes is the arrangement `docs/design/chart-treatment.md` states, and an
 * exact list is what stops a fourth element drifting back into the figure or the
 * two swapping. It is asserted here rather than in a case of its own so that all
 * five states inherit the ratchet: a state that composed its own figure would
 * otherwise satisfy every count above.
 */
const expectPanelFurniture = (container: HTMLElement): void => {
  expect(screen.getByRole('region', { name: 'Fleet forecast' })).toBeDefined();

  const legend = within(openFleetTip(container)).getByRole('list');

  expect(legend.className).toBe('forecast-chart-legend');
  expect(within(legend).getAllByRole('listitem')).toHaveLength(2);

  const figure = chartFigure(container);

  // `getAttribute` rather than `className`, because an `<svg>`'s is an
  // `SVGAnimatedString` and would compare unequal to the string it displays as.
  // `tagName` is lower-cased for the mirror-image reason: the DOM reports it in
  // the source case, which is lower for SVG and upper for HTML, and a list that
  // spelled one of each would read as a typo rather than as a contract.
  expect(
    Array.from(
      figure.children,
      (child) => `${child.tagName.toLowerCase()}.${child.getAttribute('class') ?? ''}`,
    ),
  ).toStrictEqual(['svg.forecast-chart', 'p.forecast-chart-readout']);
  expect(figure.nextElementSibling?.getAttribute('class')).toBe('forecast-chart-details');
};

/** The pair every state owes the reader: whatever it has to say, over the furniture. */
const expectChartWith = (container: HTMLElement, message: string | RegExp): void => {
  expect(screen.getByText(message)).toBeDefined();
  expectPanelFurniture(container);
};

/**
 * The loading state's own three clauses, which stand in for the sentence the
 * other four states have (#448).
 *
 * All three together, because each is satisfiable by a bug the others catch. A
 * panel that dropped the pending treatment and put nothing in its place passes
 * the absence; one that drew the trace without marking the container busy is
 * wordless *and* invisible to a screen reader, which is the failure the
 * amendment to `react.md`'s Pending bullet was careful to rule out; and one that
 * marked itself busy without drawing anything is a chart that looks settled and
 * empty while a read is out — the state a reader would take for "no data".
 *
 * The trace is queried inside the plot rather than anywhere in the container,
 * because inside the plot is the whole of why it does not move the page.
 */
const expectLoadingChart = (container: HTMLElement): void => {
  expectPanelFurniture(container);

  expect(panelBody(container).getAttribute('aria-busy')).toBe('true');
  expect(
    container.querySelectorAll('svg.forecast-chart .forecast-chart-loading-trace'),
  ).toHaveLength(1);
  expect(container.querySelector('.panel-pending')).toBeNull();
};

describe('FleetPanel’s controls row', () => {
  it('renders the chart section with a visible heading that names it', async () => {
    /*
     * The 2026-08-11 reversal of #323's copy half, as one case, because the two
     * clauses only mean anything together. A heading nothing points at leaves
     * the landmark unnamed while looking correct on screen, and a section named
     * by a stray `aria-label` passes an accessible-name check with no heading in
     * the document at all — which is exactly the state this case replaced.
     *
     * So the `aria-labelledby` is resolved rather than trusted: the heading is
     * found first, and then the region query is required to land on the section
     * whose attribute holds *that* heading's id. A pair of independent presence
     * checks would pass against a section labelled one way and a heading saying
     * the same words by coincidence, which is a real failure mode here because
     * the chart's own accessible name also begins "Fleet forecast".
     *
     * Queried at *any* level rather than level 2, because what the owner asked
     * for is a visible name over this chart and not one particular tag.
     */
    const container = await renderSettled(new CountingFleetSource(FULL_FLEET));
    const section = screen.getByRole('region', { name: 'Fleet forecast' });
    const heading = within(section).getByRole('heading', { name: 'Fleet forecast' });

    expect(section.className).toBe('fleet-chart-section');
    expect(heading.className).toBe('fleet-chart-title');
    expect(section.getAttribute('aria-labelledby')).toBe(heading.id);
    /*
     * The line that sits beside that heading, back with it. Its *shape* rather
     * than its wording, which is `FleetPanel.test.tsx`'s (see the file header).
     *
     * jsdom always renders it, and that is the whole of what this asserts. Where
     * the line disappears is a container query in `fleet-panel.css`, and jsdom
     * applies no stylesheet and lays nothing out, so a jsdom assertion about the
     * hiding would assert nothing whatever it claimed (`testing.md` rule 10 —
     * layout is the browser lane's, and a jsdom twin of a layout case is not a
     * weaker version of it but an empty one). No spec in either lane pins that
     * threshold today; said here rather than left implied by this case's
     * presence, which rule 10's closing clause asks for.
     */
    expect(screen.getByText(/\d+ sites? · /u)).toBeDefined();
    expect(container.querySelector('.fleet-chart-stats')).not.toBeNull();
  });

  it('holds the name, the numbers, the description and the window control, in that order', async () => {
    const container = await renderSettled(new CountingFleetSource(FULL_FLEET));
    const controls = fleetControls(container);

    expect(within(controls).getByRole('button', { name: 'About this chart' })).toBeDefined();
    expect(within(controls).getByRole('button', { name: 'Aggregation range' })).toBeDefined();

    // Order, because the row reads left to right and is tabbed through in the
    // same direction: the section's name, then what it is a summary of, then the
    // annotation, then the control that acts. `querySelectorAll` returns
    // document order, which is what a reader tabbing through and a screen reader
    // reading out both follow.
    //
    // Four items, asserted as an exact list rather than four presence checks.
    // #323 emptied this row down to the last two and the owner put the first two
    // back on 2026-08-11; an exact list is what catches the row drifting in
    // either direction — a fifth item appearing, or one of the four quietly
    // going again.
    //
    // The fourth is still `.range-picker` after the same day's fold: the picker
    // kept its root class and its place on the row, and what changed is what
    // that root holds — a calendar trigger, with the three windows in a popover
    // hung off it rather than laid out on this line. So this list is untouched
    // by the fold, which is the point of the class having stayed.
    expect(Array.from(controls.children, (element) => element.className.split(' ')[0])).toEqual([
      'fleet-chart-title',
      'fleet-chart-stats',
      'info-tip',
      'range-picker',
    ]);
  });

  it('carries exactly one (i), against a source that once had two', async () => {
    /*
     * The horizon-only source is the arm that used to render a second tip
     * naming the window, because it had no picker to state it. #284 D5 deleted
     * the tip rather than moving it: this arm is pinned to the default window by
     * construction — nothing can call `setRange` without a picker — so the
     * chart's own name is where the window is stated, and one description behind
     * one (i) is all the panel has left.
     *
     * The negative queries have their positive control in the case above, which
     * finds both the tip's button and the picker's trigger by role and name; a
     * null here is therefore an absent control rather than a query that never
     * matches anything. The picker's query became a button query with the
     * 2026-08-11 fold, and that is what keeps it biting: the group it used to
     * ask for is mounted only while the picker is open, so a null would have
     * been true of every arm, picker or no picker.
     */
    const container = await renderSettled(
      new CountingFleetSource(FULL_FLEET, HORIZON_ONLY_CAPABILITIES),
    );

    expect(screen.queryByRole('button', { name: 'Aggregation range' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'About this window' })).toBeNull();
    expect(container.querySelectorAll('.info-tip-button')).toHaveLength(1);
    expect(screen.getByRole('img', { name: /Fleet forecast/u }).getAttribute('aria-label')).toBe(
      'Fleet forecast, next 24 h',
    );
  });

  it('offers the window control to a source with actuals but no look-back, and re-asks on it', async () => {
    /*
     * The combination #264 made real, and the reason D5 could delete the caption
     * instead of rewriting it. A source with simulated actuals has a window
     * worth choosing even though its forecast read reaches forward only — a
     * wider one buys more measured hours behind the horizon and asks that read
     * for more ahead of it — so the picker is offered, and both halves of that
     * are asserted: the source really is re-asked at 48 h, and the chart's own
     * name really does follow.
     */
    const dataSource = new CountingFleetSource(
      DISJOINT_WINDOW_FLEET,
      SIMULATED_ACTUALS_CAPABILITIES,
    );
    const container = await renderSettled(dataSource);

    const trigger = within(fleetControls(container)).getByRole('button', {
      name: 'Aggregation range',
    });

    expect(trigger).toBeDefined();

    // The windows are mounted only while the trigger is open since the
    // 2026-08-11 fold, so reaching one takes two presses now.
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('button', { name: '48 h' }));

    await waitFor(() => {
      expect(dataSource.forecastRanges).toEqual([24, 48]);
    });
    expect(screen.getByRole('img', { name: /Fleet forecast/u }).getAttribute('aria-label')).toBe(
      'Fleet forecast and simulated actuals, past 48 h and the forecast ahead',
    );
  });

  it('names the window control for assistive technology alone, with no visible label beside it', async () => {
    /*
     * #329, and the answer to the question that raised it: the window's name is
     * for screen readers, and it is already only for them. `design.md` rule 2
     * settles the move — a label whose only job is naming for assistive
     * technology becomes an accessible name, not visible text — and #284 D5 had
     * already made it, deleting the window captions when the picker took over
     * stating the window. This case is what stops one growing back as a heading
     * over the control.
     *
     * It is aimed at the trigger since the 2026-08-11 fold, and that is more
     * than a re-target: the trigger's name lives *only* in the attribute now,
     * with an `aria-hidden` calendar under it, so this is no longer a control
     * that would merely be badly named without it — it would be announced as
     * "button". `range-picker.tsx`'s docblock states that edge and points at
     * this case as what notices.
     *
     * Neither half stands alone. The `getByRole` is the positive control: it
     * proves the name is still *on* the trigger, so the null below reads as "the
     * name is not visible" rather than "the name was deleted". Which window is
     * drawn is copy and stays in `FleetPanel.test.tsx`; what is pinned here is
     * the route — `aria-label`, and no visible node.
     */
    const container = await renderSettled(new CountingFleetSource(FULL_FLEET));

    expect(
      within(fleetControls(container)).getByRole('button', { name: 'Aggregation range' }),
    ).toBeDefined();
    expect(screen.queryByText('Aggregation range')).toBeNull();
  });

  it('closes the window popover on a choice and hands focus back to the trigger', async () => {
    /*
     * The fold's own clause, and the one the rest of the suite cannot see: with
     * the windows behind a disclosure, choosing one unmounts the button the
     * reader is standing on. Without the hand-back, focus lands on `body` and a
     * keyboard reader is returned to the top of the page — which is the
     * carve-out `design.md` rule 11 makes rather than an exception to it, since
     * the page changed in answer to their press and the trigger is where their
     * next act lives.
     *
     * Both halves in one case, because either alone is satisfiable by a bug: a
     * popover that closed while dropping focus passes the first, and a popover
     * that stayed open with the trigger focused passes the second. The chips are
     * queried rather than the popover element, because what a reader loses when
     * the close fails is the sheet standing over the chart — and the chips are
     * the thing mounted only while it is up.
     *
     * `document.activeElement` rather than a matcher, for the reason
     * `Dashboard.focus.test.tsx` gives: focus is the browser's own state and
     * jsdom keeps it honestly, so it is asked directly.
     */
    const dataSource = new CountingFleetSource(FULL_FLEET);
    const container = await renderSettled(dataSource);
    const trigger = within(fleetControls(container)).getByRole('button', {
      name: 'Aggregation range',
    });

    fireEvent.click(trigger);

    // The positive control for the two nulls below: the chips really are in the
    // document while the picker is open, so their absence afterwards is a close
    // rather than a query that never matched.
    expect(screen.getByRole('button', { name: '48 h' })).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: '48 h' }));

    expect(screen.queryByRole('button', { name: '48 h' })).toBeNull();
    expect(container.querySelector('.range-picker-popover')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    // And the choice really was made, not merely dismissed — a popover that
    // closed without calling `onSelect` would satisfy every line above.
    await waitFor(() => {
      expect(dataSource.forecastRanges).toEqual([24, 48]);
    });
  });
});

describe('FleetPanel’s chart', () => {
  it('keeps the chart on screen in every fleet state', async () => {
    /*
     * #284 D3, as one case rather than four scattered assertions. The panel used
     * to return its pending, failed and empty states *in place of* the chart, so
     * the tallest element on the page appeared and vanished under a reader
     * watching a retry land — and a failed fleet read took the axes, the legend
     * and the table twin with it, which is more than the failure had actually
     * removed. Each arm asserts the state's own sentence beside the figure,
     * because a chart that stayed while the explanation went missing would be
     * the opposite defect.
     *
     * D3's two other clauses — the section's name survives whether or not there
     * is data, and the legend is there in every state — are asserted per arm by
     * `expectPanelFurniture` rather than left implied by the figure count; its
     * docblock is where the element that name sits on is stated. Both hold by
     * construction and that is the point of pinning them: the name reaches the
     * `<section>` that wraps the state switch in `FleetPanel.tsx` from a heading
     * on its controls row, which is outside that switch — and since 2026-08-11
     * the legend reaches the reader from that same row, through the (i), rather
     * than from inside the figure. So a future state that returns early past
     * either would be exactly the regression these clauses were written
     * against, and a state that stopped rendering the row would now take both
     * at once.
     */
    const loading = render(panel(new CountingFleetSource(FULL_FLEET))).container;

    // The one arm with no sentence to assert beside the figure. Its own three
    // clauses stand in for it — see `expectLoadingChart`.
    expectLoadingChart(loading);

    await settle();
    cleanup();

    expectChartWith(
      await renderSettled(new CountingFleetSource(FAILED_FLEET)),
      /Could not load the fleet forecast/u,
    );

    cleanup();

    expectChartWith(
      await renderSettled(new CountingFleetSource(FORECASTLESS_FLEET)),
      NO_FLEET_FORECAST_MESSAGE,
    );

    cleanup();

    expectChartWith(
      await renderSettled(new CountingFleetSource(FULL_FLEET), []),
      EMPTY_FLEET_MESSAGE,
    );
  });

  it('leaves the chart in the same place and at the same scale once the read lands', async () => {
    /*
     * #448's other half, and the complaint the owner actually made: *"It also
     * causes the page to jump."* The pending sentence sat above the chart, so
     * it appeared, pushed everything below it down, and left again a moment
     * later — twice per read, on the page's tallest element.
     *
     * What jsdom can hold of "no jump" is the structural half, and it is the
     * half that would break first. Two things have to be true across the
     * settle: the plot is drawn at the same scale, which is its view box; and
     * nothing arrives above it, which is the figure still being the body's
     * first element child. A notice appearing in that slot is exactly the
     * defect, and it fails the second assertion whatever height it has.
     *
     * The pixel half — that the two boxes really do measure the same — is
     * `e2e/chart-loading.spec.ts`'s, because jsdom lays nothing out and a
     * height read here would be zero in both renders and prove nothing
     * (`testing.md` rule 10). Said rather than left implied: neither case is
     * the other's weaker copy, and neither alone is the criterion.
     *
     * One render carried across the settle rather than two, so the comparison
     * is of one panel before and after its own read. Two renders would compare
     * two mounts and could agree while a single panel still jumped between
     * them.
     */
    const container = render(panel(new CountingFleetSource(FULL_FLEET))).container;

    /*
     * The premise, and it is not decoration — a mutation run put the panel into
     * its settled state from the first commit and every line below still
     * passed, because a settled render compared with itself agrees about
     * everything. This is what makes the rest of the case a comparison of two
     * states.
     */
    expect(panelBody(container).getAttribute('aria-busy')).toBe('true');

    const loadingViewBox = chartSvg(container).getAttribute('viewBox');

    // The positive control for the comparison below: there is a view box to
    // compare, so equality afterwards is agreement rather than two nulls.
    expect(loadingViewBox).toMatch(/^0 0 \d/u);
    expect(panelBody(container).firstElementChild).toBe(chartFigure(container));

    await settle();

    // The settle really happened — without this the panel could still be in the
    // loading state and every line below would be comparing it with itself.
    expect(panelBody(container).getAttribute('aria-busy')).toBeNull();
    expect(container.querySelector('.forecast-chart-loading-trace')).toBeNull();

    expect(chartSvg(container).getAttribute('viewBox')).toBe(loadingViewBox);
    expect(panelBody(container).firstElementChild).toBe(chartFigure(container));
  });

  it('draws the actuals when the forecast half summed to nothing, rather than calling it empty', async () => {
    /*
     * #290's second finding. "No forecast" and "nothing to show" stopped being
     * the same question when the chart's x-domain became the union of the two
     * series (`fleet-series.ts`, #264): a fleet whose forecast half has not
     * produced yet still has every measured hour to draw, and the guard that
     * returned on an empty *forecast* threw those hours away and told the reader
     * there was nothing at all. The fix is to join first and ask about what
     * would be drawn, which is what this case pins.
     */
    const container = await renderSettled(new CountingFleetSource(ACTUALS_ONLY_FLEET));

    // The fifth state D3's clauses cover, and the one arm above cannot reach:
    // it is the only state whose sentence is an *absence*, so the furniture is
    // asserted here directly rather than through `expectChartWith`.
    expectPanelFurniture(container);
    expect(screen.queryByText(NO_FLEET_FORECAST_MESSAGE)).toBeNull();
    // Genuinely drawn, not merely tabulated: the two measured hours are one
    // contiguous run, so they are one path on the plot.
    expect(container.querySelectorAll('.forecast-chart > .forecast-chart-actuals')).toHaveLength(1);

    const table = screen.getByRole('table', { name: /Table view/u });

    // The Median cell is the em dash a gap reads as, beside an Actual that has a
    // number — which is what says the measured hours reached the chart on their
    // own rather than by borrowing an x-domain from a forecast that never
    // arrived. It used to be three em dashes; #295 drops the P10 and P90 columns
    // where no hour carries a band, and Median is not gated, so the same claim is
    // made by one cell instead of three.
    expect(within(table).getAllByRole('row').map(rowCells)).toEqual([
      ['Time (UTC)', 'Median', 'Actual'],
      ['10:00', '—', '5.0'],
      ['11:00', '—', '6.0'],
    ]);
  });
});
