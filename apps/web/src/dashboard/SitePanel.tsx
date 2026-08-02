import type { Site } from '@cumulo/shared';
import type { ReactElement } from 'react';
import { useEffect, useId, useRef, useState } from 'react';

import { ForecastChart } from '../charts/ForecastChart';
import type { FleetDataSource, RangeHours } from '../data/fleet-data-source';
import { useFleetQuery, type QueryState } from '../data/use-fleet-query';
import type { ForecastViewState } from './forecast-view-state';
import { PanelEmpty, PanelError, PanelPending } from './panel-states';
import { RangePicker } from './range-picker';
import { angleLabel, capacityLabel, coordinatesLabel } from './site-format';
import { joinSiteSeries, loadSiteSeries, type SiteSeries } from './site-series';
import {
  firstForecastTimeoutMessage,
  generatingFirstForecastLabel,
  loadingSiteSeriesLabel,
  NO_MEASUREMENTS_NOTICE,
  NO_SITE_FORECAST_MESSAGE,
  siteSeriesFailureMessage,
} from './state-copy';

/*
 * One site's whole story, beside the map.
 *
 * Two waits live in this panel and they are not the same wait, which is why the
 * forecast region branches on `firstForecast` before it fetches anything. A
 * site created seconds ago has no forecast at all yet — that wait belongs to the
 * dashboard's polling hook, which owns the clock and the deadline. Only once it
 * has answered is there a series worth asking for over a window, and that
 * second wait is this panel's own.
 *
 * Everything below the header is presentational bar that one query
 * (`react.md` rule 4): the facts come from the `Site` handed in, the join lives
 * in `site-series.ts`, and the drawing belongs to `ForecastChart`.
 */

/** Both charts open on 24 h; the window is each surface's own choice, not a shared fact. */
const DEFAULT_RANGE: RangeHours = 24;

/**
 * The deadline the first-forecast poll enforces, in seconds.
 *
 * Restated from `FIRST_FORECAST_DEADLINE_MS` in `../data/use-first-forecast`,
 * which is module-private there. The number is the reader's, not the
 * transport's: the hook's own timeout message names the site by uuid and says
 * nothing about what to do next, so the panel says it in the column's words
 * instead (`state-copy.ts`) and needs the figure to do it. Exporting the
 * deadline from the hook would collapse the pair — see the note on #148.
 */
const FIRST_FORECAST_DEADLINE_SECONDS = 90;

type FailedForecast = Extract<ForecastViewState, { readonly status: 'failed' }>;

/**
 * What the reader is told when the first forecast stopped being worth waiting
 * for.
 *
 * A timeout gets the column's own sentence, because the hook's is diagnostic
 * ("no forecast for site 2a9c…"): nothing went wrong, the pipeline is simply
 * behind, and the useful thing to say is that waiting longer may still work. A
 * fault gets the source's message verbatim — it is the only account of what
 * actually failed, and paraphrasing it would lose the detail
 * (`error-handling.md` rule 4).
 */
const firstForecastFailureMessage = (failure: FailedForecast): string =>
  failure.reason === 'timeout'
    ? firstForecastTimeoutMessage(FIRST_FORECAST_DEADLINE_SECONDS)
    : failure.message;

interface SiteSeriesBodyProps {
  readonly site: Site;
  readonly state: QueryState<SiteSeries>;
}

/**
 * The window's series, in whichever of its four states it is in.
 *
 * The failure arm carries **no retry**, unlike the first-forecast arm above it.
 * Re-running the identical `/series` pair is not a recourse — it is the same
 * metered request against the same source that just refused it — and the
 * reader already holds a control that re-asks honestly: changing the range
 * issues a different query. `react.md`'s async-surface convention is explicit
 * that a retry that cannot help is worse than none.
 */
const SiteSeriesBody = ({ site, state }: SiteSeriesBodyProps): ReactElement => {
  if (state.status === 'loading') {
    return <PanelPending label={loadingSiteSeriesLabel(site.name)} />;
  }
  if (state.status === 'failed') {
    return <PanelError message={siteSeriesFailureMessage(site.name, state.error.message)} />;
  }

  const points = joinSiteSeries(state.data.forecasts, state.data.actuals);
  if (points.length === 0) {
    return <PanelEmpty message={NO_SITE_FORECAST_MESSAGE} />;
  }

  return (
    <>
      {points.some((point) => point.actualKw !== null) ? null : (
        <p className="panel-notice">{NO_MEASUREMENTS_NOTICE}</p>
      )}
      <ForecastChart
        points={points}
        ariaLabel={`${site.name}: forecast and measured generation`}
        tableCaption={`Table view — ${site.name}, kW`}
      />
    </>
  );
};

interface SiteSeriesSectionProps {
  readonly dataSource: FleetDataSource;
  readonly site: Site;
}

/**
 * The chart and the control that chooses its window.
 *
 * The window is state here rather than in {@link SitePanel} because nothing
 * above this component reads it, and this component only exists once a forecast
 * does (`react.md` rule 3). The query key names every input the query reads,
 * which is `useFleetQuery`'s contract: a superseded window's answer is
 * dropped rather than allowed to overwrite the chart the reader is looking at.
 */
