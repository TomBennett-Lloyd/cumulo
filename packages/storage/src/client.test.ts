import { createServer } from 'node:http';
import type { Socket } from 'node:net';

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { ConfiguredRetryStrategy } from '@smithy/core/retry';
import { HttpRequest } from '@smithy/core/transport';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  STORAGE_CONNECTION_TIMEOUT_MS,
  STORAGE_MAX_ATTEMPTS,
  STORAGE_REQUEST_TIMEOUT_MS,
  STORAGE_RETRY_BASE_DELAY_MS,
  createStorageDocumentClient,
  createStorageRetryStrategy,
  storageRetryDelayMs,
} from './client';
import { RecordingHttpHandler, firstRequestBody } from './recording-http-handler';

const putItemBodySchema = z.object({
  TableName: z.string(),
  Item: z.record(z.string(), z.unknown()),
});

const offlineClient = (handler: RecordingHttpHandler): DynamoDBClient =>
  new DynamoDBClient({
    region: 'eu-west-1',
    credentials: { accessKeyId: 'test-access-key-id', secretAccessKey: 'test-secret-access-key' },
    requestHandler: handler,
  });

/** The single `PutItem` body that reached the wire, as marshalled attributes. */
const sentItem = (handler: RecordingHttpHandler): Record<string, unknown> =>
  putItemBodySchema.parse(firstRequestBody(handler)).Item;

const itemWithTopLevelUndefined = {
  siteId: 'site-1',
  sk: 'T#2026-07-30T14:00:00Z#FC#physics',
  powerKw: 3.2,
  uncertainty: undefined,
};

const itemWithNestedUndefined = {
  siteId: 'site-1',
  sk: 'T#2026-07-30T14:00:00Z#FC#physics',
  powerKw: 3.2,
  uncertainty: { p10: 2.1, p90: undefined },
};

describe('createStorageDocumentClient', () => {
  it('writes an explicitly-undefined attribute as an absent attribute', async () => {
    const handler = new RecordingHttpHandler();
    const client = createStorageDocumentClient({ baseClient: offlineClient(handler) });

    await client.send(
      new PutCommand({ TableName: 'cumulo-series-test', Item: itemWithTopLevelUndefined }),
    );

    expect(Object.keys(sentItem(handler)).sort()).toEqual(['powerKw', 'siteId', 'sk']);
  });

  it('writes an explicitly-undefined value nested in a map as an absent key', async () => {
    const handler = new RecordingHttpHandler();
    const client = createStorageDocumentClient({ baseClient: offlineClient(handler) });

    await client.send(
      new PutCommand({ TableName: 'cumulo-series-test', Item: itemWithNestedUndefined }),
    );

    expect(sentItem(handler).uncertainty).toEqual({ M: { p10: { N: '2.1' } } });
  });

  it('leaves attributes that are genuinely present alone', async () => {
    const handler = new RecordingHttpHandler();
    const client = createStorageDocumentClient({ baseClient: offlineClient(handler) });

    await client.send(
      new PutCommand({
        TableName: 'cumulo-series-test',
        Item: { ...itemWithTopLevelUndefined, uncertainty: 0.4 },
      }),
    );

    expect(sentItem(handler)).toEqual({
      siteId: { S: 'site-1' },
      sk: { S: 'T#2026-07-30T14:00:00Z#FC#physics' },
      powerKw: { N: '3.2' },
      uncertainty: { N: '0.4' },
    });
  });

  it('negative control: without the house rule a nested undefined fails to marshal', async () => {
    // Proves `removeUndefinedValues` is load-bearing rather than decorative.
    // The default client also shows where it is *not* load-bearing: a top-level
    // undefined attribute is dropped by lib-dynamodb regardless. That asymmetry
    // is precisely why the option is set — otherwise whether a write succeeds
    // would depend on how deeply the optional field is nested.
    const handler = new RecordingHttpHandler();
    const defaultClient = DynamoDBDocumentClient.from(offlineClient(handler));

    await expect(
      defaultClient.send(
        new PutCommand({ TableName: 'cumulo-series-test', Item: itemWithNestedUndefined }),
      ),
    ).rejects.toThrow(/removeUndefinedValues/);
    expect(handler.requests).toEqual([]);

    await defaultClient.send(
      new PutCommand({ TableName: 'cumulo-series-test', Item: itemWithTopLevelUndefined }),
    );
    expect(Object.keys(sentItem(handler)).sort()).toEqual(['powerKw', 'siteId', 'sk']);
  });

  it('pins the resolved client to two attempts with the storage retry strategy', async () => {
    // Built the way production builds it: no injected base client, so this is
    // the retry configuration adapters actually run under.
    const client = createStorageDocumentClient({ region: 'eu-west-1' });

    expect(await client.config.maxAttempts()).toBe(STORAGE_MAX_ATTEMPTS);
    expect(await client.config.retryStrategy()).toBeInstanceOf(ConfiguredRetryStrategy);
  });
});

