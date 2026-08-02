/**
 * Which DynamoDB failure shapes the **SDK's own** retry layer acts on, counted
 * at the wire (#166).
 *
 * These pin third-party behaviour, not ours: the service model decides which
 * errors carry a retryable trait, and this package's whole layering argument —
 * who owns which failure, recorded on {@link STORAGE_MAX_ATTEMPTS} in
 * `./client.ts` — rests on the answer. `aws-sdk-client-mock` cannot be the
 * instrument here: it stubs the client *above* the retry middleware, so every
 * one of these commands would look like a single send whatever the SDK believes
 * (`docs/standards/testing.md` rule 3). Counting HTTP requests where the socket
 * would be is the only place the classification is visible.
 *
 * **Why this is a sibling of `client.test.ts` rather than a block inside it.**
 * These belong with that file by subject — same module under test, and the
 * attempt counts below are the empirical half of the policy its
 * `createStorageRetryStrategy` tests state as configuration. They are split out
 * because `client.test.ts` sits at 262 of the 300 code lines `max-lines` allows
 * and this block needs ~77, so it cannot land there at all. That ceiling is a
 * real seam waiting to be drawn on concern boundaries rather than on an
 * arriving test's deadline; #199 tracks doing it deliberately, and this file
 * moves with whatever split that issue lands.
 *
 * The environment these run in still carries the AWS guard's sentinels
 * (`./aws-test-guard.setup.ts`) — its loopback endpoint is simply never reached,
 * because the handler below intercepts above the socket.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { PutCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { HttpResponse, type HttpRequest } from '@smithy/core/transport';
import { describe, expect, it } from 'vitest';

import {
  STORAGE_MAX_ATTEMPTS,
  createStorageDocumentClient,
  createStorageRetryStrategy,
} from './client';

describe('createStorageDocumentClient retry classification', () => {
  /**
   * Records every request and answers each with the same DynamoDB error.
   *
   * Kept separate from `RecordingHttpHandler` (`./recording-http-handler.ts`)
   * rather than made a mode of it (`docs/standards/structure.md` rule 7): that
   * handler's contract is "records and answers 200", it is shared with the
   * series marshalling tests, and this one exists precisely to fail. Either
   * could change without making the other wrong, so the resemblance is
   * incidental — and a `statusCode` flag on the shared one would be exactly the
   * tell that rule warns about.
   */
  class FailingHttpHandler {
    readonly requests: HttpRequest[] = [];
    private readonly body: Uint8Array;

    /** `errorBody` is the JSON DynamoDB would return, `__type` and all. */
    constructor(errorBody: Record<string, unknown>) {
      this.body = new TextEncoder().encode(JSON.stringify(errorBody));
    }

    handle(request: HttpRequest): Promise<{ response: HttpResponse }> {
      this.requests.push(request);
      return Promise.resolve({
        response: new HttpResponse({
          statusCode: 400,
          headers: { 'content-type': 'application/x-amz-json-1.0' },
          body: this.body,
        }),
      });
    }

    updateHttpClientConfig(): void {
      // No configurable HTTP behaviour is exercised by these tests.
    }

    httpHandlerConfigs(): Record<string, unknown> {
      return {};
    }
  }

  /**
   * A base client carrying the **production** retry policy.
   *
   * Restated here rather than inherited, because `createStorageDocumentClient`
   * only builds its own client when no `baseClient` is supplied — and a supplied
   * one supplies its own retry configuration, as `StorageClientOptions` says. A
   * plain `new DynamoDBClient()` would silently test the SDK's default 3
   * attempts instead of this package's 2, so these counts would pin nothing.
   * Jitter is forced to zero so the retries cost no wall-clock time; the delay
   * arithmetic itself is covered by `storageRetryDelayMs`'s own tests.
   */
  const failingClient = (handler: FailingHttpHandler): DynamoDBClient =>
    new DynamoDBClient({
      region: 'eu-west-1',
      credentials: { accessKeyId: 'test-access-key-id', secretAccessKey: 'test-secret-access-key' },
      maxAttempts: STORAGE_MAX_ATTEMPTS,
      retryStrategy: createStorageRetryStrategy(() => 0),
      requestHandler: handler,
    });

  it('spends the whole pinned budget on a whole-request throttle', async () => {
    // The shape ADR 0002 names as the provisioned tables' expected failure: a
    // Get/Put/Delete, a Query page, or a wholly-declined batch rejected outright
    // rather than reporting UnprocessedItems. It carries the service model's
    // throttling trait, so the SDK layer is its retry owner.
    const handler = new FailingHttpHandler({
      __type: 'com.amazonaws.dynamodb.v20120810#ProvisionedThroughputExceededException',
      message: 'The level of configured provisioned throughput for the table was exceeded.',
    });
    const client = createStorageDocumentClient({ baseClient: failingClient(handler) });

    await expect(
      client.send(
        new PutCommand({
          TableName: 'cumulo-series-test',
          Item: { siteId: 'site-1', sk: 'T#2026-07-30T14:00:00Z#FC#physics' },
        }),
      ),
    ).rejects.toMatchObject({ name: 'ProvisionedThroughputExceededException' });

    // The policy pin: initial send plus the one retry STORAGE_MAX_ATTEMPTS
    // allows, stated as the literal 2 so raising the constant fails here loudly.
    expect(handler.requests).toHaveLength(2);
  });

  it('gets no SDK retry at all for a capacity-cancelled transaction', async () => {
    // The premise #166 rests on, pinned empirically rather than read off the
    // service model by hand: a TransactWriteItems cancelled for capacity reports
    // the cause only inside CancellationReasons[].Code, and the exception itself
    // carries no retryable trait — so no SDK-layer retry, ever.
    //
    // TRIPWIRE: if an SDK upgrade starts retrying this shape, this test goes red
    // with 2 requests instead of 1, and the weather adapter's bounded re-issue
    // on `putArchiveDay` becomes a second layer stacked on the SDK's — the exact
    // stacking #122 collapsed. Revisit that loop before touching this number.
    const handler = new FailingHttpHandler({
      __type: 'com.amazonaws.dynamodb.v20120810#TransactionCanceledException',
      Message: 'Transaction cancelled, please refer cancellation reasons for specific reasons',
      CancellationReasons: [
        {
          Code: 'ProvisionedThroughputExceeded',
          Message: 'The level of configured provisioned throughput for the table was exceeded.',
        },
        { Code: 'None' },
      ],
    });
    const client = createStorageDocumentClient({ baseClient: failingClient(handler) });

    await expect(
      client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: 'cumulo-weather-test',
                Item: { locationId: 'loc-1', sk: 'ARCHIVE#2026-07-30' },
              },
            },
          ],
        }),
      ),
    ).rejects.toMatchObject({ name: 'TransactionCanceledException' });

    // Exactly the initial send. This is the service's omission, not ours.
    expect(handler.requests).toHaveLength(1);
  });
});
