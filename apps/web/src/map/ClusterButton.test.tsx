// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ClusterSizeBand } from './clustering';
import { ClusterButton } from './ClusterButton';

afterEach(cleanup);

/** See `MarkerButton.test.tsx` — jsdom performs no activation behaviour of its own. */
const pressKey = (element: HTMLElement, key: string): void => {
  const notCancelled = fireEvent.keyDown(element, { key });

  if (notCancelled && element instanceof HTMLButtonElement) {
    fireEvent.click(element);
  }
};

describe('ClusterButton', () => {
  it('names itself by how many sites it holds', () => {
    render(
      <ClusterButton count={5} sizeBand="small" containsSelected={false} onActivate={vi.fn()} />,
    );

    expect(screen.getByRole('button', { name: 'Cluster of 5 sites' }).textContent).toBe('5');
  });

  it('renders a focusable button', () => {
    render(
      <ClusterButton count={5} sizeBand="small" containsSelected={false} onActivate={vi.fn()} />,
    );

    const cluster = screen.getByRole('button');

    cluster.focus();

    expect(document.activeElement).toBe(cluster);
  });

  it.each(['Enter', ' '])('expands when activated with %s', (key) => {
    const onActivate = vi.fn();

    render(
      <ClusterButton count={5} sizeBand="small" containsSelected={false} onActivate={onActivate} />,
    );
    pressKey(screen.getByRole('button'), key);

    expect(onActivate).toHaveBeenCalledTimes(1);
  });

  it('expands when clicked', () => {
    const onActivate = vi.fn();

    render(
      <ClusterButton count={5} sizeBand="small" containsSelected={false} onActivate={onActivate} />,
    );
    fireEvent.click(screen.getByRole('button'));

    expect(onActivate).toHaveBeenCalledTimes(1);
  });

  it.each<ClusterSizeBand>(['small', 'medium', 'large'])('wears the %s band class', (sizeBand) => {
    render(
      <ClusterButton
        count={12}
        sizeBand={sizeBand}
        containsSelected={false}
        onActivate={vi.fn()}
      />,
    );

    expect(screen.getByRole('button').className).toContain(`map-cluster-marker-${sizeBand}`);
  });

  it('wears the selected treatment when it holds the selected site', () => {
    render(<ClusterButton count={5} sizeBand="small" containsSelected onActivate={vi.fn()} />);

    expect(screen.getByRole('button').className).toContain('map-cluster-marker-selected');
  });

  it('wears no selected treatment otherwise', () => {
    render(
      <ClusterButton count={5} sizeBand="small" containsSelected={false} onActivate={vi.fn()} />,
    );

    expect(screen.getByRole('button').className).not.toContain('map-cluster-marker-selected');
  });
});
