import { describe, expect, it } from 'vitest';

import {
  SteppingClock,
  activeFleet,
  bristolId,
  cycleDeps,
  cycleStartMs,
  dublinId,
  edinburghId,
  effectsFor,
  emptyRecord,
  manchesterId,
  productionBudget,
  publishedOutcome,
  skippedOutcome,
} from './cycle-test-harness';
import { cycleStartedEvent, locationOutcomeEvent, runCycle } from './cycle';
import { CYCLE_ROTATION_PERIOD_MS } from './locations';

/**
 * The two bounds of #115. Each is enforced in code and each reports what it
 * cost, because the failure they replace — a Lambda killed at its timeout —
 * is the one this service could not report on at all.
 *
 * Every test here asserts the whole `locations` array rather than a count. A
 * cap or a deadline that quietly shortened the report would satisfy a count
 * assertion and would be exactly the defect these bounds exist to prevent.
 */
describe('runCycle bounds', () => {
  /** `published + failed === activeLocations`, whatever became of the cycle. */
  const expectEveryLocationAccountedFor = (report: {
    locations: unknown[];
    activeLocations: number;
    published: number;
    failed: number;
  }): void => {
    expect(report.published + report.failed).toBe(report.activeLocations);
    expect(report.locations).toHaveLength(report.activeLocations);
  };

  it('the shipped budget skips nothing on a healthy fleet', () => {
    // testing.md rule 7: the tests below narrow the budget to make skipping
    // reachable, so the configuration that actually deploys needs its own
    // assertion — otherwise the suite proves a cap and deadline nobody runs.
    expect(productionBudget.maxLocations).toBeGreaterThan(activeFleet.length);
    expect(productionBudget.deadlineMs).toBeGreaterThan(0);
  });

  it('a fleet larger than the cap processes exactly the cap and reports the rest as skipped', async () => {
    const record = emptyRecord();

    const report = await runCycle(
      cycleDeps({
        sites: activeFleet,
        budget: { ...productionBudget, maxLocations: 2 },
        record,
      }),
    );

    expect(report.locations).toEqual([
      publishedOutcome(bristolId),
      publishedOutcome(dublinId),
      skippedOutcome(manchesterId, 'location-cap'),
      skippedOutcome(edinburghId, 'location-cap'),
    ]);
    expect(report).toMatchObject({
      activeLocations: 4,
      published: 2,
      failed: 2,
      skippedForCap: 2,
      skippedForDeadline: 0,
    });
    expectEveryLocationAccountedFor(report);
    // The cap is a bound on *effects*, not merely on the report: the two
    // deferred locations cost no Open-Meteo call, which is the quota it protects.
    expect(record.calls).toEqual([...effectsFor(bristolId), ...effectsFor(dublinId)]);
  });

  it('a cycle that runs past its deadline stops starting locations and reports the remainder', async () => {
    // Four locations, each reading of the clock 400 ms later, against a 1 s
    // deadline: two locations start inside it and two never do.
    const record = emptyRecord();
    const clock = new SteppingClock(400);

    const report = await runCycle(
      cycleDeps({
        sites: activeFleet,
        budget: { deadlineMs: 1_000, maxLocations: productionBudget.maxLocations },
        now: () => clock.read(),
        record,
      }),
    );

    expect(report.locations).toEqual([
      publishedOutcome(bristolId),
      publishedOutcome(dublinId),
      skippedOutcome(manchesterId, 'cycle-deadline'),
      skippedOutcome(edinburghId, 'cycle-deadline'),
    ]);
    expect(report).toMatchObject({
      activeLocations: 4,
      published: 2,
      failed: 2,
      skippedForCap: 0,
      skippedForDeadline: 2,
    });
    expectEveryLocationAccountedFor(report);
    expect(record.calls).toEqual([...effectsFor(bristolId), ...effectsFor(dublinId)]);
  });

  it('a location already started runs all three effects even though the deadline passes mid-location', async () => {
    // The property `cycle-budget.ts` reserves LOCATION_WORST_MS for: the check
    // happens between locations, so the one in flight is never abandoned
    // half-stored — which would publish nothing and leave readings unaccounted.
    const record = emptyRecord();
    const clock = new SteppingClock(400);

    const report = await runCycle(
      cycleDeps({
        sites: activeFleet,
        budget: { deadlineMs: 500, maxLocations: productionBudget.maxLocations },
        now: () => clock.read(),
        record,
      }),
    );

    expect(record.calls).toEqual(effectsFor(bristolId));
    expect(report).toMatchObject({ activeLocations: 4, published: 1, failed: 3 });
    expectEveryLocationAccountedFor(report);
  });

  it('every location is still logged when the deadline cuts the cycle short', async () => {
    // The whole point of the deadline over a Lambda timeout: the account
    // survives. A killed invocation logs neither the skips nor the summary.
    const record = emptyRecord();
    const clock = new SteppingClock(400);

    await runCycle(
      cycleDeps({
        sites: activeFleet,
        budget: { deadlineMs: 1_000, maxLocations: productionBudget.maxLocations },
        now: () => clock.read(),
        record,
      }),
    );

    expect(record.entries).toEqual([
      { event: cycleStartedEvent, fleetSites: 5, activeLocations: 4, attemptedLocations: 4 },
      { event: locationOutcomeEvent, ...publishedOutcome(bristolId) },
      { event: locationOutcomeEvent, ...publishedOutcome(dublinId) },
      { event: locationOutcomeEvent, ...skippedOutcome(manchesterId, 'cycle-deadline') },
      { event: locationOutcomeEvent, ...skippedOutcome(edinburghId, 'cycle-deadline') },
    ]);
  });

  it('rotation moves the capped window on by one location each hour', async () => {
    // Without this, an ascending-id cap starves the same tail forever — and
    // since locationId sorts by latitude, that tail is a geographic band.
    const windowAtHour = async (hoursFromStart: number): Promise<string[]> => {
      const record = emptyRecord();
      const startedAt = cycleStartMs + hoursFromStart * CYCLE_ROTATION_PERIOD_MS;

      const report = await runCycle(
        cycleDeps({
          sites: activeFleet,
          budget: { ...productionBudget, maxLocations: 2 },
          now: () => startedAt,
          record,
        }),
      );

      return report.locations
        .filter((outcome) => outcome.status === 'published')
        .map((outcome) => outcome.locationId);
    };

    expect(await windowAtHour(0)).toEqual([bristolId, dublinId]);
    expect(await windowAtHour(1)).toEqual([dublinId, manchesterId]);
    expect(await windowAtHour(2)).toEqual([manchesterId, edinburghId]);
    // Wraps, so the fourth hour serves the location the first hour skipped last.
    expect(await windowAtHour(3)).toEqual([edinburghId, bristolId]);
    expect(await windowAtHour(4)).toEqual([bristolId, dublinId]);
  });

  it('the accounting invariant survives skips mixed with real failures', async () => {
    const record = emptyRecord();

    const report = await runCycle(
      cycleDeps({
        sites: activeFleet,
        scripts: { [bristolId]: { fetch: 'rate-limited' } },
        budget: { ...productionBudget, maxLocations: 3 },
        record,
      }),
    );

    expect(report).toMatchObject({
      activeLocations: 4,
      published: 2,
      failed: 2,
      skippedForCap: 1,
      skippedForDeadline: 0,
    });
    expectEveryLocationAccountedFor(report);
  });
});