describe('storageRetryDelayMs', () => {
  it('backs off from a 1000 ms base, doubling, with full jitter', () => {
    const nearlyOne = () => 0.999_999;

    expect(STORAGE_RETRY_BASE_DELAY_MS).toBe(1000);
    expect(storageRetryDelayMs(1, nearlyOne)).toBe(999);
    expect(storageRetryDelayMs(2, nearlyOne)).toBe(1999);
    expect(storageRetryDelayMs(3, nearlyOne)).toBe(3999);
    expect(storageRetryDelayMs(1, () => 0)).toBe(0);
  });

  it('stays inside its window with the production random source', () => {
    for (let sample = 0; sample < 200; sample += 1) {
      const delay = storageRetryDelayMs(1);
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThan(STORAGE_RETRY_BASE_DELAY_MS);
    }
  });
});

describe('createStorageRetryStrategy', () => {
  const throttled = { errorType: 'THROTTLING' } as const;

  it('allows one retry and then refuses a second', async () => {
    // The SDK layer's whole budget since #122: transport blips get one more go,
    // and throttling on a batch is the drain layer's job, not this one's.
    // Jitter forced to zero so the attempts cost no wall-clock time; the delay
    // arithmetic itself is covered above with the production random.
    const strategy = createStorageRetryStrategy(() => 0);

    const token = await strategy.acquireInitialRetryToken('test');
    const retried = await strategy.refreshRetryTokenForRetry(token, throttled);

    expect(retried.getRetryCount()).toBe(1);
    await expect(strategy.refreshRetryTokenForRetry(retried, throttled)).rejects.toThrow(
      'No retry token available',
    );
  });

  it('actually sleeps for the storage backoff before the single retry', async () => {
    // 5 % of the 1000 ms base is 50 ms. Observing that delay is what proves the
    // pinned base reaches the SDK, rather than the SDK's own 500 ms throttling
    // base — whose 5 % would be 25 ms, below the bound asserted here. Only one
    // refresh is measurable: a second now throws rather than sleeping.
    const strategy = createStorageRetryStrategy(() => 0.05);

    const token = await strategy.acquireInitialRetryToken('test');
    const startedAt = Date.now();
    await strategy.refreshRetryTokenForRetry(token, throttled);
    const elapsed = Date.now() - startedAt;

    expect(elapsed).toBeGreaterThanOrEqual(45);
  });
});

/**
 * The deadlines #115 added, asserted as **behaviour against a server that never
 * answers** rather than as configuration read back off the client.
 *
 * The distinction is the whole point of these tests. An earlier version asserted
 * `httpHandlerConfigs()` after a request to a server that replied instantly, and
 * it passed while the deadline did not work at all: in the installed
 * @smithy/node-http-handler 4.9.13, `requestTimeout` without
 * `throwOnRequestTimeout` only logs a warning and leaves the socket hanging. A
 * test that reads back the options we remember passing cannot see that
 * (`docs/standards/testing.md` rules 1 and 3) — only one that waits for the
 * deadline to bite can.
 *
 * These are the slowest tests in the package, deliberately: they are the only
 * proof of the number the ingestion Lambda's whole time budget rests on. That
 * budget's figure bounds *SDK-controlled* time; the end-to-end test below
 * measures wall clock, so it allows a named overhead on top of it — see
 * {@link WALL_CLOCK_OVERHEAD_MS}.
 */
