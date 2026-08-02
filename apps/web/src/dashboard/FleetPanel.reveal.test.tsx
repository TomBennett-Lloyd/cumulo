// @vitest-environment jsdom

import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { FleetPanel } from './FleetPanel';
import { CountingFleetSource, FULL_FLEET, panel, settle, SITES } from './fleet-panel-test-fixture';

// Vitest runs without global test hooks, so Testing Library's automatic cleanup never registers
// itself — every render has to be torn down explicitly or later queries match two panels.
afterEach(cleanup);

/**
 * When the fleet fan-out is spent, and when it is not (#178).
 *
 * Its own file rather than another describe in `FleetPanel.test.tsx`: that suite is about what a
 * visible panel says, and this one is about what an invisible one costs — every test here asserts
 * on call counts, and several never put anything on screen at all.
 *
 * `settle()` is unusable for the hidden phases: it waits for the pending label to be *absent*,
 * which is vacuously true while the panel renders no children. So hidden phases flush the
 * already-scheduled effects and microtasks instead, and assert counts — the same helper
 * `use-fleet-query.test.tsx` uses, for the same reason.
 */
const flush = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve();
  });
};

describe('FleetPanel defers its first fan-out to its first reveal', () => {
  it('mounts hidden without spending the fan-out', async () => {
    const dataSource = new CountingFleetSource(FULL_FLEET);
    render(panel(dataSource, true));

    await flush();

    expect(dataSource.forecastCallCount).toBe(0);
    expect(dataSource.actualsCallCount).toBe(0);
  });

  it('spends the fan-out once on first reveal', async () => {
    const dataSource = new CountingFleetSource(FULL_FLEET);
    const { container, rerender } = render(panel(dataSource, true));
    await flush();

    rerender(panel(dataSource, false));
    await settle();

    expect(dataSource.forecastCallCount).toBe(1);
    expect(dataSource.actualsCallCount).toBe(1);
    expect(container.querySelector('svg')).not.toBeNull();
  });

  it('keeps the aggregate across hide and re-reveal without a second spend', async () => {
    const dataSource = new CountingFleetSource(FULL_FLEET);
    const { container, rerender } = render(panel(dataSource, true));
    await flush();
    rerender(panel(dataSource, false));
    await settle();

    rerender(panel(dataSource, true));
    await flush();
    rerender(panel(dataSource, false));
    await settle();

    // The latch is monotonic, so the re-reveal is not a false→true flip and nothing refetches —
    // #161's spent-once-and-kept property, surviving the deferral (#178).
    expect(dataSource.forecastCallCount).toBe(1);
    expect(dataSource.actualsCallCount).toBe(1);
    expect(container.querySelector('svg')).not.toBeNull();
  });

  it('does not treat the pre-listing window as a reveal', async () => {
    const dataSource = new CountingFleetSource(FULL_FLEET);
    // Written as JSX rather than through `panel`, which pins the two-site fleet: the fleet being
    // empty is the whole subject here. On a `?site=` deep link the panel is briefly un-hidden with
    // the listing still in flight, and that window must not latch.
    const { rerender } = render(
      <FleetPanel dataSource={dataSource} sites={[]} hidden={false} refreshToken={0} />,
    );
    await flush();

    expect(dataSource.forecastCallCount).toBe(0);

    // The listing resolving and the URL's selection hiding the panel arrive in one commit.
    rerender(<FleetPanel dataSource={dataSource} sites={SITES} hidden refreshToken={0} />);
    await flush();

    expect(dataSource.forecastCallCount).toBe(0);
    expect(dataSource.actualsCallCount).toBe(0);

    rerender(<FleetPanel dataSource={dataSource} sites={SITES} hidden={false} refreshToken={0} />);
    await settle();

    expect(dataSource.forecastCallCount).toBe(1);
  });
});
