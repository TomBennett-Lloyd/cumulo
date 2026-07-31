/**
 * The one exception type this package throws for *unexpected* failures.
 *
 * `docs/standards/error-handling.md` rule 1 splits the world: outcomes inside a
 * function's domain — a site that does not exist, a batch that did not fully
 * drain — are returned as values, and the adapters do exactly that. What is
 * left is the genuinely unexpected: a connection reset, a credential failure, a
 * table that is not there. Those are bugs or outages, not domain outcomes, so
 * they propagate to the process boundary (rule 1) — but never bare. Rule 2b
 * says a `catch` may add context and rethrow, and rule 4 says the context is
 * *what operation, on what entity*. `StorageError` is that context, made
 * mandatory by the constructor rather than left to each call site's discipline.
 */

/** What was being attempted when the underlying call failed. */
export interface StorageErrorContext {
  /** Adapter-level operation name, e.g. `putFleetSite`, `querySeriesRange`. */
  readonly operation: string;
  /** Physical table name, e.g. `cumulo-series-dev`. */
  readonly table: string;
  /**
   * The key of the item under operation, when the operation targets one.
   * String-valued because every key attribute in ADR 0002 is a string, and
   * because an error message must never become a place domain values leak in
   * unpredictable shapes.
   */
  readonly key?: Record<string, string>;
}

const describe = (context: StorageErrorContext): string => {
  const base = `storage operation '${context.operation}' failed on table '${context.table}'`;
  if (context.key === undefined) {
    return base;
  }
  const key = Object.entries(context.key)
    .map(([name, value]) => `${name}=${value}`)
    .join(', ');
  return `${base} for key {${key}}`;
};

export class StorageError extends Error {
  override readonly name = 'StorageError';
  readonly context: StorageErrorContext;

  /**
   * `cause` is required, not optional: this error exists only to wrap something
   * that already went wrong, and an unexplained `StorageError` would be a
   * swallowed failure wearing a hat.
   */
  constructor(context: StorageErrorContext, options: { cause: unknown }) {
    super(describe(context), options);
    this.context = context;
  }
}
