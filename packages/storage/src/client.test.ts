import { createServer } from 'node:http';

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { ConfiguredRetryStrategy } from '@smithy/core/retry';
import { HttpRequest } from '@smithy/core/transport';
import { NodeHttpHandler, type NodeHttpHandlerOptions } from '@smithy/node-http-handler';
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

  it('pins the resolved client to four attempts with the storage retry strategy', async () => {
    // Built the way production builds it: no injected base client, so this is
    // the retry configuration adapters actually run under.
    const client = createStorageDocumentClient({ region: 'eu-west-1' });

    expect(await client.config.maxAttempts()).toBe(STORAGE_MAX_ATTEMPTS);
    expect(await client.config.retryStrategy()).toBeInstanceOf(ConfiguredRetryStrategy);
  });
});

/**
 * The deadlines #115 added, asserted on the handler the *production* client
 * ships rather than on an injected one — every test above supplies its own base
 * client and so bypasses this configuration entirely
 * (`docs/standards/testing.md` rule 7).
 *
 * A `NodeHttpHandler` only resolves its configuration when it first handles a
 * request, so each test drives one real round trip against a local server. That
 * is also what makes the assertion meaningful: these are the deadlines that
 * were in force for a request that actually went out, not the arguments we
 * remember passing.
 */
describe('createStorageDocumentClient request deadlines', () => {
  /** A server that answers anything immediately, so no test here waits on a timeout. */
  const withLocalServer = async (
    runChecks: (origin: { hostname: string; port: number }) => Promise<void>,
  ): Promise<void> => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/x-amz-json-1.0' });
      response.end('{}');
    });

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });

    try {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        throw new Error('the local test server did not report a TCP port');
      }
      await runChecks({ hostname: '127.0.0.1', port: address.port });
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) {
            resolve();
          } else {
            reject(error);
          }
        });
      });
    }
  };

  /** The handler's resolved configuration, after one request has gone through it. */
  const configsAfterOneRequest = async (
    handler: unknown,
    origin: { hostname: string; port: number },
  ): Promise<NodeHttpHandlerOptions> => {
    if (!(handler instanceof NodeHttpHandler)) {
      throw new Error('expected the client to be built on a NodeHttpHandler');
    }
    await handler.handle(
      new HttpRequest({ protocol: 'http:', method: 'GET', path: '/', ...origin }),
    );
    return handler.httpHandlerConfigs();
  };

  it('every request the shipped client makes carries both pinned deadlines', async () => {
    await withLocalServer(async (origin) => {
      const client = createStorageDocumentClient({ region: 'eu-west-1' });

      try {
        expect(await configsAfterOneRequest(client.config.requestHandler, origin)).toMatchObject({
          requestTimeout: STORAGE_REQUEST_TIMEOUT_MS,
          connectionTimeout: STORAGE_CONNECTION_TIMEOUT_MS,
        });
      } finally {
        client.destroy();
      }
    });
  });

  it('negative control: without the pin a request has no deadline at all', async () => {
    // The state of this package before #115, and the reason the ingestion
    // Lambda's time budget could not be computed: `STORAGE_MAX_ATTEMPTS` bounds
    // how often a request is retried, never how long one may hang, and the
    // SDK's own default is no request timeout whatsoever. Without this control
    // the test above would look identical if the option were being dropped.
    await withLocalServer(async (origin) => {
      const bare = new DynamoDBClient({ region: 'eu-west-1', maxAttempts: STORAGE_MAX_ATTEMPTS });

      try {
        const configs = await configsAfterOneRequest(bare.config.requestHandler, origin);

        expect(configs.requestTimeout).toBeUndefined();
        expect(configs.connectionTimeout).toBeUndefined();
      } finally {
        bare.destroy();
      }
    });
  });

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

  it('allows three retries and then refuses a fourth', async () => {
    // Jitter forced to zero so the four attempts cost no wall-clock time; the
    // delay arithmetic itself is covered above with the production random.
    const strategy = createStorageRetryStrategy(() => 0);

    let token = await strategy.acquireInitialRetryToken('test');
    token = await strategy.refreshRetryTokenForRetry(token, throttled);
    token = await strategy.refreshRetryTokenForRetry(token, throttled);
    token = await strategy.refreshRetryTokenForRetry(token, throttled);

    expect(token.getRetryCount()).toBe(3);
    await expect(strategy.refreshRetryTokenForRetry(token, throttled)).rejects.toThrow(
      'No retry token available',
    );
  });

  it('actually sleeps for the storage backoff between retries', async () => {
    // 5 % of the 1000 ms base is 50 ms, then 5 % of 2000 ms is 100 ms. Observing
    // those delays is what proves the pinned base reaches the SDK, rather than
    // the SDK's own 500 ms throttling base being used.
    const strategy = createStorageRetryStrategy(() => 0.05);

    const token = await strategy.acquireInitialRetryToken('test');
    const firstStarted = Date.now();
    const retried = await strategy.refreshRetryTokenForRetry(token, throttled);
    const firstElapsed = Date.now() - firstStarted;

    const secondStarted = Date.now();
    await strategy.refreshRetryTokenForRetry(retried, throttled);
    const secondElapsed = Date.now() - secondStarted;

    expect(firstElapsed).toBeGreaterThanOrEqual(45);
    expect(secondElapsed).toBeGreaterThanOrEqual(95);
  });
});
