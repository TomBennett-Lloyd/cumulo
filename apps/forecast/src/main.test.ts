import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The composition root is tested the only way its behaviour is observable: by
 * importing it (`docs/standards/testing.md` rule 1). Startup *is* the behaviour —
 * a composition root's job is to fail before the first message when the deployment
 * is wrong, and a test that called an exported `parseForecastEnv` in isolation
 * would leave the thing that actually matters — that the failure happens at import
 * — unproven.
 *
 * That matters more for a queue consumer than for a scheduled function: a message
 * whose invocation dies at initialization is redelivered five times before it is
 * dead-lettered, so a configuration error that surfaced lazily would look like a
 * data problem.
 *
 * `vi.resetModules()` before each import is what makes that possible: module scope
 * runs once per module graph, so every case needs a fresh one.
 */

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
  stubEnv({ CUMULO_ENV: undefined });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('the forecast composition root', () => {
  it('a missing environment suffix fails startup loudly', async () => {
    const error = await importFailure();

    expect(String(error)).toContain('CUMULO_ENV');
    expect(String(error)).toContain('invalid environment');
  });

  it('an empty environment suffix fails startup, not the first table read', async () => {
    stubEnv({ CUMULO_ENV: '' });

    const error = await importFailure();

    expect(String(error)).toContain('CUMULO_ENV');
  });

  it('an environment name that cannot name a table fails startup', async () => {
    // `storageTableName` owns this alphabet (it mirrors infra/storage/variables.tf).
    // What this proves is that its throw happens during initialization rather than
    // surfacing as a ResourceNotFoundException on the first message's site lookup.
    stubEnv({ CUMULO_ENV: 'Staging Env' });

    const error = await importFailure();

    expect(String(error)).toContain('storageTableName');
    expect(String(error)).toContain('Staging Env');
  });

  it('a complete environment exports a callable handler', async () => {
    stubEnv({ CUMULO_ENV: 'test' });

    const main = await import('./main');

    expect(typeof main.handler).toBe('function');
    // One parameter, the event. Composing the clients performs no I/O: region,
    // credentials and connections are all resolved lazily at send time, which is
    // why this test needs no AWS.
    expect(main.handler.length).toBe(1);
  });
});
