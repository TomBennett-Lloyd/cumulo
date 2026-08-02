import { ListQueuesCommand } from '@aws-sdk/client-sqs';
import { describe, expect, it } from 'vitest';

import { createIngestionSqsClient } from './publisher/sqs';

/**
 * This app's committed negative control for the shared AWS test guard (#128,
 * #101), which reaches it as a `setupFiles` path in `vitest.config.ts` rather
 * than as an import. The proof has to be per-package because what it measures is
 * **this package's vitest wiring**: the guard being correct in
 * `@cumulo/storage` says nothing about whether this config still points at it.
 *
 * Both tests go through the **production** factory, with no endpoint and no
 * region of their own, so what they observe is the environment the guard leaves
 * behind rather than anything the test arranges.
 *
 * `ListQueues` is the probe because it routes by the client's endpoint, which is
 * what the loopback sentinel governs. This app's own command does not:
 * `SendMessage` routes by the host in its `QueueUrl` (the residual the guard's
 * header states), so for the one command ingestion actually ships, the
 * credential sentinel — the first test below — is the layer that holds.
 */
describe('the AWS test guard, as this app wires it', () => {
  /**
   * Vitest's default 5 s is not enough for the probe below: the publisher's
   * pinned attempt budget re-sends a refused connection twice, with the standard
   * strategy's backoff between attempts, so this test is slower than an ordinary
   * unit test by design rather than by accident.
   */
  const REFUSED_SEND_TIMEOUT_MS = 15_000;

  it('resolves credentials to the test sentinel, never the machine ambient identity', async () => {
    const client = createIngestionSqsClient();

    try {
      const credentials = client.config.credentials;
      if (typeof credentials !== 'function') {
        throw new Error('expected the shipped client to resolve credentials through a provider');
      }

      const resolved = await credentials();

      // The literal is duplicated from the setup module deliberately: if the two
      // drift apart this fails, where reading the value back from the same
      // source it was set from would pass no matter what that value became.
      expect(resolved.accessKeyId).toBe('cumulo-test-sentinel-access-key-id');
    } finally {
      client.destroy();
    }
  });

  it(
    'kills an unmocked send at the loopback sentinel, before it reaches a network',
    async () => {
      const client = createIngestionSqsClient();

      try {
        // If this ever answers, or fails as anything other than a refused
        // connection to port 1, the request left the host and the guard is not
        // holding.
        await expect(client.send(new ListQueuesCommand({}))).rejects.toMatchObject({
          code: 'ECONNREFUSED',
          address: '127.0.0.1',
          port: 1,
        });
      } finally {
        client.destroy();
      }
    },
    REFUSED_SEND_TIMEOUT_MS,
  );
});
