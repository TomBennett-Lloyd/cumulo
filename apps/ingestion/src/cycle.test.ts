import { describe, expect, it } from 'vitest';

import {
  activeFleet,
  bristolId,
  cycleDeps,
  dublin,
  dublinId,
  edinburghId,
  effectsFor,
  emptyRecord,
  inactiveFleet,
  malformedDetail,
  manchesterId,
  publishedOutcome,
  siteAt,
  unprocessedOnPartial,
  unreachableDetail,
} from './cycle-test-harness';
import { cycleStartedEvent, locationOutcomeEvent, runCycle, type RunCycleDeps } from './cycle';

describe('runCycle', () => {
  it('a fully successful cycle resolves', async () => {
    const record = emptyRecord();

    const report = await runCycle(cycleDeps({ sites: activeFleet, record }));

    expect(report).toEqual({
      locations: [bristolId, dublinId, manchesterId, edinburghId].map(publishedOutcome),
      activeLocations: 4,
      published: 4,
      failed: 0,
      deferred: 0,
      skippedForDeadline: 0,
    });
    expect(record.calls).toEqual([
      ...effectsFor(bristolId),
      ...effectsFor(dublinId),
      ...effectsFor(manchesterId),
      ...effectsFor(edinburghId),
    ]);
    expect(record.entries).toEqual([
      { event: cycleStartedEvent, fleetSites: 5, activeLocations: 4, attemptedLocations: 4 },
      ...[bristolId, dublinId, manchesterId, edinburghId].map((id) => ({
        event: locationOutcomeEvent,
        ...publishedOutcome(id),
      })),
    ]);
  });

  it("a location's readings are stored before they are published", async () => {
    // The ordering ADR 0004 rests on: the table is the record, the message is a
    // trigger carrying a copy. Publishing first would announce readings the
    // forecast service could then fail to read back.
    const record = emptyRecord();
    const oneSite = [siteAt({ index: 1, location: dublin, active: true })];

    await runCycle(cycleDeps({ sites: oneSite, record }));

    expect(record.calls).toEqual([`fetch:${dublinId}`, `store:${dublinId}`, `publish:${dublinId}`]);
  });

  it('an empty active fleet resolves without calling fetch', async () => {
    // API frugality at its limit (CLAUDE.md): no active site anywhere means no
    // third-party call at all — and the cycle still says so, because a silent
    // zero-call run is indistinguishable from a run that never happened.
    const record = emptyRecord();

    const report = await runCycle(cycleDeps({ sites: inactiveFleet, record }));

    expect(report).toEqual({
      locations: [],
      activeLocations: 0,
      published: 0,
      failed: 0,
      deferred: 0,
      skippedForDeadline: 0,
    });
    expect(record.calls).toEqual([]);
    expect(record.entries).toEqual([
      { event: cycleStartedEvent, fleetSites: 5, activeLocations: 0, attemptedLocations: 0 },
    ]);
  });

  it('one rate-limited location does not stop the remaining locations from publishing', async () => {
    const record = emptyRecord();

    const report = await runCycle(
      cycleDeps({
        sites: activeFleet,
        scripts: { [bristolId]: { fetch: 'rate-limited' } },
        record,
      }),
    );

    expect(report.locations).toEqual([
      { locationId: bristolId, status: 'rate-limited' },
      ...[dublinId, manchesterId, edinburghId].map(publishedOutcome),
    ]);
    expect(report).toMatchObject({ activeLocations: 4, published: 3, failed: 1 });
    expect(record.calls).toEqual([
      `fetch:${bristolId}`,
      ...effectsFor(dublinId),
      ...effectsFor(manchesterId),
      ...effectsFor(edinburghId),
    ]);
  });

  it('rate-limited, malformed, and unreachable locations are reported as distinct outcomes', async () => {
    // The client draws these distinctions because the response to each differs —
    // back off, alert, or wait for the next cycle. Collapsing them into one
    // "fetch failed" here would throw that away at the only place it is logged.
    const record = emptyRecord();

    const report = await runCycle(
      cycleDeps({
        sites: activeFleet,
        scripts: {
          [bristolId]: { fetch: 'rate-limited' },
          [dublinId]: { fetch: 'malformed' },
          [manchesterId]: { fetch: 'unreachable' },
        },
        record,
      }),
    );

    expect(report.locations).toEqual([
      { locationId: bristolId, status: 'rate-limited' },
      { locationId: dublinId, status: 'malformed', detail: malformedDetail },
      { locationId: manchesterId, status: 'unreachable', detail: unreachableDetail },
      publishedOutcome(edinburghId),
    ]);
    expect(report).toMatchObject({ activeLocations: 4, published: 1, failed: 3 });
    expect(record.calls).toEqual([
      `fetch:${bristolId}`,
      `fetch:${dublinId}`,
      `fetch:${manchesterId}`,
      ...effectsFor(edinburghId),
    ]);
  });

  it('a partial batch write is reported and its location is not published', async () => {
    // BatchWriteItem answers 200 while handing back what it declined (ADR 0002
    // Consequence 4), so a partial store is a location whose readings are not in
    // the table — announcing them would be a message the consumer cannot honour.
    const record = emptyRecord();

    const report = await runCycle(
      cycleDeps({ sites: activeFleet, scripts: { [dublinId]: { store: 'partial' } }, record }),
    );

    expect(report.locations).toEqual([
      publishedOutcome(bristolId),
      { locationId: dublinId, status: 'store-partial', unprocessedCount: unprocessedOnPartial },
      publishedOutcome(manchesterId),
      publishedOutcome(edinburghId),
    ]);
    expect(report).toMatchObject({ activeLocations: 4, published: 3, failed: 1 });
    expect(record.calls).toContain(`store:${dublinId}`);
    expect(record.calls).not.toContain(`publish:${dublinId}`);
  });

  it('a throw from any one location fails only that location', async () => {
    // The isolation the whole per-location catch exists for: three different
    // effects blow up in three different locations, and the fourth still ships.
    const record = emptyRecord();

    const report = await runCycle(
      cycleDeps({
        sites: activeFleet,
        scripts: {
          [bristolId]: { fetch: 'throws' },
          [dublinId]: { store: 'throws' },
          [manchesterId]: { publish: 'throws' },
        },
        record,
      }),
    );

    expect(report.locations).toEqual([
      {
        locationId: bristolId,
        status: 'failed',
        detail: `fetchForecast threw — Error: fetch exploded for ${bristolId}`,
      },
      {
        locationId: dublinId,
        status: 'failed',
        detail: `putForecastWeather threw — Error: DynamoDB exploded for ${dublinId}`,
      },
      {
        locationId: manchesterId,
        status: 'failed',
        detail: `publishLocationReadings threw — Error: the queue exploded for ${manchesterId}`,
      },
      publishedOutcome(edinburghId),
    ]);
    expect(report).toMatchObject({ activeLocations: 4, published: 1, failed: 3 });
    expect(record.calls).toEqual([
      `fetch:${bristolId}`,
      `fetch:${dublinId}`,
      `store:${dublinId}`,
      `fetch:${manchesterId}`,
      `store:${manchesterId}`,
      `publish:${manchesterId}`,
      ...effectsFor(edinburghId),
    ]);
  });

  it('a fleet listing that fails is not reported as an empty cycle', async () => {
    // Rule 1: this one is not a per-location outcome. A cycle that never learned
    // what to fetch must fail the invocation, not resolve with zero locations —
    // which would look identical to a fleet with nothing active.
    const record = emptyRecord();
    const deps: RunCycleDeps = {
      ...cycleDeps({ sites: activeFleet, record }),
      sites: { listFleetSites: () => Promise.reject(new Error('cumulo-sites is unreachable')) },
    };

    await expect(runCycle(deps)).rejects.toThrow('cumulo-sites is unreachable');
    expect(record.calls).toEqual([]);
  });
});
