import type { ReactElement } from 'react';

/**
 * The Open-Meteo credit required by CC BY 4.0 (see CLAUDE.md, hard constraints).
 *
 * Every view that displays weather-derived data must render this — it is the
 * only sanctioned attribution surface, so the wording and the link stay in one
 * place and cannot drift. Presentational and zero-prop by design: nothing about
 * the credit is a caller's decision.
 *
 * `Weather data by ` sits in its own `.cumulo-attribution-prefix` span so a
 * surface whose row, as composed, cannot hold the full forms of the credits on
 * it can drop the prose and keep the bare linked name — the compact form
 * CLAUDE.md sanctions (owner-amended 2026-08-09). That makes the class a
 * contract rather than a styling hook, and it is why two things are deliberately
 * absent here: this package ships no rule for that class, and the component takes
 * no prop to choose a form. What the condition measures is the row as composed
 * and never this phrase's own length, and only the consuming surface knows its
 * row — today only `apps/web`'s map band, the one row in the app carrying a
 * second credit beside this one (`map/map.css` holds the rule and the
 * measurement; `docs/design/map-treatment.md`'s Attribution section owns the
 * reading, #356). The other four surfaces that compose this give the credit a row
 * to itself, so the row they have to hold is this phrase alone and they hold it
 * at every width — which is precisely why a one-credit row never meets the
 * condition and the band's two-credit row does.
 *
 * The link sits outside the wrapper in both forms, so the half of the constraint
 * that is non-negotiable in every state cannot be dropped by a media query.
 *
 * Styling lives in `attribution.css`, reached through `@cumulo/ui/styles.css`;
 * it is deliberately not imported here so `tsc --noEmit` stays clean.
 */
export const OpenMeteoAttribution = (): ReactElement => (
  <small className="cumulo-attribution">
    <span className="cumulo-attribution-prefix">Weather data by </span>
    <a href="https://open-meteo.com/" target="_blank" rel="noreferrer">
      Open-Meteo.com
    </a>
  </small>
);
