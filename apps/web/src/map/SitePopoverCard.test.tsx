// @vitest-environment jsdom

import type { Site } from '@cumulo/shared';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { RefObject } from 'react';
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';

import type { ForecastViewState } from '../dashboard/forecast-view-state';
import type { SelectionOrigin } from '../dashboard/selection-origin';
import { SitePopoverCard } from './SitePopoverCard';

// Vitest runs without global test hooks, so Testing Library's automatic cleanup
// never registers itself.
afterEach(cleanup);

/*
 * The card the map anchors to a selected site.
 *
 * Everything below mounts the card directly, with no data source and no map,
 * because the card takes no data source and needs no map: it is handed a `Site`
 * and the dashboard's `ForecastViewState`, and renders. That is the point of the
 * split — `SitePopover.tsx` is the maplibre half and is untestable in jsdom
 * (`testing.md` rule 3), and everything with a decision in it is here.
 *
 * What this file cannot show is the focus *ring* around whatever it focuses,
 * which is layout and paint and therefore the browser lane's
 * (`e2e/keyboard-focus.spec.ts`).
 */

const SITE: Site = {
  id: '2a2b2f3c-0000-4000-8000-000000000001',
  name: 'Rathmines rooftop',
  latitude: 53.3244,
  longitude: -6.2657,
  tiltDegrees: 35,
  azimuthDegrees: 180,
  capacityKw: 4.25,
};

interface CardHarness {
  readonly onClose: Mock<() => void>;
  readonly onRetryFirstForecast: Mock<() => void>;
}

/**
 * The card, mounted as the map mounts it.
 *
 * `selectionOrigin` defaults to `'reader'` because that is the state most of
 * these cases are about; the deep-link arm is a whole describe of its own below.
 */
const renderCard = (
  firstForecast: ForecastViewState,
  selectionOrigin: SelectionOrigin = 'reader',
): CardHarness => {
  const harness: CardHarness = {
    onClose: vi.fn<() => void>(),
    onRetryFirstForecast: vi.fn<() => void>(),
  };

  render(
    <SitePopoverCard
      site={SITE}
      selectionOrigin={selectionOrigin}
      firstForecast={firstForecast}
      onRetryFirstForecast={harness.onRetryFirstForecast}
      onClose={harness.onClose}
    />,
  );

  return harness;
};

/**
 * The card's `ready` arm carries the poll's own snapshot, which the card
 * deliberately draws none of: one site's forecast is a series on the fleet chart
 * below the map (`dashboard/site-overlay.ts`), so what the arm holds only has to
 * be a truthful "there is a forecast now".
 */
const READY: ForecastViewState = { status: 'ready', forecasts: [] };