describe('createStorageDocumentClient request deadlines', () => {
  /**
   * The worst case for one command, restated locally: two attempts at the
   * pinned deadline plus the one pinned backoff between them (#122 — a single
   * retry means a single delay, at the undoubled base). `@cumulo/ingestion`
   * derives the same figure as `STORE_SEND_WORST_MS`; this package cannot
   * import that without depending on its own consumer, so the assertion below
   * is bounded by the arithmetic rather than by a copied literal.
   */
  const commandWorstCaseMs =
    STORAGE_MAX_ATTEMPTS * STORAGE_REQUEST_TIMEOUT_MS + STORAGE_RETRY_BASE_DELAY_MS * 1;

  /**
   * Wall-clock time the model above does not price, allowed for once, by name.
   *
   * `commandWorstCaseMs` prices only what the SDK controls: the per-attempt
   * deadlines and the backoff between them. A real command also spends time
   * connecting, signing, serialising and waiting on the event loop — the terms
   * `@cumulo/ingestion`'s `cycle-budget.ts` knowingly prices at zero, and which
   * `docs/tech-debt.md` records against that budget's zero-slack identity. This
   * constant names that gap here rather than letting the assertion depend on it
   * being invisible: before #122 three jitter draws had to land near their
   * maxima together for the overhead to matter, so the exact bound passed by
   * concentration; with one draw it overran roughly one run in twenty.
   *
   * Sized between two endpoints. Above: comfortably more than any CI scheduling
   * noise. Below: well under 2,000 ms, so an extra attempt — which would add a
   * whole {@link STORAGE_REQUEST_TIMEOUT_MS} of 3,000 ms — still fails this
   * test deterministically. The attempt *count* is not left to the clock at
   * all: `connectionsSoFar()` pins it exactly, which is what makes an allowance
   * on the elapsed bound safe.
   */
  const WALL_CLOCK_OVERHEAD_MS = 500;

  interface TimedRejection {
    readonly error: unknown;
    readonly elapsedMs: number;
  }

  /**
   * A server that accepts connections and never responds — the stalled socket
   * the deadline exists for. Open sockets are tracked and destroyed on the way
   * out, because `server.close()` on its own waits for connections that never end.
   */
  const withUnresponsiveServer = async (
    runChecks: (port: number, connectionsSoFar: () => number) => Promise<void>,
  ): Promise<void> => {
    const sockets = new Set<Socket>();
    let connectionCount = 0;
    const server = createServer(() => {
      // Deliberately empty: never write, never end. That is the fixture.
    });
    server.on('connection', (socket) => {
      connectionCount += 1;
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });

    try {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        throw new Error('the local test server did not report a TCP port');
      }
      await runChecks(address.port, () => connectionCount);
    } finally {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    }
  };

  /** How long `run` took, and what it rejected with. A resolution is a test failure. */
  const timeRejection = async (run: () => Promise<unknown>): Promise<TimedRejection> => {
    const startedAt = Date.now();
    try {
      await run();
    } catch (error) {
      return { error, elapsedMs: Date.now() - startedAt };
    }
    throw new Error('expected the request to be rejected by its deadline, but it resolved');
  };

  /**
   * Runs `runChecks` with the SDK pointed at the local server and given
   * unusable credentials, then restores the environment exactly as it was.
   *
   * The variables have to stay set for the whole call, not just while the
   * client is constructed: endpoint and credential resolution are lazy and
   * happen on the first `send`. An earlier version of this helper cleared them
   * straight after construction, and the command went to **real DynamoDB** on
   * whatever ambient credentials the machine had — which is exactly the thing a
   * unit test must never do, and it announced itself as a
   * `ResourceNotFoundException` rather than the timeout being asserted.
   */
  const withLocalEndpoint = async (port: number, runChecks: () => Promise<void>): Promise<void> => {
    const overrides = {
      AWS_ENDPOINT_URL_DYNAMODB: `http://127.0.0.1:${String(port)}`,
      AWS_ACCESS_KEY_ID: 'test-access-key-id',
      AWS_SECRET_ACCESS_KEY: 'test-secret-access-key',
      AWS_SESSION_TOKEN: 'test-session-token',
      AWS_PROFILE: '',
    };
    // Captured and reassigned rather than deleted: `delete process.env[key]` is
    // a dynamic-key delete, and restoring an absent variable to the empty string
    // is indistinguishable to every reader below.
    const previous = Object.fromEntries(
      Object.keys(overrides).map((key) => [key, process.env[key] ?? '']),
    );

    Object.assign(process.env, overrides);
    try {
      await runChecks();
    } finally {
      Object.assign(process.env, previous);
    }
  };

  it('aborts a single stalled request at the pinned deadline', async () => {
    await withUnresponsiveServer(async (port, connectionsSoFar) => {
      const client = createStorageDocumentClient({ region: 'eu-west-1' });
      const handler = client.config.requestHandler;
      if (!(handler instanceof NodeHttpHandler)) {
        throw new Error('expected the shipped client to be built on a NodeHttpHandler');
      }

      try {
        const { error, elapsedMs } = await timeRejection(() =>
          handler.handle(
            new HttpRequest({
              protocol: 'http:',
              hostname: '127.0.0.1',
              port,
              method: 'GET',
              path: '/',
            }),
          ),
        );

        expect(error).toMatchObject({ name: 'TimeoutError' });
        // Bounded below as well as above: a request that failed instantly would
        // also reject, and would mean something other than the deadline stopped it.
        expect(elapsedMs).toBeGreaterThanOrEqual(STORAGE_REQUEST_TIMEOUT_MS - 200);
        expect(elapsedMs).toBeLessThan(STORAGE_REQUEST_TIMEOUT_MS * 2);
        expect(connectionsSoFar()).toBe(1);
      } finally {
        client.destroy();
      }
    });
  }, 20_000);

  it('abandons a stalled command inside the worst case the ingestion budget prices', async () => {
    // The claim `@cumulo/ingestion`'s STORE_SEND_WORST_MS makes, measured end to
    // end through the real retry strategy rather than modelled.
    await withUnresponsiveServer(async (port, connectionsSoFar) => {
      await withLocalEndpoint(port, async () => {
        const client = createStorageDocumentClient({ region: 'eu-west-1' });

        try {
          const { error, elapsedMs } = await timeRejection(() =>
            client.send(
              new PutCommand({
                TableName: 'cumulo-weather-test',
                Item: { locationId: 'x', sk: 'y' },
              }),
            ),
          );

          expect(error).toMatchObject({ name: 'TimeoutError' });
          // Every attempt was made and every one hit its deadline...
          expect(elapsedMs).toBeGreaterThanOrEqual(
            STORAGE_MAX_ATTEMPTS * STORAGE_REQUEST_TIMEOUT_MS - 500,
          );
          // ...and the whole thing still finished inside the budgeted bound,
          // plus the wall-clock time that bound does not model.
          expect(elapsedMs).toBeLessThanOrEqual(commandWorstCaseMs + WALL_CLOCK_OVERHEAD_MS);
          // Proof the command reached the fixture rather than the internet:
          // without it, a real endpoint refusing us would look like a passing
          // timeout test — which is exactly how an earlier draft of this file
          // silently sent a PutItem to real DynamoDB.
          expect(connectionsSoFar()).toBe(STORAGE_MAX_ATTEMPTS);
        } finally {
          client.destroy();
        }
      });
    });
  }, 60_000);

  it('pins values a laptop-run CLI can also live with', () => {
    // The package's consumers are not only the in-region Lambda: the operator
    // smoke script and #16's hindcast run from a workstation over the public
    // internet. Both numbers are an order of magnitude above a transatlantic
    // round trip, so pinning them cannot turn a slow link into a failure.
    expect(STORAGE_REQUEST_TIMEOUT_MS).toBeGreaterThanOrEqual(1_000);
    expect(STORAGE_CONNECTION_TIMEOUT_MS).toBeGreaterThanOrEqual(500);
    expect(STORAGE_CONNECTION_TIMEOUT_MS).toBeLessThan(STORAGE_REQUEST_TIMEOUT_MS);
  });
});
