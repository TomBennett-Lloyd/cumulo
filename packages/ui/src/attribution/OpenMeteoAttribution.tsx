import type { ReactElement } from 'react';

/**
 * The Open-Meteo credit required by CC BY 4.0 (see CLAUDE.md, hard constraints).
 *
 * Every view that displays weather-derived data must render this — it is the
 * only sanctioned attribution surface, so the wording and the link stay in one
 * place and cannot drift. Presentational and zero-prop by design: nothing about
 * the credit is a caller's decision.
 *
 * Styling lives in `attribution.css`, reached through `@cumulo/ui/styles.css`;
 * it is deliberately not imported here so `tsc --noEmit` stays clean.
 */
export function OpenMeteoAttribution(): ReactElement {
  return (
    <small className="cumulo-attribution">
      Weather data by{' '}
      <a href="https://open-meteo.com/" target="_blank" rel="noreferrer">
        Open-Meteo.com
      </a>
    </small>
  );
}