describe('SitePopoverCard', () => {
  it('names the site and states its physical configuration', () => {
    renderCard(READY);

    expect(screen.getByRole('heading', { name: 'Rathmines rooftop' })).not.toBeNull();
    expect(screen.getByText('53.3244, -6.2657')).not.toBeNull();
    expect(screen.getByText('35°')).not.toBeNull();
    expect(screen.getByText('180°')).not.toBeNull();
    expect(screen.getByText('4.3 kW')).not.toBeNull();
  });

  it('closes on request', () => {
    const { onClose } = renderCard(READY);

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on Escape from anywhere inside it', () => {
    const { onClose } = renderCard(READY);

    // From the heading, which a handler bound to the close button alone would
    // never hear from. Nobody *tabs* onto it — it is `tabIndex={-1}`, which
    // `keeps the heading out of the tab order` below pins — so this stands for
    // the programmatic fallback landing; the reachable control the container
    // handler is really there for is the `Try again` on a failed first forecast.
    // Since #284 D14 a reader's focus starts outside this subtree, on the picker
    // under the map, where Escape is deliberately not this card's.
    fireEvent.keyDown(screen.getByRole('heading', { name: 'Rathmines rooftop' }), {
      key: 'Escape',
    });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('ignores keys that are not Escape', () => {
    // The negative control for the case above: without it, a handler that closed
    // on every keystroke would pass it. Arrow keys in particular reach this card
    // through the map, which pans on them.
    const { onClose } = renderCard(READY);

    fireEvent.keyDown(screen.getByRole('heading', { name: 'Rathmines rooftop' }), {
      key: 'ArrowDown',
    });

    expect(onClose).not.toHaveBeenCalled();
  });

  it('draws no chart of its own, because the fleet chart carries the site’s line', () => {
    const { container } = render(
      <SitePopoverCard
        site={SITE}
        selectionOrigin="reader"
        firstForecast={READY}
        onRetryFirstForecast={vi.fn<() => void>()}
        onClose={vi.fn<() => void>()}
      />,
    );

    // A card at marker size is no place for a chart, and there is a chart under
    // the map already showing exactly these hours. The site's facts are what a
    // reader gets here.
    expect(container.querySelector('svg')).toBeNull();
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

/** The wait the dashboard's poll owns, and the three ways it can end. */
describe('SitePopoverCard first forecast', () => {
  it('shows a plain loading label, not the first-forecast count, while checking', () => {
    renderCard({ status: 'checking' });

    const waiting = screen.getByText('Loading the forecast for Rathmines rooftop…');

    expect(waiting.getAttribute('aria-busy')).toBe('true');
    expect(screen.queryByText(/Generating first forecast/u)).toBeNull();
  });

  it('counts the wait out loud once the fleet has confirmed there is nothing yet', () => {
    renderCard({ status: 'generating', elapsedSeconds: 18 });

    const waiting = screen.getByText('Generating first forecast… 18s');

    expect(waiting.getAttribute('aria-busy')).toBe('true');
  });

  it('says a timeout in the app’s words, not the poll’s diagnostic ones', () => {
    renderCard({
      status: 'failed',
      reason: 'timeout',
      message: `No forecast for site ${SITE.id} after 90 seconds`,
    });

    expect(screen.getByRole('alert').textContent).toContain(
      'No forecast arrived within 90 seconds',
    );
    expect(screen.queryByText(new RegExp(SITE.id))).toBeNull();
  });

  /*
   * The distinction the reason exists for: this run never heard back, so the
   * sentence beside it — "the pipeline may still be working" — would be an
   * assertion about a pipeline nobody asked successfully. The negative on
   * `pipeline` is what pins that; its positive control is the timeout test
   * directly above, whose copy contains the word.
   */
  it('an unanswered deadline claims nothing about the pipeline, and still offers a retry', () => {
    renderCard({
      status: 'failed',
      reason: 'unanswered',
      message: `No answer for site ${SITE.id} within 90 seconds`,
    });

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('No answer from the fleet within 90 seconds');
    expect(alert.textContent).not.toContain('pipeline');
    expect(screen.getByRole('button', { name: 'Try again' })).not.toBeNull();
  });

  it('repeats the source’s own account when the fleet answered with a fault', () => {
    renderCard({ status: 'failed', reason: 'error', message: 'Forecast service unreachable' });

    expect(screen.getByRole('alert').textContent).toContain('Forecast service unreachable');
  });

  it('offers a retry that restarts the wait', () => {
    const { onRetryFirstForecast } = renderCard({
      status: 'failed',
      reason: 'timeout',
      message: 'timed out',
    });

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    expect(onRetryFirstForecast).toHaveBeenCalledTimes(1);
  });

  it('a halted watch explains itself and offers no Try again', () => {
    const message = 'refused by the API — set CUMULO_WEB_ORIGINS; retrying cannot help.';
    renderCard({ status: 'halted', message });

    expect(screen.getByRole('alert').textContent).toContain(message);
    // The paired positive control for this negative: `offers a retry that
    // restarts the wait`, directly above, finds the button with the same query
    // on the `failed` arm — so a null here is an absent button, not a query
    // that never matches anything.
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });
});

/*
 * The focus rule, settling #260 and revised by #284 D14. The composition-level
 * cases are `Dashboard.focus.test.tsx`'s — these are the component's own
 * contract, which is what makes the card renderable in isolation and the rule
 * readable in one file (`react.md` rule 4).
 *
 * The two arms of the reader-initiated half are both here because the card is
 * the only place they are both visible: handed a landing it uses it, handed
 * none it falls back to its own heading. In the app the landing is the fleet
 * panel's range picker, and the fallback is what a source rendering no picker
 * at all leaves.
 */
describe('SitePopoverCard focus', () => {
  /**
   * A landing of the kind the app supplies: a real button, in the document, and
   * *outside* the card.
   *
   * Outside is the whole of the revision rather than an incidental of the
   * fixture — a landing the card contains would be a landing the card takes
   * away again when it leaves, which is the arrangement #284 D14 moved away
   * from. Handed back with its element so a case can take it out of the
   * document, since nothing else here would.
   */
  const focusTarget = (): RefObject<HTMLButtonElement | null> => {
    const button = document.createElement('button');
    button.textContent = '24 h';
    document.body.append(button);

    return { current: button };
  };

  it('falls back to its own heading when it is given no landing to point at', () => {
    // The fallback arm, reached in the app by a source that renders no range
    // picker — a bare forward horizon, with neither a look-back nor actuals
    // (`dashboard/FleetPanel.tsx`). Without a control to land on, announcing the
    // surface by its own name is still better than leaving the reader on a
    // marker.
    renderCard(READY);

    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Rathmines rooftop' }));
  });

  it('lands on the target it is given rather than on its own heading', () => {
    const landing = focusTarget();

    render(
      <SitePopoverCard
        site={SITE}
        selectionOrigin="reader"
        selectionFocusRef={landing}
        firstForecast={READY}
        onRetryFirstForecast={vi.fn<() => void>()}
        onClose={vi.fn<() => void>()}
      />,
    );

    // Both halves: the reader is on the control, and specifically *not* on the
    // heading — which without the second assertion is what a card ignoring the
    // ref would still look like from the first one alone if the target happened
    // to hold focus already.
    expect(document.activeElement).toBe(landing.current);
    expect(document.activeElement).not.toBe(
      screen.getByRole('heading', { name: 'Rathmines rooftop' }),
    );

    landing.current?.remove();
  });

  it('leaves a reader on that landing when it goes, rather than chasing its opener', () => {
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();

    const landing = focusTarget();
    const { unmount } = render(
      <SitePopoverCard
        site={SITE}
        selectionOrigin="reader"
        selectionFocusRef={landing}
        firstForecast={READY}
        onRetryFirstForecast={vi.fn<() => void>()}
        onClose={vi.fn<() => void>()}
      />,
    );

    unmount();

    /*
     * The restore neutralizing itself, which is what lets the opener machinery
     * survive the revision unchanged. The card still captured `opener` on the
     * way in, but it never held the focus it would be handing back — so the
     * guard declines and the reader keeps the live control they were left on.
     * Restoring here would yank them onto the map for a card they were never in.
     */
    expect(document.activeElement).toBe(landing.current);

    landing.current?.remove();
    opener.remove();
  });

  it('keeps the heading out of the tab order while making it a focus target', () => {
    renderCard(READY);

    // `tabIndex={-1}`: a heading nobody can tab *to*, which is the whole point —
    // it is the announcement of a surface, not a control.
    expect(
      screen.getByRole('heading', { name: 'Rathmines rooftop' }).getAttribute('tabindex'),
    ).toBe('-1');
  });

  it('moves no focus at all when the selection came from the address bar', () => {
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();

    renderCard(READY, 'deep-link');

    // The whole of #260: this card mounts when the fleet listing resolves, which
    // on a deep link can be seconds after first paint, so the focus it declines
    // to take is whatever the reader had reached in the meantime.
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  // The two cases below are the fallback arm on the way out: with no landing to
  // point at the card really does hold the focus, so it really does owe it back.
  // In the app the same pair is reached by a reader who came into the card from
  // the picker, which `Dashboard.focus.test.tsx` drives through a pressed Close.
  it('hands focus back to whatever held it, when the card leaves', () => {
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();

    const { unmount } = render(
      <SitePopoverCard
        site={SITE}
        selectionOrigin="reader"
        firstForecast={READY}
        onRetryFirstForecast={vi.fn<() => void>()}
        onClose={vi.fn<() => void>()}
      />,
    );

    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Rathmines rooftop' }));

    unmount();

    // Without this the Close button unmounts under the reader and focus falls to
    // `body`: no position, nothing announced, and a keyboard user starting the
    // page again.
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it('chases no opener that has left the document', () => {
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();

    const { unmount } = render(
      <SitePopoverCard
        site={SITE}
        selectionOrigin="reader"
        firstForecast={READY}
        onRetryFirstForecast={vi.fn<() => void>()}
        onClose={vi.fn<() => void>()}
      />,
    );

    // The opener goes before the card does — a control inside a dialog that has
    // since been dismissed, say. Focusing a detached element does nothing except
    // silently move focus to `body`, so the card declines rather than pretending.
    opener.remove();
    unmount();

    expect(document.activeElement).toBe(document.body);
  });
});
