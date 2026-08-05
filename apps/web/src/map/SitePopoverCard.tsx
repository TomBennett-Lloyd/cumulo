import type { Site } from '@cumulo/shared';
import type { KeyboardEvent as ReactKeyboardEvent, ReactElement } from 'react';
import { useEffect, useId, useRef } from 'react';

import type { ForecastViewState } from '../dashboard/forecast-view-state';
import { PanelError, PanelPending } from '../dashboard/panel-states';
import type { SelectionOrigin } from '../dashboard/selection-origin';
import { angleLabel, capacityLabel, coordinatesLabel } from '../dashboard/site-format';
import {
  firstForecastTimeoutMessage,
  firstForecastUnansweredMessage,
  generatingFirstForecastLabel,
  loadingSiteSeriesLabel,
} from '../dashboard/state-copy';

/*
 * One site's card, as the map draws it.
 *
 * Presentational and DOM-only (`react.md` rule 4): the facts come from the
 * `Site` handed in, the forecast state is the dashboard's poll handed in, and
 * nothing here fetches anything. That is what lets it be rendered in jsdom —
 * `SitePopover.tsx` is the half that needs a live maplibre map, and it is this
 * card that it portals into a marker.
 *
 * It replaced a panel in the reading column (`SitePanel`, #265). Two things went
 * with the move. The site's own chart is no longer here: one site's forecast is
 * now a second series on the fleet chart below the map (`site-overlay.ts`), so
 * the card carries the site's identity and the state of its first forecast and
 * stops there — a chart at marker size would be a chart nobody could read.
 * And the reading column stopped swapping at all, which is why the card owes a
 * focus landing of its own rather than inheriting the region's.
 */

/**
 * The deadline the first-forecast poll enforces, in seconds.
 *
 * Restated from `FIRST_FORECAST_DEADLINE_MS` in `../data/use-first-forecast`,
 * which is module-private there. The number is the reader's, not the
 * transport's: the hook's own timeout message names the site by uuid and says
 * nothing about what to do next, so this card says it in the app's words
 * instead (`state-copy.ts`) and needs the figure to do it. Exporting the
 * deadline from the hook would collapse the pair — see the note on #148.
 */
const FIRST_FORECAST_DEADLINE_SECONDS = 90;

type FailedForecast = Extract<ForecastViewState, { readonly status: 'failed' }>;

/**
 * What the reader is told when the first forecast stopped being worth waiting
 * for.
 *
 * The two deadline reasons get the app's own sentences, because the hook's are
 * diagnostic ("no forecast for site 2a9c…") — and they get *different*
 * sentences, because the two runs learned different things. A `timeout` waited
 * out a wait the fleet confirmed was a wait, so saying the pipeline may still
 * be working is true and waiting longer is the recourse. An `unanswered` run
 * never heard back at all, so the same sentence would assert a pipeline state
 * nobody established; it says what it knows instead. A fault gets the source's
 * message verbatim — it is the only account of what actually failed, and
 * paraphrasing it would lose the detail (`error-handling.md` rule 4).
 *
 * Every arm keeps the retry (its caller supplies one for the whole `failed`
 * state): re-asking is a real recourse for all three, and most obviously for
 * the run whose only problem was that nothing came back.
 */
const firstForecastFailureMessage = (failure: FailedForecast): string => {
  switch (failure.reason) {
    case 'timeout':
      return firstForecastTimeoutMessage(FIRST_FORECAST_DEADLINE_SECONDS);
    case 'unanswered':
      return firstForecastUnansweredMessage(FIRST_FORECAST_DEADLINE_SECONDS);
    case 'error':
      return failure.message;
  }
};

interface SiteForecastRegionProps {
  readonly site: Site;
  readonly firstForecast: ForecastViewState;
  readonly onRetryFirstForecast: () => void;
}

/**
 * One arm of {@link ForecastViewState}, rendered — and nothing at all once the
 * forecast has arrived.
 *
 * The two waits get two sentences, because they are two different facts. While
 * the fleet has not answered — an established site's ordinary round trip, or a
 * fault that says nothing about whether a forecast exists — this is a plain
 * load, worded exactly as every other surface words its own (#177). Only once
 * the fleet has confirmed the forecast is absent does the card count out loud:
 * the demo's headline promise is a forecast about a minute after a site is
 * added, and a visitor watching that minute is owed the elapsed seconds — a
 * bare spinner cannot distinguish a pipeline that is working from one that has
 * stalled.
 *
 * A halt gets the source's message and **no retry**: `forbidden`'s recourse is
 * a deployment change, so a button re-running the identical refused request
 * would be telling the reader to do the one thing that cannot work
 * (`react.md`'s async-surface convention).
 *
 * `ready` renders nothing, which is the whole of what this card gained by
 * giving up its chart. The arrival of the forecast is not announced (`react.md`
 * — completion is the busy container being replaced), and where the forecast
 * went is on screen already: the fleet chart below the map has grown a series
 * named after this site, with its own legend row and its own table column.
 */
