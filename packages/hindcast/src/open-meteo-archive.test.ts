import type { GeoCoordinates } from '@cumulo/shared';
import { describe, expect, it } from 'vitest';

import fixture from '../fixtures/archive-response.json';
import {
  ARCHIVE_BASE_URL,
  fetchArchiveDays,
  parseArchiveResponse,
  type ArchiveFetchResult,
} from './open-meteo-archive';

/**
 * The adapter is exercised against the captured Open-Meteo archive body in
 * `fixtures/` (`docs/standards/testing.md` rule 3, and `fixtures/README.md` for
 * its provenance). Every test injects a `fetch` stub, so nothing here reaches the
 * network; what the stub proves is the *policy* — which status ends where, how
 * many requests a rate limit costs — rather than that a mock was called.
 *
 * No test overrides `timeoutMs`, so the shipped deadline is the one every case
 * runs under (`docs/standards/testing.md` rule 7).
 */
const dublin: GeoCoordinates = { latitude: 53.35, longitude: -6.26 };

const firstDay = '2026-06-01';
const lastDay = '2026-06-03';

type FetchResponder = () => Promise<Response>;

interface RecordedRequest {
  readonly url: string;
  readonly signal: AbortSignal | undefined;
}

interface FetchStub {
  readonly fetchFn: typeof fetch;
  readonly requests: readonly RecordedRequest[];
}

const requestUrl = (input: Parameters<typeof fetch>[0]): string => {
  if (typeof input === 'string') {
    return input;
  }
  return input instanceof URL ? input.href : input.url;
};

/**
 * A `fetch` that answers with `responders` in order and records what it was asked.
 * A request past the end of the list rejects loudly rather than repeating the last
 * response, so a policy that retried where it must not cannot pass by quietly
 * getting another answer.
 */
const stubFetch = (responders: readonly FetchResponder[]): FetchStub => {
  const requests: RecordedRequest[] = [];
  const fetchFn: typeof fetch = (input, init) => {
    const responder = responders[requests.length];
    requests.push({ url: requestUrl(input), signal: init?.signal ?? undefined });
    return responder === undefined
      ? Promise.reject(new Error(`unexpected request #${String(requests.length)}`))
      : responder();
  };
  return { fetchFn, requests };
};

const respondsWithJson =
  (body: unknown, status: number): FetchResponder =>
  () =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    );

const respondsWithText =
  (body: string, status: number): FetchResponder =>
  () =>
    Promise.resolve(new Response(body, { status, headers: { 'content-type': 'text/html' } }));

/** The fixture with `hours` trailing values of one variable replaced by `null`. */
const withNulledTail = (hours: number): unknown => ({
  ...fixture,
  hourly: {
    ...fixture.hourly,
    temperature_2m: fixture.hourly.temperature_2m.map((value, index) =>
      index >= fixture.hourly.temperature_2m.length - hours ? null : value,
    ),
  },
});

/** The fixture cut to its first `hours` rows — every column, so alignment holds. */
const truncatedToHours = (hours: number): unknown => ({
  ...fixture,
  hourly: Object.fromEntries(
    Object.entries(fixture.hourly).map(([column, values]) => [column, values.slice(0, hours)]),
  ),
});

const okResult = (result: ArchiveFetchResult): Extract<ArchiveFetchResult, { status: 'ok' }> => {
  if (result.status !== 'ok') {
    throw new Error(`expected an ok result, got ${result.status}`);
  }
  return result;
};

