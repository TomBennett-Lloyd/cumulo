import { SiteAdapter, createStorageDocumentClient, storageTableName } from '@cumulo/storage';
import { describe, expect, it } from 'vitest';

/**
 * This service's committed negative control for the shared AWS test guard
 * (#128, #101), which reaches it as a `setupFiles` path in `vitest.config.ts`
 * rather than as an import. The proof has to be per-package because what it
 * measures is **this service's vitest wiring**: the guard being correct in
 * `@cumulo/storage` says nothing about whether this config still points at it.
 * This service needs the proof more than most — `main.ts` builds a real document
 * client at module scope, and `main.test.ts` imports that module.
 *
 * Both tests go through the **production** factory, with no `baseClient` and no
 * explicit region, so what they observe is the environment the guard leaves
 * behind rather than anything the test arranges.
 *
 * The send is probed through `SiteAdapter` rather than through a raw
 * `GetCommand`: `@aws-sdk/lib-dynamodb` reaches this service only as a
 * transitive dependency of `@cumulo/storage`, and pnpm's isolated
 * `node_modules` makes it unresolvable from here — correctly so, since this
 * service owns no AWS dependency of its own. `listActiveSitePhysicsAtLocation`
 * is the specific read because it is the first thing `consume-message.ts` does
 * with a message, so the probe measures the shipped path. Its one cost is that
 * the refusal arrives wrapped: `StorageAdapterBase.sending` converts a failed
 * send into a `StorageError` carrying the original as `cause`, so the loopback
 * evidence is asserted one level down.
 */
describe('the AWS test guard, as this service wires it', () => {
  /**
   * Vitest's default 5 s is not enough for the probe below: the storage
   * package's pinned retry policy re-sends a refused connection once, after a
   * full-jitter sleep of up to a second, so this test is slower than an ordinary
   * unit test by design rather than by accident.
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
        // A table that exists nowhere, read through the adapter call that opens
        // every message this service consumes. If this ever answers, or fails as
        // anything other than a refused connection to port 1, the request left
        // the host and the guard is not holding.
        const sites = new SiteAdapter({ client, tableName: storageTableName('sites', 'test') });

        await expect(
          sites.listActiveSitePhysicsAtLocation('cumulo-aws-test-guard-probe'),
        ).rejects.toMatchObject({
          name: 'StorageError',
          cause: { code: 'ECONNREFUSED', address: '127.0.0.1', port: 1 },
        });
      } finally {
        client.destroy();
      }
    },
    REFUSED_SEND_TIMEOUT_MS,
  );
});
