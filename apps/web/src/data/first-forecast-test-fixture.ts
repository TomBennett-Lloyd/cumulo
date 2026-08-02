import {
  forecastSchema,
  type CreateSiteInput,
  type Forecast,
  type GenerationReading,
  type Site,
} from '@cumulo/shared';
import { act } from '@testing-library/react';
import { vi } from 'vitest';

import type {
  FleetSourceResult,
  FleetDataSource,
  FleetSourceCapabilities,
} from './fleet-data-source';

/**
 * The shared way of driving `useFirstForecast` against a scripted fleet.
 *
 * The hook's suite outgrew one file (`structure.md` rule 4), and what it needed
 * split out was not a slice of the assertions but the machinery underneath all
 * of them: one stub source, the answers it can be scripted with, and the two
 * ways of letting the fake clock and React catch up. Those live here rather
 * than in copies that would have to change together to keep meaning the same
 * thing (`structure.md` rule 7); the behaviours themselves stay in
 * `use-first-forecast.test.tsx`. Precedent and house style:
 * `apps/web/src/dashboard/dashboard-test-fixture.tsx`.
 *
 * Nothing here is a mock of the transport. `FleetDataSource` is the seam the
 * hook is written against, and {@link ScriptedFleetDataSource} is a second real
 * implementation of it — which is why its unused fleet-wide reads throw rather
 * than answer politely.
 */

/** The site every scripted watch is about — the id {@link ScriptedFleetDataSource} hands back. */
export const SITE_ID = '3c3d3e3f-0000-4000-8000-000000000001';

/** What the stub knows when it answers one poll. */
interface PollContext {
  /** Simulated milliseconds since the source was constructed. */
  readonly elapsedMs: number;
  /** 0 for the first forecast poll, 1 for the second, and so on. */
  readonly callIndex: number;
}

export type ForecastAnswer = (
  context: PollContext,
) => Promise<FleetSourceResult<readonly Forecast[]>>;

export type ForecastResolver = (result: FleetSourceResult<readonly Forecast[]>) => void;

/** One forecast row, the shape `forecastReady` hands the hook. */
const oneForecast = (siteId: string): readonly Forecast[] => [
  forecastSchema.parse({
    siteId,
    model: 'physics',
    validTime: '2026-07-31T10:00:00Z',
    issuedAt: '2026-07-31T09:00:00Z',
    weatherSource: 'open-meteo',
    poaIrradianceWm2: 620,
    acPowerKw: 3.1,
  }),
];

export const forecastReady = (siteId: string): FleetSourceResult<readonly Forecast[]> => ({
  kind: 'ok',
  value: oneForecast(siteId),
});

export const notFound = (siteId: string): FleetSourceResult<never> => ({
  kind: 'error',
  error: { code: 'not-found', message: `No forecast for site ${siteId} yet` },
});

export const rateLimited = (retryAfterSeconds: number): FleetSourceResult<never> => ({
  kind: 'error',
  error: {
    code: 'rate-limited',
    message: 'The fleet is rate-limiting forecast reads',
    retryAfterSeconds,
  },
});

export const networkDown = (): FleetSourceResult<never> => ({
  kind: 'error',
  error: { code: 'network', message: 'The fleet did not answer' },
});

/** The demo pipeline's shape: nothing until it finishes, then the series. */
export const forecastAfterMs =
  (availableAfterMs: number, siteId: string): ForecastAnswer =>
  (context) =>
    Promise.resolve(
      context.elapsedMs >= availableAfterMs ? forecastReady(siteId) : notFound(siteId),
    );

export const alwaysAnswering =
  (answer: FleetSourceResult<readonly Forecast[]>): ForecastAnswer =>
  () =>
    Promise.resolve(answer);

/** Rate-limited once, then the ordinary wait — the backoff is what the test measures. */
export const rateLimitedFirst =
  (retryAfterSeconds: number, siteId: string): ForecastAnswer =>
  (context) =>
    Promise.resolve(context.callIndex === 0 ? rateLimited(retryAfterSeconds) : notFound(siteId));

