import type { ReactElement } from 'react';

/**
 * The chart has no data path left to draw from, said inside the plot's own box.
 *
 * The owner asked for this one in these terms on 2026-08-12 (#452): *"the sites
 * fetch error state should show in the graph area … this can be the generic
 * error message for anything that means we can't show data on the graph, no need
 * to be too specific if the error state is basically just a total failure."* So
 * there is one account of a total failure rather than one per read, and what
 * routes into it is the caller's question, not this module's — `ForecastChart`
 * renders whatever notice it is handed and nothing else decides anything here.
 *
 * **Not `PanelError`, and the shared portions really are shared** (`structure.md`
 * rule 7 — extract the shared portion, do not force the remainder together).
 * What the two states have in common is the sentence's home (`state-copy.ts`)
 * and the recourse's control (`.panel-retry`, `panel-states.css`), and both of
 * those are used here unchanged. What is *not* shared is the frame:
 * `.panel-error`'s bordered card is the treatment for a panel whose content
 * failed, drawn so the failure separates from the prose around it — and here
 * the plot **is** the panel, so a card inside it would announce a box within the
 * chart as broken rather than the chart. The frame is the figure, which is why
 * this is an overlay over the figure's existing box and not a block in the flow
 * above it (`ForecastChart.tsx`'s error paragraph, and `charts.css` for the
 * out-of-flow mechanism that keeps the page still).
 *
 * **The copy arrives as props, and that is the folder boundary rather than
 * ceremony.** `charts/` draws charts and imports nothing from `dashboard/`;
 * async and failure wording is `dashboard/state-copy.ts`'s by `react.md`'s
 * async-surface convention, swept for by `state-copy-contract.test.ts`. A
 * sentence written here would either break that sweep's premise or make this
 * folder depend on the panel that happens to render it today. The retry's name
 * travels the same way, for the same reason and one more: it is
 * `RETRY_ACTION_LABEL`, one name so it is one control, and a second spelling of
 * it in this folder would be exactly the drift that constant exists to stop.
 *
 * An element builder rather than a component, which is `charts/`'s idiom for a
 * piece of a drawing the chart composes (`xAxisElements`,
 * `forecastChartTable`): there is no state and no hook here, so a component
 * would add a reconciliation boundary and a name in the tree for nothing.
 *
 * **The text announces; the icon does not.** The container is the `role="alert"`
 * — it mounts into a figure that is already on screen, so it arrives as a change
 * and is announced (`react.md`'s **Failed** bullet). The triangle is
 * `aria-hidden` decoration: it says in a glyph what the sentence beside it says
 * in words, and a reader who cannot see it loses nothing.
 */
export interface ChartErrorNotice {
  /** What failed, in the surface's own words — never a bare transport message. */
  readonly message: string;
  /** The recourse's name, so the chart folder spells no copy of its own. */
  readonly retryLabel: string;
  /** Re-asks whichever read left the chart with nothing; the caller decides which. */
  readonly onRetry: () => void;
}

export const chartErrorOverlay = (notice: ChartErrorNotice): ReactElement => (
  <div className="forecast-chart-error" role="alert">
    {/*
     * A warning triangle in the shipped icon idiom — `map/MapControls.tsx` and
     * `map.css`'s `.map-control-icon`: a 20-unit box, strokes rather than fills,
     * `currentColor` so the mark takes the ink of the text it sits with, and the
     * weight and the caps in the stylesheet rather than on the element.
     *
     * The exclamation's dot is the `h.01` below — a subpath far shorter than the
     * stroke is wide, which a butt cap paints as a sliver too thin to see. The
     * round cap that turns it into a dot is `charts.css`'s, which says so beside
     * the rule.
     */}
    <svg className="forecast-chart-error-icon" viewBox="0 0 20 20" aria-hidden="true">
      <path d="M10 3.2 18.4 17.4H1.6Z" />
      <path d="M10 8.4v3.2M10 14.8h.01" />
    </svg>
    <p className="forecast-chart-error-message">{notice.message}</p>
    {/*
     * `.panel-retry` rather than a control of this folder's own: the recourse is
     * the same act on the same page, and a second button treatment would be two
     * spellings of one thing (`structure.md` rule 7). `type="button"` is
     * explicit because inside a form a default `submit` would reload the page
     * instead of re-asking — the same reason `PanelError` states it.
     */}
    <button type="button" className="panel-retry" onClick={notice.onRetry}>
      {notice.retryLabel}
    </button>
  </div>
);
