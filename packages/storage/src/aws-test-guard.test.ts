import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { describe, expect, it } from 'vitest';

import { createStorageDocumentClient } from './client';

/**
 * The committed negative control for `./aws-test-guard.setup.ts` (#128, #101):
 * a gate nobody exercises is a gate that can die quietly. Both tests go through
 * the **production** factory with no `baseClient` and no explicit region, so
 * what they measure is the environment the guard leaves behind rather than
 * anything the test itself arranges.
 *
 * The two mutants they exist to kill, each of which widens what a test may
 * reach: delete the guard's `AWS_ENDPOINT_URL` assignment and the second test
 * stops seeing a refused loopback socket; delete its credential sentinels and
 * the first test stops resolving an identity at all.
 */
describe('the AWS test guard', () => {
  /**
   * Vitest's default 5 s is not enough for the probe below: the package's pinned
   * retry policy re-sends a refused connection once, after a full-jitter sleep
   * of up to a second, so this test is slower than an ordinary unit test by
   * design rather than by accident.
   */
  const REFUSED_SEND_TIMEOUT_MS = 15_000;

  it('resolves credentials to the test sentinel, never the machine ambient identity', async () => {
    const client = createStorageDocumentClient();

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
      const client = createStorageDocumentClient();

      try {
        // A table that exists nowhere: if this ever resolves, or fails as
        // anything other than a refused connection to port 1, the request left
        // the host and the guard is not holding.
        await expect(
          client.send(
            new GetCommand({
              TableName: 'cumulo-aws-test-guard-probe',
              Key: { siteId: 'probe' },
            }),
          ),
        ).rejects.toMatchObject({ code: 'ECONNREFUSED', address: '127.0.0.1', port: 1 });
      } finally {
        client.destroy();
      }
    },
    REFUSED_SEND_TIMEOUT_MS,
  );
});