/**
 * Answers nothing on its own: each call parks its resolver in the array the
 * test owns and passed in, so the test decides when — and whether — a poll that
 * is already in flight ever comes back.
 */
export const deferredAnswer =
  (resolvers: ForecastResolver[]): ForecastAnswer =>
  () =>
    new Promise<FleetSourceResult<readonly Forecast[]>>((resolve) => {
      resolvers.push(resolve);
    });

export const answerCall = (
  resolvers: readonly ForecastResolver[],
  index: number,
  result: FleetSourceResult<readonly Forecast[]>,
): void => {
  const resolve = resolvers[index];
  if (resolve === undefined) {
    throw new Error(`The hook has not made forecast call ${String(index)}`);
  }
  resolve(result);
};

/**
 * A `FleetDataSource` that records every call it receives and answers forecast
 * polls from an injected policy.
 *
 * The call log is the point: this chunk's headline constraint is *which*
 * partition the loop reads (ADR 0002's review), and a log of exact call
 * arguments is the only way to prove a fleet fan-out never happened. Hence a
 * class rather than three loose spies — the log and the answer policy are
 * shared state (`structure.md` rule 2).
 */
export class ScriptedFleetDataSource implements FleetDataSource {
  // Both false, matching the fleet-level members below: this stub throws on every fleet-wide read,
  // so claiming either capability would describe a source it refuses to be.
  readonly capabilities: FleetSourceCapabilities = { fleetLookback: false, fleetActuals: false };

  /** Every call, in order: `listSites`, `createSite:<name>` or `getSiteForecast:<siteId>`. */
  readonly calls: string[] = [];
  private readonly answer: ForecastAnswer;
  private readonly startedAtMs = Date.now();
  private forecastCalls = 0;

  constructor(answer: ForecastAnswer) {
    this.answer = answer;
  }

  readonly listSites = (): Promise<FleetSourceResult<readonly Site[]>> => {
    this.calls.push('listSites');
    return Promise.resolve({ kind: 'ok', value: [] });
  };

  readonly createSite = (input: CreateSiteInput): Promise<FleetSourceResult<Site>> => {
    this.calls.push(`createSite:${input.name}`);
    return Promise.resolve({ kind: 'ok', value: { id: SITE_ID, ...input } });
  };

  readonly getSiteForecast = (
    siteId: Site['id'],
  ): Promise<FleetSourceResult<readonly Forecast[]>> => {
    this.calls.push(`getSiteForecast:${siteId}`);
    const callIndex = this.forecastCalls;
    this.forecastCalls += 1;
    return this.answer({ elapsedMs: Date.now() - this.startedAtMs, callIndex });
  };

  /*
   * The window-scoped reads are the chart views' surface, not the poll's. They
   * throw rather than answer: this suite exists to prove *which* reads the loop
   * makes, and a stub that quietly served a fleet-wide window would let the one
   * failure it guards against pass unnoticed.
   */
  readonly siteForecasts = (): Promise<FleetSourceResult<readonly Forecast[]>> => {
    throw new Error('ScriptedFleetDataSource: the forecast poll must not call siteForecasts');
  };

  readonly siteActuals = (): Promise<FleetSourceResult<readonly GenerationReading[]>> => {
    throw new Error('ScriptedFleetDataSource: the forecast poll must not call siteActuals');
  };

  readonly fleetForecasts = (): Promise<FleetSourceResult<readonly Forecast[]>> => {
    throw new Error('ScriptedFleetDataSource: the forecast poll must not fan out over the fleet');
  };

  readonly fleetActuals = (): Promise<FleetSourceResult<readonly GenerationReading[]>> => {
    throw new Error('ScriptedFleetDataSource: the forecast poll must not fan out over the fleet');
  };
}

/** Move the simulated clock and let React commit whatever that produced. */
export const advanceBy = async (ms: number): Promise<void> => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

/** Let already-resolved promises settle without moving the clock. */
export const settle = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve();
  });
};
