import type { MapLibreMap } from 'maplibre-gl';
import { createContext } from 'react';

/**
 * The live maplibre map instance, for the overlay components that need to speak
 * to it directly — markers positioning themselves, a cluster asking the camera
 * to fly somewhere.
 *
 * `null` is the honest default and not a placeholder: the instance only exists
 * after `MapView`'s mount effect has run, so every consumer has to handle the
 * frame before it appears. Passing the map down this way rather than through
 * props keeps the overlay components composable as `MapView` children.
 */
export const MapContext = createContext<MapLibreMap | null>(null);
