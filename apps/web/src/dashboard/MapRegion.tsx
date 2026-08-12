import type { Site } from '@cumulo/shared';
import type { ReactElement } from 'react';

import { MapControls } from '../map/MapControls';
import type { MapPosition } from '../map/MapView';
import { MapView } from '../map/MapView';
import { SelectionCamera } from '../map/SelectionCamera';
import { SiteMarkers } from '../map/SiteMarkers';
import { SitePopover } from '../map/SitePopover';
import type { Theme } from '../theme';
import type { ForecastViewState } from './forecast-view-state';
import type { SelectionOrigin } from './selection-origin';

export interface MapRegionProps {
  readonly theme: Theme;
  readonly sites: readonly Site[];
  readonly selectedSiteId: Site['id'] | null;
  readonly onSelectSite: (siteId: Site['id']) => void;
  /**
   * A click on the basemap itself — where a new site would go. Markers handle
   * their own.
   *
   * Reported whether or not add-site mode is armed: whether a click *means*
   * anything is the dashboard's question, and a region that filtered on its own
   * would put the same rule in two places.
   */
  readonly onMapClick: (position: MapPosition) => void;
  /** Whether the next basemap click drops a draft — drawn on the toggle and on the cursor. */
  readonly addSiteArmed: boolean;
  readonly onToggleAddSite: () => void;
  /**
   * The selected site itself, not just its id.
   *
   * Distinct from `selectedSiteId` on purpose. The markers only need to know
   * *which* id is selected, and they are drawn from `sites` anyway; the card and
   * the camera need the site's coordinates and its name, and resolving the id
   * against `sites` a second time down here would be a second lookup free to
   * disagree with the dashboard's. It is `null` both when nothing is selected
   * and when the selection names a site the listing never produced.
   */
  readonly selectedSite: Site | null;
  /**
   * Whether a reader asked for the selection, or the address bar did — which
   * decides whether the card owes a hand-back on close.
   */
  readonly selectionOrigin: SelectionOrigin;
  /** The dashboard's first-forecast poll for the selected site. */
  readonly firstForecast: ForecastViewState;
  readonly onRetryFirstForecast: () => void;
  /** Clears the selection: the card's close button, and Escape inside it. */
  readonly onDeselectSite: () => void;
}

/**
 * The dashboard's map half, as a type rather than a fixed component.
 *
 * This exists so the dashboard can be rendered without WebGL. jsdom implements
 * none of it, so a `MapView` mounted in a test throws before any of the wiring
 * this chunk is about — selection, click-to-add, the pending forecast — has run.
 * The two usual escapes are both worse than a seam: mocking maplibre leaves the
 * suite asserting that a mock was called (`testing.md` rule 3), and leaving the
 * dashboard untested leaves its whole reason for existing unproven.
 *
 * So the map arrives as a component, `MapRegion` in the app and a plain stand-in
 * that can fire `onMapClick`/`onSelectSite` in the tests. The seam is drawn here
 * rather than deeper because this is the exact line WebGL starts at: everything
 * above it is the dashboard's own logic, everything below it is adapter code
 * already excluded from unit testing for the same reason. What the seam does not
 * cover — that the real map calls these callbacks at all — is covered where it
 * has to be: the browser lane (`testing.md` rule 10), in
 * `apps/web/e2e/map-regressions.spec.ts`.
 *
 * The seam moved *up* the page in #265 without moving in the code. A selected
 * site's card used to be the dashboard's own markup, under the map; it is drawn
 * on the map now, so the props below carry the selection's whole story rather
 * than only its id. The half of that card with decisions in it is still
 * substitutable: the stand-in in `dashboard-test-fixture.tsx` renders the very
 * same `SitePopoverCard`, and only the maplibre anchoring around it is replaced.
 */
export type MapRegionComponent = (props: MapRegionProps) => ReactElement;

/**
 * The map as the app runs it: the basemap, the fleet drawn on top of it, and
 * whichever site the reader is asking about.
 *
 * A component of its own rather than JSX inline in `Dashboard`, because it is
 * the thing being substituted — naming it is what makes the substitution one
 * prop instead of a conditional inside the dashboard.
 *
 * Child order is paint order, and each position below is a decision:
 *
 * - **Markers first.** They are the map's data layer and everything else is
 *   drawn about them.
 * - **The camera next**, which paints nothing at all — it moves the map when a
 *   selection arrives from off screen.
 * - **The card after the markers**, because both are maplibre markers appended
 *   to the same overlay container, so the later mount wins the pixels they
 *   share. A card the fleet's own markers could bury would be a card the reader
 *   cannot read exactly where the fleet is dense.
 * - **The controls last**, so the group paints over any *marker* that drifts
 *   under the top-right corner: a reset button a cluster could bury would be
 *   unreachable exactly when the reader most wants it. Document order is the
 *   whole of what that position buys, though, and it does not reach the card —
 *   which carries a `z-index` of its own and so beats tree order outright,
 *   wherever it is mounted. The controls answer that with a value rather than a
 *   position (`map/map.css`); this bullet is about the markers.
 *
 * `key={selectedSite.id}` on the card is not cosmetic. The card captures the
 * element that held focus when it opened and hands focus back to it when it
 * closes, so moving from one site to another has to be a *remount* — otherwise
 * the second site's card would still be holding the first site's opener.
 */
export const MapRegion = ({
  theme,
  sites,
  selectedSiteId,
  onSelectSite,
  onMapClick,
  addSiteArmed,
  onToggleAddSite,
  selectedSite,
  selectionOrigin,
  firstForecast,
  onRetryFirstForecast,
  onDeselectSite,
}: MapRegionProps): ReactElement => (
  <MapView theme={theme} onMapClick={onMapClick} addSiteArmed={addSiteArmed}>
    <SiteMarkers sites={sites} selectedSiteId={selectedSiteId} onSelectSite={onSelectSite} />
    <SelectionCamera site={selectedSite} />
    {selectedSite !== null && (
      <SitePopover
        key={selectedSite.id}
        site={selectedSite}
        selectionOrigin={selectionOrigin}
        firstForecast={firstForecast}
        onRetryFirstForecast={onRetryFirstForecast}
        onClose={onDeselectSite}
      />
    )}
    <MapControls armed={addSiteArmed} onToggleArmed={onToggleAddSite} />
  </MapView>
);
