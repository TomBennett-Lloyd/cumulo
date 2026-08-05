import type { Site } from '@cumulo/shared';
import type { ReactElement } from 'react';

import type { MapPosition } from '../map/MapView';
import { MapView } from '../map/MapView';
import { SiteMarkers } from '../map/SiteMarkers';
import type { Theme } from '../theme';

export interface MapRegionProps {
  readonly theme: Theme;
  readonly sites: readonly Site[];
  readonly selectedSiteId: Site['id'] | null;
  readonly onSelectSite: (siteId: Site['id']) => void;
  /** A click on the basemap itself — where a new site would go. Markers handle their own. */
  readonly onMapClick: (position: MapPosition) => void;
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
 */
export type MapRegionComponent = (props: MapRegionProps) => ReactElement;

/**
 * The map as the app runs it: the basemap, and the fleet drawn on top of it.
 *
 * A component of its own rather than JSX inline in `Dashboard`, because it is
 * the thing being substituted — naming it is what makes the substitution one
 * prop instead of a conditional inside the dashboard.
 */
export const MapRegion = ({
  theme,
  sites,
  selectedSiteId,
  onSelectSite,
  onMapClick,
}: MapRegionProps): ReactElement => (
  <MapView theme={theme} onMapClick={onMapClick}>
    <SiteMarkers sites={sites} selectedSiteId={selectedSiteId} onSelectSite={onSelectSite} />
  </MapView>
);
