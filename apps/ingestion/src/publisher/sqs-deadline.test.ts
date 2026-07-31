import { createServer } from 'node:http';
import type { Socket } from 'node:net';

import { weatherReadingSchema } from '@cumulo/shared';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { ForecastWeatherReading } from '../open-meteo/response';
import {
  INGESTION_SEND_MAX_ATTEMPTS,
  INGESTION_SEND_REQUEST_TIMEOUT_MS,
  SqsWeatherPublisher,
  createIngestionSqsClient,
} from './sqs';

/**
 * The publish deadline, asserted as **behaviour against a server that never
 * answers** rather than as configuration read back off the client.
 *
 * Its own file because `sqs.test.ts` installs `mockClient(SQSClient)` for every
 * test in that module, which intercepts the send before it can reach a socket —
 * the thing this test exists to observe. A mock cannot prove a timeout, so this
 * is the one publisher test that talks to a real one
 * (`docs/standards/testing.md` rule 3).
 *
 * What it caught: the previous assertion was
 * `requestHandler instanceof NodeHttpHandler`, and it passed while the deadline
 * did nothing at all. In the installed @smithy/node-http-handler 4.9.13,
 * `requestTimeout` without `throwOnRequestTimeout` only logs a warning and
 * leaves the socket open, so the "~9 s per location" this publisher's own
 * comment claims — and which `cycle-budget.ts` imports as PUBLISH_WORST_MS —
 * was unenforced (#115).
 */

const forecastReadingSchema = weatherReadingSchema.extend({ kind: z.literal('forecast') });

const oneReading = (): ForecastWeatherReading =>
  forecastReadingSchema.parse({
    latitude: 53.35,
    longitude: -6.26,
    validTime: '2026-07-31T00:00:00Z',
    kind: 'forecast',
    source: 'open-meteo',
    shortwaveRadiationWm2: 400,
    directRadiationWm2: 250,
    diffuseRadiationWm2: 150,
    directNormalIrradianceWm2: 600,
    temperature2mC: 18,
    windSpeed10mMs: 3,
    cloudCoverPct: 40,
  });

describe('createIngestionSqsClient deadlines', () => {
  it('abandons a stalled publish inside the worst case the ingestion budget prices', async () => {
    const sockets = new Set<Socket>();
    let connectionCount = 0;
    const server = createServer(() => {
      // Never writes, never ends. That is the fixture.
    });
    server.on('connection', (socket) => {
      connectionCount += 1;
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });

    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('the local test server did not report a TCP port');
    }

    // The queue URL is what points this at the fixture. SQS routes a
    // `SendMessage` by the host in `QueueUrl`, not by the endpoint the client
    // was configured with, so `AWS_ENDPOINT_URL_SQS` is ignored here — an
    // earlier version set it and the command went to **real SQS**, which
    // announced itself as `InvalidClientTokenId` rather than the timeout being
    // asserted. Credentials and region still have to be present, and set for
    // the whole send, because the SDK resolves them lazily on first use.
    const queueUrl = `http://127.0.0.1:${String(address.port)}/123456789012/cumulo-weather-readings-test`;
    const previous = {
      region: process.env.AWS_REGION,
      keyId: process.env.AWS_ACCESS_KEY_ID,
      secret: process.env.AWS_SECRET_ACCESS_KEY,
    };
    process.env.AWS_REGION = 'eu-west-1';
    process.env.AWS_ACCESS_KEY_ID = 'test-access-key-id';
    process.env.AWS_SECRET_ACCESS_KEY = 'test-secret-access-key';

    const client = createIngestionSqsClient();
    const publisher = new SqsWeatherPublisher({ client, queueUrl });

    try {
      const startedAt = Date.now();
      await expect(publisher.publishLocationReadings([oneReading()])).rejects.toMatchObject({
        name: 'TimeoutError',
      });
      const elapsedMs = Date.now() - startedAt;

      // Proof the request reached the fixture rather than the internet: without
      // this, a network failure or a real endpoint rejecting us would look like
      // a passing timeout test.
      expect(connectionCount).toBeGreaterThanOrEqual(INGESTION_SEND_MAX_ATTEMPTS);

      // Every attempt was made and every one hit its deadline — a publish that
      // failed instantly would also reject, and would mean something other than
      // the deadline stopped it.
      expect(elapsedMs).toBeGreaterThanOrEqual(
        INGESTION_SEND_MAX_ATTEMPTS * INGESTION_SEND_REQUEST_TIMEOUT_MS - 500,
      );
      // ...and the publish still ended inside the bound the budget prices,
      // which is the attempts plus the SDK's own throttling backoff.
      expect(elapsedMs).toBeLessThanOrEqual(
        INGESTION_SEND_MAX_ATTEMPTS * INGESTION_SEND_REQUEST_TIMEOUT_MS + 1_500,
      );
    } finally {
      client.destroy();
      process.env.AWS_REGION = previous.region;
      process.env.AWS_ACCESS_KEY_ID = previous.keyId;
      process.env.AWS_SECRET_ACCESS_KEY = previous.secret;
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    }
  }, 40_000);
});