const SiteSeriesSection = ({ dataSource, site }: SiteSeriesSectionProps): ReactElement => {
  const [range, setRange] = useState<RangeHours>(DEFAULT_RANGE);
  const state = useFleetQuery(
    () => loadSiteSeries(dataSource, site.id, range),
    ['site-series', site.id, range],
  );

  return (
    <>
      <RangePicker range={range} ariaLabel="Forecast range" onSelect={setRange} />
      <SiteSeriesBody site={site} state={state} />
    </>
  );
};

interface SiteForecastRegionProps {
  readonly dataSource: FleetDataSource;
  readonly site: Site;
  readonly firstForecast: ForecastViewState;
  readonly onRetryFirstForecast: () => void;
}

/**
 * One arm of {@link ForecastViewState}, rendered.
 *
 * The two waits get two sentences, because they are two different facts. While
 * the fleet has not answered — an established site's ordinary round trip, or a
 * fault that says nothing about whether a forecast exists — this is a plain
 * load, worded exactly as the series below it words its own (#177). Only once
 * the fleet has confirmed the forecast is absent does the panel count out loud:
 * the demo's headline promise is a forecast about a minute after a site is
 * added, and a visitor watching that minute is owed the elapsed seconds — a
 * bare spinner cannot distinguish a pipeline that is working from one that has
 * stalled.
 *
 * A halt gets the source's message and **no retry**: `forbidden`'s recourse is
 * a deployment change, so a button re-running the identical refused request
 * would be telling the reader to do the one thing that cannot work
 * (`react.md`'s async-surface convention).
 */
const SiteForecastRegion = ({
  dataSource,
  site,
  firstForecast,
  onRetryFirstForecast,
}: SiteForecastRegionProps): ReactElement => {
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
      return <SiteSeriesSection dataSource={dataSource} site={site} />;
  }
};

export interface SitePanelProps {
  readonly dataSource: FleetDataSource;
  readonly site: Site;
  /** The dashboard's first-forecast poll for this site — it owns the clock, not the panel. */
  readonly firstForecast: ForecastViewState;
  readonly onRetryFirstForecast: () => void;
  readonly onClose: () => void;
}

/**
 * Everything known about one site, as the panel column's context.
 *
 * No Open-Meteo credit inside the panel: the column carries one persistent
 * credit at its foot, which is on screen in every context the column can be in
 * — a credit per panel would multiply as panels do, and a credit that comes and
 * goes with a selection is one that will eventually be missing when it matters
 * (CC BY 4.0, CLAUDE.md hard constraints).
 */
export const SitePanel = ({
  dataSource,
  site,
  firstForecast,
  onRetryFirstForecast,
  onClose,
}: SitePanelProps): ReactElement => {
  const titleId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);

  /*
   * Taking the context region means taking the focus with it.
   *
   * The column swaps one occupant for another above the reader's focus point,
   * and a swap nobody is told about is one a keyboard or screen-reader user
   * only discovers by tabbing into it. The occupant announces itself by
   * focusing its own heading — the panel's name is the answer to "what is this
   * region now?" — and the heading is `tabIndex={-1}` so it is a focus target
   * without joining the tab order.
   *
   * The document's focus is state no render owns and no re-render restores, so
   * this is the external system an effect is for (`react.md` rule 1). It fires
   * on mount, on a change of site, and on the remount that a cancelled draft
   * produces — three ways of arriving at the same fact, which is why the panel
   * does it rather than each of the dashboard's call sites.
   *
   * A `?site=` deep link lands here too, at page load, and that is deliberate:
   * the panel is the content the address named, so it is where the reader is
   * meant to start.
   */
  useEffect(() => {
    headingRef.current?.focus();
  }, [site.id]);

  return (
    <section className="site-panel" aria-labelledby={titleId}>
      <header className="site-panel-header">
        <h2 className="site-panel-title" id={titleId} ref={headingRef} tabIndex={-1}>
          {site.name}
        </h2>
        <button type="button" className="site-panel-close" onClick={onClose}>
          Close
        </button>
      </header>

      <dl className="site-facts">
        <div className="site-fact">
          <dt>Coordinates</dt>
          <dd>{coordinatesLabel(site)}</dd>
        </div>
        <div className="site-fact">
          <dt>Tilt</dt>
          <dd>{angleLabel(site.tiltDegrees)}</dd>
        </div>
        <div className="site-fact">
          <dt>Azimuth</dt>
          <dd>{angleLabel(site.azimuthDegrees)}</dd>
        </div>
        <div className="site-fact">
          <dt>Capacity</dt>
          <dd>{capacityLabel(site.capacityKw)}</dd>
        </div>
      </dl>

      <section className="site-panel-forecast" aria-label="Forecast">
        <SiteForecastRegion
          dataSource={dataSource}
          site={site}
          firstForecast={firstForecast}
          onRetryFirstForecast={onRetryFirstForecast}
        />
      </section>
    </section>
  );
};
