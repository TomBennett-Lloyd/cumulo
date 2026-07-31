import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { ConfiguredRetryStrategy } from '@smithy/core/retry';
import { HttpResponse, type HttpRequest } from '@smithy/core/transport';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  STORAGE_MAX_ATTEMPTS,
  STORAGE_RETRY_BASE_DELAY_MS,
  createStorageDocumentClient,
  createStorageRetryStrategy,
  storageRetryDelayMs,
} from './client';

/**
 * A request handler that answers every call with an empty successful response
 * and keeps the signed HTTP requests. Asserting on the serialized body is what
 * makes these contract tests rather than mock-assertion tests
 * (`docs/standards/testing.md` rule 3): the marshalling under test happens in
 * the client's own middleware, below any SDK-level mock.
 */
class RecordingHttpHandler {
  readonly requests: HttpRequest[] = [];
  readonly configUpdates: [string, unknown][] = [];

  handle(request: HttpRequest): Promise<{ response: HttpResponse }> {
    this.requests.push(request);
    return Promise.resolve({
      response: new HttpResponse({
        statusCode: 200,
        headers: { 'content-type': 'application/x-amz-json-1.0' },
        body: new TextEncoder().encode('{}'),
      }),
    });
  }

  updateHttpClientConfig(key: string, value: unknown): void {
    this.configUpdates.push([key, value]);
  }

  httpHandlerConfigs(): Record<string, unknown> {
    return {};
  }
}

const putItemBodySchema = z.object({
  TableName: z.string(),
  Item: z.record(z.string(), z.unknown()),
});

function offlineClient(handler: RecordingHttpHandler): DynamoDBClient {
  return new DynamoDBClient({
    region: 'eu-west-1',
    credentials: { accessKeyId: 'test-access-key-id', secretAccessKey: 'test-secret-access-key' },
    requestHandler: handler,
  });
}

function sentItem(handler: RecordingHttpHandler): Record<string, unknown> {
  const [request] = handler.requests;
  if (request === undefined) {
    throw new Error('no request reached the HTTP handler');
  }
  if (typeof request.body !== 'string') {
    throw new Error('expected a JSON string body on the DynamoDB request');
  }
  return putItemBodySchema.parse(JSON.parse(request.body)).Item;
}

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
