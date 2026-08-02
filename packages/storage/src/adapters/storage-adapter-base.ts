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
 * A caller's permission to start one more Query page.
 *
 * The bound is asked *between* pages and never mid-page, because a page is a
 * single `Query` send: once it is on the wire the only ways to end it early are
 * to abandon its result or to abort the request, and neither buys back the time
 * already committed. So this is a budget question — "is there room for another
 * round trip?" — not a cancellation signal, and an adapter that has started a
 * page always finishes it (`docs/standards/typing.md` rule 6: one named,
 * reusable contract rather than a bare predicate inlined per adapter).
 */
export interface QueryPaginationBound {
  /** May another Query page be started? Checked between pages, never mid-page. */
  readonly hasBudgetForNextPage: () => boolean;
}

/**
 * Everything a paginated Query collected, plus whether that is the whole
 * answer.
 *
 * `complete` exists because a bounded drain has two indistinguishable-looking
 * endings — the table ran out of matching items, or the caller ran out of
 * budget with `LastEvaluatedKey` still set — and only the second one means the
 * items are a prefix. Returning the flag beside the items is what stops the
 * second ending from being read as the first.
 */
export interface QueryPagesResult {
  readonly items: Record<string, unknown>[];
  /** False when the bound stopped pagination with LastEvaluatedKey still set. */
  readonly complete: boolean;
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
   * Runs a Query to exhaustion, or to the caller's page budget — and says which
   * of the two happened.
   *
   * DynamoDB pages at 1 MB regardless of how few items that is in domain terms,
   * so a caller that ignored `LastEvaluatedKey` would silently return a prefix
   * of the answer — a fleet list quietly missing sites, an archive day quietly
   * missing its afternoon. That is the kind of half-truth this codebase treats
   * as a failure rather than an optimisation.
   *
   * Which is exactly why a `bound` does not make truncation *acceptable*, only
   * *survivable*: a caller with a deadline can now stop paginating instead of
   * being killed mid-drain, but what it must never do is hand the prefix on as
   * though it were the whole answer. So the truncation is not a silence to
   * notice — it is a value, {@link QueryPagesResult.complete}, and a caller
   * that passes a bound is obliged to consume it
   * (`docs/standards/error-handling.md` rules 1 and 5). Passing no bound is the
   * unchanged contract: the drain runs to exhaustion and `complete` is always
   * true.
   *
   * The first page always runs, whatever the bound says. A budget check that
   * could refuse *every* page would turn a read with no time left into an empty
   * result indistinguishable from an empty window; refusing only the
   * continuation keeps "we read nothing" impossible to confuse with "there was
   * nothing".
   *
   * Bounded reads in the *item* sense are still deliberately not this method's
   * job. The series adapter's "the next N points" walks the same pages but
   * recomputes `Limit` on each one and stops early; folding that in would mean
   * an optional `maxItems` and three conditionals branching on it — the mode
   * flag that `structure.md` rule 7 calls the tell that two intents were forced
   * together. A page budget is a different thing from an item budget: it prices
   * round trips, applies identically to every Query this package sends, and
   * changes no request DynamoDB receives.
   */
  protected async queryAllPages(
    operation: string,
    key: Record<string, string> | undefined,
    input: QueryCommandInput,
    bound?: QueryPaginationBound,
  ): Promise<QueryPagesResult> {
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
      } while (exclusiveStartKey !== undefined && (bound?.hasBudgetForNextPage() ?? true));

      return { items, complete: exclusiveStartKey === undefined };
    });
  }
}
