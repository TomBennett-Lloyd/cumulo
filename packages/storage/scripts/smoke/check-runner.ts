import { setTimeout as sleep } from 'node:timers/promises';

/**
 * How the smoke run reports itself, and how it copes with eventually-consistent
 * reads.
 */

/**
 * How long to keep re-reading before calling a mismatch a failure.
 *
 * Every read in this script is eventually consistent — `ConsistentRead` is set
 * nowhere in this package (ADR 0002 Consequence 3) and a GSI cannot be read
 * consistently at all — so "I just wrote it and it is not there yet" is a
 * legitimate answer for a short while, and a script that asserted immediately
 * would fail for the wrong reason. Twenty seconds is far beyond DynamoDB's
 * normal replication lag, so exhausting it is a real result, not a flaky one.
 */
const SETTLE_TIMEOUT_MS = 20_000;
const POLL_INTERVAL_MS = 500;

/** Renders an error and its `cause` chain — a `StorageError` says nothing useful without it. */
export const describeError = (error: unknown): string => {
  const chain: string[] = [];
  let current: unknown = error;
  while (current instanceof Error) {
    chain.push(`${current.name}: ${current.message}`);
    current = current.cause;
  }
  return chain.length === 0 ? String(error) : chain.join(' <- ');
};

/** Re-reads until the answer satisfies `settled`, or the settle budget runs out. */
export const eventually = async <TValue>(
  what: string,
  read: () => Promise<TValue>,
  settled: (value: TValue) => boolean,
): Promise<TValue> => {
  const deadline = Date.now() + SETTLE_TIMEOUT_MS;
  for (;;) {
    const value = await read();
    if (settled(value)) {
      return value;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `${what}: still not true after ${String(SETTLE_TIMEOUT_MS)} ms of eventually-consistent re-reads`,
      );
    }
    await sleep(POLL_INTERVAL_MS);
  }
};

/**
 * Runs one check and reports it on its own line.
 *
 * This is the top-level boundary handler of `docs/standards/error-handling.md`
 * rule 2c, applied per check rather than per run: the point of a smoke script is
 * to report *everything* that is broken in one pass, so a failing check records
 * itself and the run continues. Nothing is swallowed — the failure count is what
 * the process exits on.
 */
export class CheckRunner {
  private failures = 0;

  async check(name: string, run: () => Promise<void>): Promise<void> {
    try {
      await run();
      console.log(`PASS  ${name}`);
    } catch (error) {
      this.failures += 1;
      console.error(`FAIL  ${name} — ${describeError(error)}`);
    }
  }

  get failureCount(): number {
    return this.failures;
  }
}
