import { StorageError } from '../errors';

/**
 * Runs an operation that is expected to fail, and hands back the
 * {@link StorageError} it threw.
 *
 * Every adapter's tests need this and all three needed it identically — the
 * shape of the assertion is "the operation rejected, *and* it rejected with the
 * package's own error type carrying its context", which is one intent. Anything
 * else that comes out propagates untouched, so a test that fails for a
 * different reason says so instead of quietly failing the context assertion.
 *
 * Test support: it lives beside the adapters rather than inside one, and it is
 * absent from `index.ts` on purpose.
 */
export const captureStorageError = async (run: () => Promise<unknown>): Promise<StorageError> => {
  try {
    await run();
  } catch (error) {
    if (error instanceof StorageError) {
      return error;
    }
    throw error;
  }
  throw new Error('expected the operation to reject with a StorageError');
};
