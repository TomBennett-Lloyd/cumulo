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
 * the sites ledgered under it — every one of them a line, none of them
 * structural. OpenFreeMap being donation-funded and SLA-free is precisely why
 * that swap is kept cheap.
 *
 * Restatement ledger (`architecture.md` rule 9). A provider swap has to move
 * all of the following, none of which can import its way out of holding a
 * literal. The origin this constant declares:
 *
 * - `basemap.test.ts:6,10` — asserts both full style URLs. An expectation built
 *   from the constant would assert nothing, so it spells them out; that is the
 *   asserting carrier rule 9 ledgers rather than forbids.
 * - `apps/web/e2e/hermetic-basemap.ts` — the Playwright route glob, a pattern
 *   matched against outgoing requests rather than a URL built from a constant.
 *   Miss it and the browser lane stops stubbing anything, silently fetching the
 *   live third-party style on every CI run instead of failing.
 *
 * And the provider's *identity*, a separate obligation from its origin that the
 * same swap moves:
 *
 * - `MapAttributionStrip.tsx` (the visible credit link and its href) and
 *   `MapAttributionStrip.test.tsx` (the assertion on that href). Crediting a
 *   provider whose tiles are no longer being served is a licence failure, not a
 *   stale string.
 * - `header/AboutDialog.tsx` (and `header/AboutDialog.test.tsx`) — the same
 *   credit again, in the About dialog's data-sources block, which names every
 *   source the app draws on in one place. A second carrier rather than a shared
 *   component because the strip states an obligation the map owes while it is on
 *   screen and this states what the product is built on; they are free to be
 *   worded differently and only the provider's identity has to agree.
 * - `README.md`'s data-sources credit — the same obligation in prose, carrying
 *   the ODbL link that the tile data's licence requires.
 *
 * Deliberately not a member: `docs/design/map-treatment.md` names OpenFreeMap
 * among the candidates #17 was to choose between. It reasons about that decision
 * rather than asserting today's provider, so a swap leaves it true as written.
 */
const OPENFREEMAP_STYLES = 'https://tiles.openfreemap.org/styles';

/** The OpenFreeMap style URL for a theme, ready to hand to `map.setStyle`. */
export const basemapStyleUrl = (theme: Theme): string =>
  theme === 'dark' ? `${OPENFREEMAP_STYLES}/dark` : `${OPENFREEMAP_STYLES}/positron`;
