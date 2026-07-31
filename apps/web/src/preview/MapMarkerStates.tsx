import type { ReactElement } from 'react';

/**
 * The three map-marker states, per `docs/design/map-treatment.md`. Size changes
 * with state as well as colour — no state is carried by hue alone — which is
 * why each row names both the class that draws it and the token it reads.
 */

interface MarkerState {
  readonly label: string;
  readonly token: string;
  readonly className: string;
}

const MARKER_STATES: readonly MarkerState[] = [
  { label: 'Default', token: '--color-map-marker', className: 'map-marker' },
  { label: 'Hover', token: '--color-map-marker-hover', className: 'map-marker map-marker-hover' },
  {
    label: 'Selected',
    token: '--color-map-marker-selected',
    className: 'map-marker map-marker-selected',
  },
];

export const MapMarkerStates = (): ReactElement => (
  <ul className="marker-list">
    {MARKER_STATES.map((state) => (
      <li key={state.label} className="marker-item">
        <span className="marker-stage">
          <span className={state.className} aria-hidden="true" />
        </span>
        <span className="marker-label">{state.label}</span>
        <code className="token-name">{state.token}</code>
      </li>
    ))}
  </ul>
);
