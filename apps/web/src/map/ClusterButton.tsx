import type { ReactElement } from 'react';
import type { ClusterSizeBand } from './clustering';

export interface ClusterButtonProps {
  readonly count: number;
  readonly sizeBand: ClusterSizeBand;
  readonly containsSelected: boolean;
  readonly onActivate: () => void;
}

/**
 * A knot of sites too close together to draw separately, drawn as one bubble
 * carrying its count.
 *
 * The count is rendered as text rather than encoded in the size alone: three
 * diameters are a coarse "more than that one", and the label is the channel
 * that actually says five. It is also why the button is not `aria-hidden`
 * decoration — "Cluster of 5 sites" is the honest name for a control that,
 * when activated, zooms until those five separate. A cluster that did nothing
 * on click would be a dead end for anyone whose sites are inside it.
 *
 * Holding the selected site is said in the name as well as drawn, for the same
 * reason `MarkerButton` announces selection: `map-treatment.md` records a
 * contrast warning on this palette in light mode and forbids colour from
 * carrying a state on its own. A cluster's only other visual channel is its
 * diameter, and that already means "how many" — so the name is what is left.
 */
export const ClusterButton = ({
  count,
  sizeBand,
  containsSelected,
  onActivate,
}: ClusterButtonProps): ReactElement => {
  const classNames = ['map-cluster-marker', `map-cluster-marker-${sizeBand}`];

  if (containsSelected) {
    classNames.push('map-cluster-marker-selected');
  }

  const label = `Cluster of ${String(count)} sites`;

  return (
    <button
      type="button"
      className={classNames.join(' ')}
      aria-label={containsSelected ? `${label}, including the selected site` : label}
      aria-current={containsSelected ? true : undefined}
      onClick={onActivate}
    >
      {count}
    </button>
  );
};