const SiteForecastRegion = ({
  site,
  firstForecast,
  onRetryFirstForecast,
}: SiteForecastRegionProps): ReactElement | null => {
  switch (firstForecast.status) {
    case 'checking':
      return <PanelPending label={loadingSiteSeriesLabel(site.name)} />;
    case 'generating':
      return <PanelPending label={generatingFirstForecastLabel(firstForecast.elapsedSeconds)} />;
    case 'failed':
      return (
        <PanelError
          message={firstForecastFailureMessage(firstForecast)}
          onRetry={onRetryFirstForecast}
        />
      );
    case 'halted':
      return <PanelError message={firstForecast.message} />;
    case 'ready':
      return null;
  }
};

export interface SitePopoverCardProps {
  readonly site: Site;
  /** Whether a reader asked for this selection, or the address bar did. */
  readonly selectionOrigin: SelectionOrigin;
  /** The dashboard's first-forecast poll for this site — it owns the clock, not the card. */
  readonly firstForecast: ForecastViewState;
  readonly onRetryFirstForecast: () => void;
  /** Clears the selection: the close button, and Escape anywhere inside the card. */
  readonly onClose: () => void;
}

/**
 * Everything known about one site, in the card anchored to its marker.
 *
 * ## Focus moves for a reader, and never for a link
 *
 * The rule this card implements is the settlement of
 * [#260](https://github.com/TomBennett-Lloyd/cumulo/issues/260), and
 * `react.md`'s focus paragraph is where it is written down. When the selection
 * came from a reader — a marker, a row, a creation — the card announces itself
 * by focusing its own heading, which is `tabIndex={-1}` so it is a focus target
 * without joining the tab order. When the selection came from `?site=`, focus
 * does not move at all.
 *
 * The asymmetry is not a special case for page load; it is the whole rule. This
 * card mounts when the *fleet listing resolves*, and on a deep link that is not
 * page load — it can be seconds later, by which time the reader may be well
 * inside the page. Moving focus then takes it from somebody who did nothing to
 * ask for it. The reader-initiated paths have the opposite problem and the
 * opposite answer: they changed the page in response to a press, so a focus that
 * stayed on the pressed control would leave a keyboard reader to find the new
 * surface by tabbing.
 *
 * Closing gives focus back to whatever held it when the card opened, captured on
 * the way in rather than reconstructed on the way out. Reconstructing it is what
 * the old panel did — it searched the site list for the matching row — and that
 * answer was wrong for every opener that is not a row. The capture happens
 * *inside* the effect, after React has flushed the commit's unmount cleanups, so
 * a creation lands on the map's add-site control (where the dismissed dialog put
 * it) rather than on the submit button that is no longer in the document. An
 * opener that has since left the document is not chased: focus stays where the
 * browser puts it, which is the same place a card with no landing at all would
 * have left it.
 *
 * The document's focus is state no render owns and no re-render restores, so
 * this is exactly the external system an effect is for (`react.md` rule 1).
 *
 * ## No Open-Meteo credit here
 *
 * The card displays no weather-derived value — the facts are the site's own
 * physical configuration, and the forecast arms say only whether one exists yet.
 * The map's own credits band carries the obligation for everything drawn on the
 * tiles, and the page footer carries it for the reading below
 * (`map-treatment.md`, Attribution). A credit that came and went with a
 * selection is one that will eventually be missing when it matters.
 */
export const SitePopoverCard = ({
  site,
  selectionOrigin,
  firstForecast,
  onRetryFirstForecast,
  onClose,
}: SitePopoverCardProps): ReactElement => {
  const titleId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (selectionOrigin !== 'reader') {
      return;
    }

    const active = document.activeElement;
    const opener = active instanceof HTMLElement ? active : null;

    headingRef.current?.focus();

    return () => {
      if (opener?.isConnected === true) {
        opener.focus();
      }
    };
  }, [selectionOrigin]);

  /**
   * Escape closes, from anywhere inside the card.
   *
   * On the container rather than on the close button, because the reader's focus
   * is on the heading the moment the card opens — and a dismissal that only
   * worked from one control would be a dismissal most readers never reach. It
   * rides the React event, so every child is covered without any of them knowing.
   */
  const closeOnEscape = (event: ReactKeyboardEvent<HTMLElement>): void => {
    if (event.key === 'Escape') {
      onClose();
    }
  };

  return (
    <section className="site-popover" aria-labelledby={titleId} onKeyDown={closeOnEscape}>
      <header className="site-popover-header">
        <h2 className="site-popover-title" id={titleId} ref={headingRef} tabIndex={-1}>
          {site.name}
        </h2>
        <button type="button" className="site-popover-close" onClick={onClose}>
          Close
        </button>
      </header>

      <dl className="site-popover-facts">
        <div className="site-popover-fact">
          <dt>Coordinates</dt>
          <dd>{coordinatesLabel(site)}</dd>
        </div>
        <div className="site-popover-fact">
          <dt>Tilt</dt>
          <dd>{angleLabel(site.tiltDegrees)}</dd>
        </div>
        <div className="site-popover-fact">
          <dt>Azimuth</dt>
          <dd>{angleLabel(site.azimuthDegrees)}</dd>
        </div>
        <div className="site-popover-fact">
          <dt>Capacity</dt>
          <dd>{capacityLabel(site.capacityKw)}</dd>
        </div>
      </dl>

      <SiteForecastRegion
        site={site}
        firstForecast={firstForecast}
        onRetryFirstForecast={onRetryFirstForecast}
      />
    </section>
  );
};
