import type { FleetDataError, FleetSourceResult } from './fleet-data-source';
import { HttpFleetDataSource } from './http-fleet-data-source';

/**
 * Fixtures shared by `http-fleet-data-source.test.ts` — the recording transport
 * double, the wire-shaped payload builders, and the result assertions.
 *
 * Test support, in its own module for two reasons. The payload builders encode
 * one thing (what the Fleet API puts on the wire), so a change to that shape has
 * to reach every test at once; and the file that consumes them is at the
 * `max-lines` ceiling, where `structure.md` rule 4 says to cut rather than to
 * compress.
 */

export const BASE_URL = 'https://api.example.test';

/** 2026-08-01T12:00:00Z — the instant every window in these tests is measured from. */
export const NOW_MS = Date.UTC(2026, 7, 1, 12, 0, 0);

export const SITE_A = '11111111-1111-4111-8111-111111111111';
export const SITE_B = '22222222-2222-4222-8222-222222222222';

export const fleetSite = (id: string, name: string): unknown => ({
  id,
  name,
  latitude: 51.5,
  longitude: -0.12,
  tiltDegrees: 35,
  azimuthDegrees: 180,
  capacityKw: 4.2,
  origin: 'seed',
  createdAt: '2026-07-01T00:00:00Z',
  active: true,
});

export const forecastPoint = (siteId: string, acPowerKw: number): unknown => ({
  siteId,
  model: 'physics',
  validTime: '2026-08-01T13:00:00Z',
  issuedAt: '2026-08-01T12:00:00Z',
  weatherSource: 'open-meteo',
  poaIrradianceWm2: 800,
  acPowerKw,
});

export const jsonResponse = (body: unknown, status: number): Response =>
  new Response(JSON.stringify(body), { status });

export interface RecordedCall {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

/** `fetch` accepts three input shapes; the source only ever passes the first. */
const requestUrl = (input: RequestInfo | URL): string => {
  if (typeof input === 'string') {
    return input;
  }
  return input instanceof URL ? input.href : input.url;
};

/** The request body as the object it was serialised from, or a failed test. */
export const sentJson = (init: RequestInit | undefined): unknown => {
  const body = init?.body;
  if (typeof body !== 'string') {
    throw new Error(`expected a JSON string body, received ${typeof body}`);
  }
  return JSON.parse(body);
};

/**
 * A `fetch` stand-in that answers from a URL-keyed responder and records what
 * it was asked for.
 *
 * A class rather than a factory returning functions (`structure.md` rule 2):
 * the recorder and the transport share the call log, and `this.` is what says
 * so. `calls.length` is the frugality assertion these tests are built around —
 * how many requests a UI interaction costs is behaviour, not mock theatre.
 */
export class FetchRecorder {
  readonly calls: RecordedCall[] = [];
  private readonly respond: (url: string) => Response | Promise<Response>;

  constructor(respond: (url: string) => Response | Promise<Response>) {
    this.respond = respond;
  }

  readonly fetchFn: typeof fetch = (input, init) => {
    const url = requestUrl(input);
    this.calls.push({ url, init });
    return Promise.resolve(this.respond(url));
  };
}

export const sourceAnswering = (
  respond: (url: string) => Response | Promise<Response>,
  /** Defaulted, because only the clock-failure test cares what time it is twice. */
  now: () => number = () => NOW_MS,
): { source: HttpFleetDataSource; recorder: FetchRecorder } => {
  const recorder = new FetchRecorder(respond);
  return {
    recorder,
    source: new HttpFleetDataSource({
      baseUrl: BASE_URL,
      fetchFn: recorder.fetchFn,
      now,
    }),
  };
};

/** A clock that reads out `readings` in order, then settles on {@link NOW_MS}. */
export const clockReading = (readings: readonly number[]): (() => number) => {
  const remaining = [...readings];
  return () => remaining.shift() ?? NOW_MS;
};

export const expectFailure = (result: FleetSourceResult<unknown>): FleetDataError => {
  if (result.kind !== 'error') {
    throw new Error(`expected a failure result, received ${JSON.stringify(result)}`);
  }
  return result.error;
};

export const expectValue = <T>(result: FleetSourceResult<T>): T => {
  if (result.kind !== 'ok') {
    throw new Error(`expected a success result, received ${JSON.stringify(result)}`);
  }
  return result.value;
};
