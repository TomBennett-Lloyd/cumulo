import {
  QueryCommand,
  type DynamoDBDocumentClient,
  type QueryCommandInput,
} from '@aws-sdk/lib-dynamodb';

import type { BatchPolicy } from '../batch';
import { StorageError } from '../errors';

/**
 * What every adapter in this package needs in order to address its table.
 *
 * One named type rather than a shape per adapter (`docs/standards/typing.md`
 * rule 6). The three adapters each declared the identical pair, with identical
 * intent: a change to one — a third dependency, a renamed field — would have
 * left the other two wrong until they changed the same way, which is exactly
 * the test `docs/standards/structure.md` rule 7 puts on a duplicate.
 */
export interface StorageAdapterDeps {
  readonly client: DynamoDBDocumentClient;
  /** Physical table name — build it with `storageTableName(table, env)`. */
  readonly tableName: string;
}

/**
 * The dependencies of an adapter that writes in batches.
 *
 * `batchPolicy` means the same thing to the series and the weather adapter —
 * how hard to push this table before reporting failure — and both fall back to
 * `defaultBatchPolicy` when it is absent, so it is one type rather than two. It
 * governs two pushes, not one: draining an unprocessed batch before reporting
 * `partial`, and (on the weather adapter) re-issuing a `putArchiveDay`
 * transaction that DynamoDB cancelled for capacity. Tests inject a policy that
 * costs no wall-clock time; production leaves it unset.
 */
export interface BatchingAdapterDeps extends StorageAdapterDeps {
  readonly batchPolicy?: BatchPolicy;
}

/**
 * The mechanism the adapters share: the client and table they address, the
 * `StorageError` wrap around a send, and the paginated Query drain.
 *
 * A class rather than a factory closing over `client` and `tableName`, because
 * these values really are state shared by every method, and `this.` is what
 * makes that visible to a reader holding only one method
 * (`docs/standards/architecture.md` rule 7, `structure.md` rule 2).
 *
 * The hierarchy is one level deep and stays that way: this base extends
 * nothing, and an adapter extending anything other than this base is a review
 * blocker. Nothing here is abstract either — this class offers mechanism the
 * adapters call, never a hook they are expected to fill in.
 */
export class StorageAdapterBase {
  protected readonly client: DynamoDBDocumentClient;
  protected readonly tableName: string;

  constructor(deps: StorageAdapterDeps) {
    this.client = deps.client;
    this.tableName = deps.tableName;
  }

  /**
   * Runs SDK calls and converts a rejection into a `StorageError` carrying what
   * was being attempted and on what (`docs/standards/error-handling.md` rules
   * 2b and 4).
   *
   * Only the sends belong inside `call`. Schema parsing happens on the way out,
   * at the call site, so a drifted item keeps its own `ZodError` instead of
   * being disguised as an AWS failure — every caller in this package is
   * deliberate about that boundary, and the adapter tests pin it.
   */
  protected async sending<TResult>(
    operation: string,
    key: Record<string, string> | undefined,
    call: () => Promise<TResult>,
  ): Promise<TResult> {
    try {
      return await call();
    } catch (cause) {
      throw new StorageError(
        { operation, table: this.tableName, ...(key === undefined ? {} : { key }) },
        { cause },
      );
    }
  }

  /**
   * Runs a Query to exhaustion.
   *
   * DynamoDB pages at 1 MB regardless of how few items that is in domain terms,
   * so a caller that ignored `LastEvaluatedKey` would silently return a prefix
   * of the answer — a fleet list quietly missing sites, an archive day quietly
   * missing its afternoon. That is the kind of half-truth this codebase treats
   * as a failure rather than an optimisation.
   *
   * Bounded reads are deliberately *not* this method's job. The series
   * adapter's "the next N points" walks the same pages but recomputes `Limit`
   * on each one and stops early; folding that in would mean an optional
   * `maxItems` and three conditionals branching on it — the mode flag that
   * `structure.md` rule 7 calls the tell that two intents were forced together.
   */
  protected async queryAllPages(
    operation: string,
    key: Record<string, string> | undefined,
    input: QueryCommandInput,
  ): Promise<Record<string, unknown>[]> {
    return this.sending(operation, key, async () => {
      const items: Record<string, unknown>[] = [];
      let exclusiveStartKey: Record<string, unknown> | undefined;

      do {
        const page = await this.client.send(
          new QueryCommand({
            ...input,
            ...(exclusiveStartKey === undefined ? {} : { ExclusiveStartKey: exclusiveStartKey }),
          }),
        );
        items.push(...(page.Items ?? []));
        exclusiveStartKey = page.LastEvaluatedKey;
      } while (exclusiveStartKey !== undefined);

      return items;
    });
  }
}