describe('fetchArchiveDays request', () => {
  it('pins the unit, timezone and variable list the domain schema depends on', async () => {
    const stub = stubFetch([respondsWithJson(fixture, 200)]);

    await fetchArchiveDays({ fetchFn: stub.fetchFn }, dublin, firstDay, lastDay);

    const [request] = stub.requests;
    expect(request).toBeDefined();
    const url = new URL(request?.url ?? '');
    expect(`${url.origin}${url.pathname}`).toBe(ARCHIVE_BASE_URL);
    // Spelled out rather than joined from ARCHIVE_HOURLY_VARIABLES: the point is
    // that the request and `weatherReadingSchema`'s fields stay in step, which an
    // assertion derived from the same constant could not notice.
    expect(url.searchParams.get('hourly')).toBe(
      'temperature_2m,wind_speed_10m,cloud_cover,shortwave_radiation,direct_radiation,diffuse_radiation,direct_normal_irradiance',
    );
    // km/h would parse cleanly as m/s and quietly feed the Faiman term a ~3.6x
    // error; this assertion is the whole defence (see buildArchiveUrl).
    expect(url.searchParams.get('wind_speed_unit')).toBe('ms');
    expect(url.searchParams.get('timezone')).toBe('UTC');
    expect(url.searchParams.get('start_date')).toBe(firstDay);
    expect(url.searchParams.get('end_date')).toBe(lastDay);
    expect(url.searchParams.get('latitude')).toBe('53.35');
    expect(url.searchParams.get('longitude')).toBe('-6.26');
  });

  it('carries the shipped request deadline', async () => {
    const stub = stubFetch([respondsWithJson(fixture, 200)]);

    await fetchArchiveDays({ fetchFn: stub.fetchFn }, dublin, firstDay, lastDay);

    const signal = stub.requests[0]?.signal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal?.aborted).toBe(false);
  });

  it('returns the parsed days on a 200', async () => {
    const stub = stubFetch([respondsWithJson(fixture, 200)]);

    const result = await fetchArchiveDays({ fetchFn: stub.fetchFn }, dublin, firstDay, lastDay);

    expect([...okResult(result).completeDays.keys()]).toEqual([
      '2026-06-01',
      '2026-06-02',
      '2026-06-03',
    ]);
    expect(okResult(result).incompleteDays).toEqual([]);
  });
});

describe('fetchArchiveDays failure policy', () => {
  it('returns rate-limited on HTTP 429 without a single retry', async () => {
    const stub = stubFetch([respondsWithJson({ error: true, reason: 'slow down' }, 429)]);

    const result = await fetchArchiveDays({ fetchFn: stub.fetchFn }, dublin, firstDay, lastDay);

    expect(result).toEqual({ status: 'rate-limited' });
    // Hot-retrying spends the exhausted quota; the next backfill run is the retry.
    expect(stub.requests).toHaveLength(1);
  });

  it("returns rejected carrying Open-Meteo's own reason on HTTP 400", async () => {
    const reason = 'Value of parameter start_date is out of allowed range';
    const stub = stubFetch([respondsWithJson({ error: true, reason }, 400)]);

    const result = await fetchArchiveDays({ fetchFn: stub.fetchFn }, dublin, firstDay, lastDay);

    expect(result).toEqual({ status: 'rejected', httpStatus: 400, reason });
    expect(stub.requests).toHaveLength(1);
  });

  it('returns rejected carrying the raw body when the rejection is not the error envelope', async () => {
    const stub = stubFetch([respondsWithText('<html>gateway down</html>', 502)]);

    const result = await fetchArchiveDays({ fetchFn: stub.fetchFn }, dublin, firstDay, lastDay);

    expect(result).toEqual({
      status: 'rejected',
      httpStatus: 502,
      reason: '<html>gateway down</html>',
    });
  });

  it('throws with the location and day range when the request cannot be made', async () => {
    const cause = new Error('getaddrinfo ENOTFOUND');
    const stub = stubFetch([(): Promise<Response> => Promise.reject(cause)]);

    await expect(
      fetchArchiveDays({ fetchFn: stub.fetchFn }, dublin, firstDay, lastDay),
    ).rejects.toThrow('Open-Meteo archive request failed for 53.35,-6.26 2026-06-01..2026-06-03');
  });

  it('throws when a 200 body is not JSON at all', async () => {
    const stub = stubFetch([respondsWithText('not json', 200)]);

    await expect(
      fetchArchiveDays({ fetchFn: stub.fetchFn }, dublin, firstDay, lastDay),
    ).rejects.toThrow('Open-Meteo archive body was not JSON');
  });
});

