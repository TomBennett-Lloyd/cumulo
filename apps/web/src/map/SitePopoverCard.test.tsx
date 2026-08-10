// @vitest-environment jsdom

import type { Site } from '@cumulo/shared';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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
 * What this file cannot show is the focus *ring*, which is layout and paint and
 * therefore the browser lane's. The card lands nobody inside itself since #328,
 * so the only ring it can have is on one of its own controls, once a reader has
 * arrived there by tabbing or by pressing it — and which of those two arrivals
 * paints one is the rule that lane holds, in two specs of a clause each:
 * `e2e/keyboard-focus.spec.ts` for the ring a keyboard reader must still get,
 * `e2e/pointer-focus.spec.ts` for the ring that must not appear under a pointer.
 * Both prove it on other controls, and neither means anything without the other.
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
    // never hear from. It is the cheapest child to fire from rather than a
    // reader's route: nobody tabs onto a heading, and the reachable control the
    // container handler is really there for is the `Try again` on a failed first
    // forecast. A reader's focus starts *outside* this subtree — a selection
    // moves nobody in (#328) — where Escape is deliberately not this card's.
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
    //
    // The chart's own root class, not `querySelector('svg')`, which stood here
    // until the close affordance became an X (#340): the card now holds an
    // `<svg>` in every state, so a bare svg-presence query is false by
    // construction and passes over exactly the defect it was written to catch.
    // `dashboard/FleetPanel.test.tsx` retired the same proxy at #284 D3 for the
    // same reason and its docblock carries the argument — naming the mark that
    // must be absent is what the query is worth.
    expect(container.querySelector('.forecast-chart')).toBeNull();
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
 * The focus rule: `design.md` rule 11, as #328 settled it over #260. The
 * composition-level cases are `Dashboard.focus.test.tsx`'s — these are the
 * component's own contract, which is what makes the card renderable in isolation
 * and the rule readable in one file (`react.md` rule 4).
 *
 * Two halves, and the card is the only place both are visible. On the way *in*
 * it takes nothing, whoever asked: the surface answers by being named, not by
 * moving anybody to it. On the way *out* it returns the focus it captured — but
 * only if it is holding that focus by then, which is true of exactly the reader
 * who came into the card and dismissed it from inside.
 */
describe('SitePopoverCard focus', () => {
  /** A control the reader can be standing on, in the document and outside the card. */
  const controlOutside = (): HTMLButtonElement => {
    const button = document.createElement('button');
    document.body.append(button);

    return button;
  };

  it('takes no focus when it opens, even though a reader asked for the selection', () => {
    const opener = controlOutside();
    opener.focus();

    renderCard(READY);

    /*
     * The rule, at its narrowest. The card is on screen and named — the second
     * assertion is what stops this from passing over a card that failed to
     * render at all — and the reader is still on the control they pressed. Any
     * landing put back into the mount effect, on the heading or anywhere else,
     * fails here.
     */
    expect(document.activeElement).toBe(opener);
    expect(screen.getByRole('heading', { name: 'Rathmines rooftop' })).not.toBeNull();

    opener.remove();
  });

  it('leaves a reader where they moved to when it goes, rather than chasing its opener', () => {
    const opener = controlOutside();
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

    // The reader moves on to a live control of their own accord, which is the
    // state every dismissal from outside the card is in.
    const elsewhere = controlOutside();
    elsewhere.focus();

    unmount();

    /*
     * The restore neutralizing itself, which is what lets the opener machinery
     * survive the removal of the landing unchanged. The card did capture
     * `opener` on the way in, but it never held the focus it would be handing
     * back — so the guard declines and the reader keeps the control they chose.
     * Restoring here would yank them onto the map for a card they were never in.
     */
    expect(document.activeElement).toBe(elsewhere);

    elsewhere.remove();
    opener.remove();
  });

  it('moves no focus at all when the selection came from the address bar', () => {
    const opener = controlOutside();
    opener.focus();

    renderCard(READY, 'deep-link');

    // The whole of #260: this card mounts when the fleet listing resolves, which
    // on a deep link can be seconds after first paint, so the focus it declines
    // to take is whatever the reader had reached in the meantime.
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it('captures no opener to return to when the selection came from the address bar', () => {
    const opener = controlOutside();
    opener.focus();

    const { unmount } = render(
      <SitePopoverCard
        site={SITE}
        selectionOrigin="deep-link"
        firstForecast={READY}
        onRetryFirstForecast={vi.fn<() => void>()}
        onClose={vi.fn<() => void>()}
      />,
    );

    // A reader tabs into the card and closes it — the one gesture that collects
    // the hand-back on the reader-initiated arm below.
    screen.getByRole('button', { name: 'Close' }).focus();

    unmount();

    /*
     * And there is nothing to collect. What held focus when a deep-linked card
     * mounted is whatever the reader happened to be on when the fleet listing
     * resolved, which nobody chose as an opener — so the card never captured it,
     * and focus falls where the browser leaves it. This is the whole of what
     * `dashboard/selection-origin.ts` still gates now that neither arm moves
     * focus on the way in; the case below is its positive control.
     */
    expect(document.activeElement).toBe(document.body);
    opener.remove();
  });

  // The two cases below are the way out for a reader who came *into* the card,
  // which is the only way it holds the focus it owes back. In the app that is a
  // pressed or tabbed-to Close, which `Dashboard.focus.test.tsx` drives.
  it('hands focus back to whatever held it, when the card leaves', () => {
    const opener = controlOutside();
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

    screen.getByRole('button', { name: 'Close' }).focus();

    unmount();

    // Without this the Close button unmounts under the reader and focus falls to
    // `body`: no position, nothing announced, and a keyboard user starting the
    // page again.
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it('chases no opener that has left the document', () => {
    const opener = controlOutside();
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

    // The reader is inside the card, so the hand-back is owed — and then the
    // opener goes before the card does, a control inside a dialog that has since
    // been dismissed, say. Focusing a detached element does nothing except
    // silently move focus to `body`, so the card declines rather than pretending.
    screen.getByRole('button', { name: 'Close' }).focus();
    opener.remove();
    unmount();

    expect(document.activeElement).toBe(document.body);
  });
});
