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
 * And the reading column stopped swapping at all, which is why a selection has
 * nothing to announce by displacement and this card announces itself by its own
 * accessible name instead.
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
 * for this site, with its own column in the table twin. The legend row naming it
 * is a press away rather than on screen, since #429 moved the legend behind that
 * panel's (i) — which costs this paragraph nothing, because what it is claiming
 * is that the forecast visibly arrived somewhere, not that its name did.
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
  /**
   * Whether a reader asked for this selection, or the address bar did — which
   * decides whether this card captures an opener to hand back on close.
   */
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
 * ## A selection moves focus nowhere
 *
 * This card takes no focus when it opens, whoever asked for the selection. That
 * is `design.md` rule 11 — focus stays where the reader put it — as #328
 * settled it; `react.md`'s focus paragraphs are where the mechanics are written
 * down. A reader who pressed a marker is still on that marker, and a reader who
 * picked a site out of the header's search is still in the search input, which
 * is the combobox discipline that pattern owes anyway.
 *
 * What answers a selection instead is structure. This card is
 * `aria-labelledby` its own heading, so the surface names its site the moment it
 * exists; the fleet chart *draws that site's line* over the fleet's sum as soon
 * as its hours arrive; and the header's search says so in its own status region.
 * Not the chart's readout — that region mounts empty and fills only when a
 * reader moves the chart's own selection, so at the moment of arrival it names
 * nothing at all (`react.md`'s live-region bullet).
 *
 * The chart's contribution used to be written here as its *legend* growing a row
 * under the site's name, and that stopped being the unprompted half on
 * 2026-08-11: #429 moved the legend behind the panel's (i), so the row still
 * exists and still carries the name (`dashboard/site-overlay.ts` supplies the
 * label) but it is one press away rather than on screen. The drawn line is what
 * a reader is shown without asking, which is what this paragraph is about.
 * The alternative is moving somebody to the answer, which this card did in two
 * different spellings before #328 and no longer does in either: a page that
 * grabs the focus takes the reader's place away to tell them something it could
 * have told them where they stood.
 *
 * {@link SitePopoverCardProps.selectionOrigin} therefore no longer decides
 * whether focus *moves* — nothing moves it. What it still decides is whether
 * this card captures an opener at all, which is the settlement of
 * [#260](https://github.com/TomBennett-Lloyd/cumulo/issues/260) surviving in the
 * one clause that outlived the landing. A `?site=` card returns nobody anywhere
 * on close, because nobody's press put a reader anywhere for it to return them
 * to: it mounts when the *fleet listing resolves*, which on a deep link is not
 * page load and can be seconds later.
 *
 * Escape is the cost that is left, and it is now the ordinary one. Escape closes
 * from anywhere *inside* the card, so a reader has to be in the card for it to
 * mean anything — which a pointer press on Close does for free, and a keyboard
 * reader does by tabbing to it. Nothing was added to reach them from outside:
 * a document-level key handler would claim a key the map itself is free to want.
 *
 * ## The landing on the way out, which this card owes only to a reader inside it
 *
 * Closing gives focus back to whatever held it when the card opened, captured on
 * the way in rather than reconstructed on the way out. Reconstructing it is what
 * the old panel did — it searched the site list for the matching row — and that
 * answer was wrong for every opener that is not a row. The capture happens
 * *inside* the effect, after React has flushed the commit's unmount cleanups, so
 * a creation captures the map's add-site control (where the dismissed dialog put
 * it) rather than the submit button that is no longer in the document.
 *
 * **It gives focus back only if it still has focus to give**, which is the whole
 * of the cleanup's guard below and is not a detail — an unconditional restore
 * both yanks a reader who has moved on and, on a selection moving from one site
 * to the next, hands the second card the *first* site's opener. An opener that
 * has since left the document is not chased either: focus stays where the
 * browser puts it, which is the same place a card with no landing at all would
 * have left it.
 *
 * Since a selection lands nobody in here, that guard mostly declines by its own
 * terms, and deliberately so: a card the reader was never put inside is not
 * holding the focus it would be giving back, so a dismissal that happens from
 * outside it — another marker, a search hit — leaves the reader exactly where
 * they already were. What the machinery still answers is the reader who came
 * *into* the card: pressing Close focuses it, and tabbing to it does too, so the
 * control they are standing on is about to unmount under them. The mechanism is
 * kept whole rather than deleted because that path is ordinary, not because the
 * landing might come back.
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
  const cardRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (selectionOrigin !== 'reader') {
      return;
    }

    const active = document.activeElement;
    const opener = active instanceof HTMLElement ? active : null;
    const card = cardRef.current;

    // Nothing is focused on the way in: a selection moves focus nowhere
    // (`design.md` rule 11, #328). This effect exists for the way *out* — the
    // capture above and the guarded restore below.

    return () => {
      // An opener that has left the document is not chased: focusing a detached
      // element silently moves focus to `body`, which is where it would have
      // fallen anyway.
      if (opener?.isConnected !== true) {
        return;
      }

      /*
       * Only give focus back if this card still has it to give.
       *
       * A leaving card is not entitled to move a focus that is no longer its
       * own. Three cases make that concrete, and since #328 the first is the
       * ordinary one rather than an edge. **The reader was never inside this
       * card at all**: opening it moved nobody, so every dismissal that does not
       * go through a control in here — another marker, the search — finds
       * the focus somewhere this card never held it, and a restore would drag
       * them back to the map from wherever they actually are. **The reader left
       * of their own accord**, tabbing or clicking away and then dismissing from
       * there, which is the same answer for the same reason. And **pressing
       * marker B while site A's card is open** moves focus to marker B *before*
       * the commit — so A's cleanup, if it restored unconditionally, would put
       * focus back on marker A, B's mount effect would then capture marker A as
       * its opener, and closing B would strand the reader on the marker of a
       * site they stopped looking at two interactions ago.
       *
       * "Still has it" is `body` or inside this card. `body` is the usual answer
       * on a real dismissal: React detaches this subtree during the mutation
       * phase and the browser drops focus to `body` before this passive cleanup
       * runs, so the Close button the reader was on is already gone. The
       * `contains` arm covers the case where the DOM is still up — this effect
       * re-running on a change of `selectionOrigin`, and StrictMode's
       * development remount.
       */
      const focused = document.activeElement;
      const cardStillHoldsFocus =
        focused === null || focused === document.body || card?.contains(focused) === true;

      if (cardStillHoldsFocus) {
        opener.focus();
      }
    };
  }, [selectionOrigin]);

  /**
   * Escape closes, from anywhere inside the card.
   *
   * On the container rather than on the close button, so that every control the
   * reader can reach inside the card dismisses it. There are two of those and
   * the second is the reason this is not just a handler on Close: the failed
   * arms of {@link SiteForecastRegion} carry a `Try again`, so a reader who has
   * moved on to the retry would otherwise be holding a control Escape does not
   * answer from. The handler rides the React event, so every child is covered
   * without any of them knowing.
   *
   * What it deliberately does not cover is a reader who has not come into the
   * card — since #328 that is everybody a selection has just answered, standing
   * wherever they pressed. The docblock above says why no document-level handler
   * was added to reach them there.
   */
  const closeOnEscape = (event: ReactKeyboardEvent<HTMLElement>): void => {
    if (event.key === 'Escape') {
      onClose();
    }
  };

  return (
    <section
      className="site-popover"
      ref={cardRef}
      aria-labelledby={titleId}
      onKeyDown={closeOnEscape}
    >
      <header className="site-popover-header">
        <h2 className="site-popover-title" id={titleId}>
          {site.name}
        </h2>
        {/*
         * An X, with the word moved to the accessible name.
         *
         * `design.md` rule 2: a label whose only job is naming a control for
         * assistive technology becomes an accessible name rather than visible
         * text, and "close" is one of the two instances that rule settles.
         * Nothing is lost to a screen reader — the button is still found by the
         * name `Close` — and the card gets back the width the word was taking
         * from a title that has a site name to fit.
         *
         * The mark is drawn on the header's terms (`header/HeaderMenu.tsx`'s
         * burger): a 20-unit `viewBox`, `aria-hidden` so the name is said once,
         * and stroked in `currentColor` so it follows the button through both
         * themes. `site-popover.css` says why the drawing declarations are
         * restated there rather than shared.
         */}
        <button type="button" className="site-popover-close" aria-label="Close" onClick={onClose}>
          <svg className="site-popover-close-icon" viewBox="0 0 20 20" aria-hidden="true">
            <path d="M5 5 15 15" />
            <path d="M15 5 5 15" />
          </svg>
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