describe('parseArchiveResponse', () => {
  it('buckets the captured response into whole days of 24 hour-ending readings', () => {
    const { completeDays, incompleteDays } = parseArchiveResponse(fixture, dublin);

    expect(incompleteDays).toEqual([]);
    expect([...completeDays.keys()]).toEqual(['2026-06-01', '2026-06-02', '2026-06-03']);
    for (const [day, readings] of completeDays) {
      expect(readings).toHaveLength(24);
      expect(
        readings.map((reading) => reading.validTime).every((time) => time.startsWith(day)),
      ).toBe(true);
    }
  });

  it("normalizes stamps to the shared schema's fixed-width UTC form with no hour shift", () => {
    const { completeDays } = parseArchiveResponse(fixture, dublin);
    const firstDayReadings = completeDays.get('2026-06-01') ?? [];

    // Open-Meteo's raw first row is "2026-06-01T00:00"; the shipped convention
    // (ingestion #11) appends ":00Z" and shifts nothing.
    expect(fixture.hourly.time[0]).toBe('2026-06-01T00:00');
    expect(firstDayReadings[0]?.validTime).toBe('2026-06-01T00:00:00Z');
    expect(firstDayReadings.at(-1)?.validTime).toBe('2026-06-01T23:00:00Z');
    expect(firstDayReadings[0]?.kind).toBe('archive');
    expect(firstDayReadings[0]?.source).toBe('open-meteo');
    expect(firstDayReadings[0]?.temperature2mC).toBe(fixture.hourly.temperature_2m[0]);
  });

  it('carries the requested coordinates, not the grid-cell centre the response echoes', () => {
    // The fixture is a real capture, so the echo genuinely differs — without that
    // the assertion below would hold for the wrong reason.
    expect(fixture.latitude).not.toBe(dublin.latitude);
    expect(fixture.longitude).not.toBe(dublin.longitude);

    const { completeDays } = parseArchiveResponse(fixture, dublin);

    for (const readings of completeDays.values()) {
      for (const reading of readings) {
        expect(reading.latitude).toBe(dublin.latitude);
        expect(reading.longitude).toBe(dublin.longitude);
      }
    }
  });

  it('reports a day with a missing hourly value as incomplete and stores none of it', () => {
    const { completeDays, incompleteDays } = parseArchiveResponse(withNulledTail(3), dublin);

    expect(incompleteDays).toEqual(['2026-06-03']);
    expect(completeDays.has('2026-06-03')).toBe(false);
    expect([...completeDays.keys()]).toEqual(['2026-06-01', '2026-06-02']);
  });

  it('reports a day cut short by the window edge as incomplete, not as a short day', () => {
    const { completeDays, incompleteDays } = parseArchiveResponse(truncatedToHours(36), dublin);

    expect([...completeDays.keys()]).toEqual(['2026-06-01']);
    expect(incompleteDays).toEqual(['2026-06-02']);
  });

  it('throws when hourly columns are misaligned with hourly.time', () => {
    const misaligned = {
      ...fixture,
      hourly: { ...fixture.hourly, cloud_cover: fixture.hourly.cloud_cover.slice(0, 10) },
    };

    expect(() => parseArchiveResponse(misaligned, dublin)).toThrow(/different lengths/u);
  });

  it("throws when a stamp is not Open-Meteo's designator-less hour", () => {
    const restamped = {
      ...fixture,
      hourly: { ...fixture.hourly, time: fixture.hourly.time.map(() => '2026-06-01T00:00:00Z') },
    };

    expect(() => parseArchiveResponse(restamped, dublin)).toThrow(/expected YYYY-MM-DDTHH:mm/u);
  });

  it('throws on a value outside the domain bounds, which is what a changed unit looks like', () => {
    const kilometresPerHour = {
      ...fixture,
      hourly: { ...fixture.hourly, wind_speed_10m: fixture.hourly.wind_speed_10m.map(() => 500) },
    };

    expect(() => parseArchiveResponse(kilometresPerHour, dublin)).toThrow();
  });
});
