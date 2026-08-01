/**
 * Which deployed environment an operator script talks to.
 *
 * Shared by every entry point under `scripts/` rather than restated in each,
 * because it is one decision with one answer: the tables are named
 * `cumulo-<table>-<environment>` (`storageTableName`), so a script that resolved
 * the environment differently from its neighbour would read one stack and write
 * another. It lives at the `scripts/` root rather than inside `smoke/` because
 * the smoke run is no longer the only caller — `seed-fleet.ts` needs the same
 * answer, and a seed script reaching into the smoke fixtures for it would be
 * borrowing a value from a module about something else.
 *
 * Never read by `src/`: library code takes its table names as constructor
 * arguments, and an adapter that consulted the environment itself would be
 * untestable and would decide for its callers.
 */
export const ENVIRONMENT = process.env.CUMULO_ENV ?? 'dev';
