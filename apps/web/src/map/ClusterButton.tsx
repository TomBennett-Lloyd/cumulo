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

  return (
    <button
      type="button"
      className={classNames.join(' ')}
      aria-label={`Cluster of ${String(count)} sites`}
      onClick={onActivate}
    >
      {count}
    </button>
  );
};
