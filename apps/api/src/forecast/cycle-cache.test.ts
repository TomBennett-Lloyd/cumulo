import { describe, expect, it } from 'vitest';

import { jsonBodyOf } from '../api-fixtures';
import type { ApiResponse } from '../http/response';

import {
  STALE_RETRY_SECONDS,
  cachedForCycle,
  cycleOfIssue,
  cycleOfReading,
  dataCycleAt,
  datedByData,
  notModifiedResponse,
  revalidatesCycle,
  uncacheable,
} from './cycle-cache';

const at = (iso: string): number => Date.parse(iso) / 1000;

/** Minute 7 of the schedule plus the settle margin: the cycle boundary. */
const BOUNDARY = at('2026-10-07T12:15:00Z');

const ok: ApiResponse = {
  statusCode: 200,
  headers: { 'content-type': 'application/json' },
  body: '{"points":[1]}',
};

describe('dataCycleAt', () => {
  it('opens a cycle at HH:15 — the :07 schedule plus its settle margin — and lives it whole', () => {
    const cycle = dataCycleAt(BOUNDARY);

    expect(cycle.startEpochSeconds).toBe(BOUNDARY);
    expect(cycle.secondsToNext).toBe(3600);
  });

  it('1 s before the boundary is the previous cycle with 1 s left', () => {
    const cycle = dataCycleAt(BOUNDARY - 1);

    expect(cycle.startEpochSeconds).toBe(BOUNDARY - 3600);
    expect(cycle.secondsToNext).toBe(1);
  });

  it('mid-cycle counts down to the next boundary', () => {
    const cycle = dataCycleAt(at('2026-10-07T12:59:59Z'));

    expect(cycle.startEpochSeconds).toBe(BOUNDARY);
    expect(cycle.secondsToNext).toBe(at('2026-10-07T13:15:00Z') - at('2026-10-07T12:59:59Z'));
  });

  it('gives each cycle its own weak tag, and every instant inside one the same tag', () => {
    expect(dataCycleAt(BOUNDARY).etag).toBe(`W/"cycle-${String(BOUNDARY)}"`);
    expect(dataCycleAt(BOUNDARY + 3599).etag).toBe(dataCycleAt(BOUNDARY).etag);
    expect(dataCycleAt(BOUNDARY - 1).etag).not.toBe(dataCycleAt(BOUNDARY).etag);
  });
});

describe('revalidatesCycle', () => {
  const cycle = dataCycleAt(BOUNDARY);

  it('matches this cycle’s tag, weak or strong, alone or in a list', () => {
    expect(revalidatesCycle(cycle.etag, cycle)).toBe(true);
    expect(revalidatesCycle(`"cycle-${String(BOUNDARY)}"`, cycle)).toBe(true);
    expect(revalidatesCycle(`"other", ${cycle.etag}`, cycle)).toBe(true);
  });

  it('refuses the previous cycle’s tag, a wildcard, and no header at all', () => {
    expect(revalidatesCycle(dataCycleAt(BOUNDARY - 1).etag, cycle)).toBe(false);
    expect(revalidatesCycle('*', cycle)).toBe(false);
    expect(revalidatesCycle(undefined, cycle)).toBe(false);
    expect(revalidatesCycle('', cycle)).toBe(false);
  });
});

describe('the cycle headers', () => {
  const cycle = dataCycleAt(at('2026-10-07T12:20:00Z'));
  const expectedHeaders = {
    'cache-control': 'public, max-age=3300',
    etag: cycle.etag,
    vary: 'origin',
  };

  it('marks a 200 cacheable until the next boundary, body untouched', () => {
    const cached = cachedForCycle(ok, cycle);

    expect(cached.headers).toEqual({ 'content-type': 'application/json', ...expectedHeaders });
    expect(jsonBodyOf(cached)).toEqual({ points: [1] });
  });

  it('answers a 304 with the same freshness and validator, and no body', () => {
    const response = notModifiedResponse(cycle);

    expect(response).toEqual({ statusCode: 304, headers: expectedHeaders });
  });

  it('leaves a no-store answer and every non-200 alone', () => {
    const empty = uncacheable(ok);
    const missing: ApiResponse = { statusCode: 404, headers: {}, body: '{}' };

    expect(cachedForCycle(empty, cycle).headers).toEqual({
      'content-type': 'application/json',
      'cache-control': 'no-store',
    });
    expect(cachedForCycle(missing, cycle)).toEqual(missing);
  });
});

describe('the cycle a body’s data settled into', () => {
  it('dates a forecast to the run fired at or before its issue, however late the pass', () => {
    // The consumer stamps `issuedAt` with its own clock, so a pass of the 12:07
    // run can land long after 12:15 and still belongs to the 12:15 cycle.
    expect(cycleOfIssue('2026-10-07T12:07:00Z')).toBe(BOUNDARY);
    expect(cycleOfIssue('2026-10-07T12:40:00Z')).toBe(BOUNDARY);
    expect(cycleOfIssue('2026-10-07T12:06:59Z')).toBe(BOUNDARY - 3600);
  });

  it('dates a reading to the first run at or after its hour', () => {
    expect(cycleOfReading('2026-10-07T12:00:00Z')).toBe(BOUNDARY);
    expect(cycleOfReading('2026-10-07T11:00:00Z')).toBe(BOUNDARY - 3600);
  });

  it('takes the newest of everything a body holds, and leaves an undatable body undated', () => {
    const dated = datedByData(ok, ['2026-10-07T11:09:00Z'], ['2026-10-07T12:00:00Z']);

    expect(dated.dataCycleStart).toBe(BOUNDARY);
    expect(datedByData(ok, [], [])).not.toHaveProperty('dataCycleStart');
  });
});

describe('a body older than its cycle', () => {
  const cycle = dataCycleAt(at('2026-10-07T12:20:00Z'));
  const stale = { ...ok, dataCycleStart: BOUNDARY - 3600 };

  it('is kept briefly under its own cycle’s tag, so a revalidation is read again', () => {
    const cached = cachedForCycle(stale, cycle);

    expect(cached.headers).toEqual({
      'content-type': 'application/json',
      'cache-control': `public, max-age=${String(STALE_RETRY_SECONDS)}`,
      etag: dataCycleAt(BOUNDARY - 1).etag,
      vary: 'origin',
    });
    expect(revalidatesCycle(cached.headers.etag, cycle)).toBe(false);
    expect(cached).not.toHaveProperty('dataCycleStart');
  });

  it('is not what this cycle’s own data gets', () => {
    expect(
      cachedForCycle({ ...ok, dataCycleStart: BOUNDARY }, cycle).headers['cache-control'],
    ).toBe('public, max-age=3300');
  });

  it('still never caches an empty answer', () => {
    expect(cachedForCycle(uncacheable(stale), cycle).headers['cache-control']).toBe('no-store');
  });
});
