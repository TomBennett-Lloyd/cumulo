// @vitest-environment jsdom

import { cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  advanceBy,
  deferredAnswer,
  ScriptedFleetDataSource,
  SITE_ID,
  type ForecastResolver,
} from './first-forecast-test-fixture';
import { useFirstForecast } from './use-first-forecast';

/**
 * The deadline's third outcome, split out from `use-first-forecast.test.tsx`.
 *
 * The parent suite is close enough to the 300-line ceiling
 * (`structure.md` rule 4) that this addition does not fit beside its siblings,
 * so the file is cut where the subject already divides: everything the parent
 * asserts is about a run the fleet answered, and this is the one about a run it
 * never did. Precedent for splitting a suite by subject rather than by size
 * alone: `packages/storage/src/client-retry-classification.test.ts`. The
 * machinery is the shared fixture both files import, so the split costs no
 * duplication.
 */

/** The instant every fake-timer test starts from, so elapsed time is readable. */
const START_MS = Date.UTC(2026, 6, 31, 9, 0, 0);

describe('useFirstForecast at a deadline nothing answered', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(START_MS);
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  /*
   * The edge the tech-debt entry named: a run whose every request is still in
   * flight at ninety seconds has established nothing about whether a forecast
   * exists — and `apps/web` has no `AbortSignal` anywhere, so a hung fetch is a
   * shape the app can really reach. Reporting that as a timeout would tell the
   * visitor the pipeline is behind on a site whose forecast may already exist.
   *
   * Its counterpart is the parent suite's `gives up at the 90-second deadline
   * as a timeout…`, which drives the same deadline through
   * `alwaysAnswering(notFound(…))` — the fleet confirming absence. The two
   * together are the fork: same ninety seconds, different evidence, different
   * reason.
   */
  it('a deadline reached with every poll unanswered reports unanswered, not a pipeline timeout', async () => {
    // Nothing in `resolvers` is ever called: the first poll's promise is still
    // pending when the deadline fires, which is exactly the run under test.
    const resolvers: ForecastResolver[] = [];
    const source = new ScriptedFleetDataSource(deferredAnswer(resolvers));
    const watch = renderHook(() => useFirstForecast(source, SITE_ID));

    await advanceBy(90_000);

    const failed = watch.result.current.state;
    expect(failed.status).toBe('failed');
    expect(failed.status === 'failed' && failed.reason).toBe('unanswered');
    // The site is named for the same reason the timeout arm names it: a
    // screenshot of the failed panel has to be diagnosable on its own.
    expect(failed.status === 'failed' && failed.message).toContain(SITE_ID);
    // Without this the test could pass on a run that never issued a poll at
    // all, which is a different bug wearing the same state.
    expect(source.calls).toEqual([`getSiteForecast:${SITE_ID}`]);
  });
});
