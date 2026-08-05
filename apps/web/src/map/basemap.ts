import type { Theme } from '../theme';

/**
 * The basemap the fleet map draws on: **MapLibre GL JS against OpenFreeMap's
 * hosted vector styles** — `positron` in light mode, `dark` in dark mode.
 *
 * `docs/design/map-treatment.md` deliberately deferred the provider choice to
 * this ticket (#17) while fixing the constraints any choice has to satisfy.
 * OpenFreeMap's two styles satisfy them directly:
 *
 * - **Near-greyscale land, water and landuse**, so the marker triad is the only
 *   saturated thing on screen — the premise the whole marker palette was
 *   validated on.
 * - **Muted labels, no coloured road shields or POI pins** competing with site
 *   markers.
 * - **Two independently designed styles, one per theme.** The dark basemap is
 *   authored dark, not the light one inverted or CSS-filtered — the treatment
 *   forbids the filtered route, and a raster basemap could not have met it
 *   (there is no way to desaturate raster tiles without exactly that filter).
 *
 * Cost and access: keyless, no account, no usage cap, $0/month, donation-funded
 * — which is what keeps it inside the repo's free-tier ceiling. Attribution is
 * "© OpenStreetMap contributors" plus the OpenFreeMap credit, rendered by
 * `MapAttributionStrip`; the tile credit and the Open-Meteo credit are separate
 * obligations and neither absorbs the other.
 *
 * Rejected: a plain OSM raster layer (its usage policy is hostile to an app
 * like this, and desaturating it needs the banned filter) and Protomaps (a
 * self-hosted PMTiles archive or an API key, for no benefit at this scale).
 * There is no ADR because reversing this is a change to the constant below plus
 * the one ledgered copy of its origin — OpenFreeMap being donation-funded and
 * SLA-free is precisely why that swap is kept small.
 *
 * Restatement ledger (`architecture.md` rule 9). One site outside this module
 * carries this URL's origin as a literal of its own, because it cannot import
 * one: `apps/web/e2e/hermetic-basemap.ts`, whose Playwright route glob is a
 * pattern matched against outgoing requests rather than a URL built from a
 * constant. Change the provider here and that glob has to change with it — miss
 * it and the browser lane stops stubbing anything, silently fetching the live
 * third-party style on every CI run instead of failing.
 */
const OPENFREEMAP_STYLES = 'https://tiles.openfreemap.org/styles';

/** The OpenFreeMap style URL for a theme, ready to hand to `map.setStyle`. */
export const basemapStyleUrl = (theme: Theme): string =>
  theme === 'dark' ? `${OPENFREEMAP_STYLES}/dark` : `${OPENFREEMAP_STYLES}/positron`;
