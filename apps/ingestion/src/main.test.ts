import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The composition root is tested the only way its behaviour is observable: by
 * importing it (`docs/standards/testing.md` rule 1). Startup *is* the behaviour —
 * a composition root's job is to fail before the first cycle when the deployment
 * is wrong, and a test that called an exported `parseIngestionEnv` in isolation
 * would leave the thing that actually matters — that the failure happens at import
 * — unproven.
 *
 * `vi.resetModules()` before each import is what makes that possible: module scope
 * runs once per module graph, so every case needs a fresh one.
 */

const QUEUE_URL = 'https://sqs.eu-west-1.amazonaws.com/123456789012/cumulo-ingestion-test';

const stubEnv = (values: Record<string, string | undefined>): void => {
  for (const [key, value] of Object.entries(values)) {
    vi.stubEnv(key, value);
  }
};

/** The rejection reason of importing the composition root, or a failure if it loaded. */
const importFailure = async (): Promise<unknown> => {
  try {
    await import('./main');
  } catch (error: unknown) {
    return error;
  }
  throw new Error('expected importing ./main to throw, but it loaded');
};

beforeEach(() => {
  vi.resetModules();
  // Every case sets what it needs; nothing inherits the developer's own shell.
  stubEnv({ CUMULO_ENV: undefined, QUEUE_URL: undefined });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('the ingestion composition root', () => {
  it('missing environment variables fail startup loudly', async () => {
    const error = await importFailure();

    // Both are named in one message: a deployment missing two variables should
    // take one fix, not two round trips through a cold start.
    expect(String(error)).toContain('CUMULO_ENV');
    expect(String(error)).toContain('QUEUE_URL');
    expect(String(error)).toContain('invalid environment');
  });

  it('a queue url that is not a url fails startup, not the first publish', async () => {
    stubEnv({ CUMULO_ENV: 'test', QUEUE_URL: 'cumulo-ingestion-test' });

    const error = await importFailure();

    expect(String(error)).toContain('QUEUE_URL');
    expect(String(error)).not.toContain('CUMULO_ENV');
  });

  it('an environment name that cannot name a table fails startup', async () => {
    // `storageTableName` owns this alphabet (it mirrors infra/storage/variables.tf).
    // What this proves is that its throw happens during initialization rather than
    // surfacing as a ResourceNotFoundException on the first cycle's first read.
    stubEnv({ CUMULO_ENV: 'Staging Env', QUEUE_URL });

    const error = await importFailure();

    expect(String(error)).toContain('storageTableName');
    expect(String(error)).toContain('Staging Env');
  });

  it('a complete environment exports a callable handler', async () => {
    stubEnv({ CUMULO_ENV: 'test', QUEUE_URL });

    const main = await import('./main');

    expect(typeof main.handler).toBe('function');
    // Composing the clients performs no I/O: region, credentials and connections
    // are all resolved lazily at send time, which is why this test needs no AWS.
    expect(main.handler.length).toBe(0);
  });
});
