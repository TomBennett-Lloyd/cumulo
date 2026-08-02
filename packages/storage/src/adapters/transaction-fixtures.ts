import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';

/**
 * The cancelled-transaction fixture, shared by every adapter whose tests
 * classify one.
 *
 * Test support. It lives at the adapters root rather than inside one adapter's
 * folder because the site and the weather tests need the identical builder, and
 * neither may import the other's fixtures: both `site-fixtures.ts` and
 * `weather-fixtures.ts` call `mockClient(DynamoDBDocumentClient)` at module
 * scope, and two of those in one test process fight over the same client. This
 * module installs no mock, so both can re-export it.
 *
 * The code strings are written out here rather than imported from
 * `transaction-cancellation.ts`: a fixture that agreed with the code under test
 * by construction would pin nothing about the wire vocabulary. These are the
 * spellings in AWS's `TransactWriteItems` API reference, and the production
 * constants have to match *them*.
 */

/** The code DynamoDB reports for an item whose `ConditionExpression` was false. */
export const CONDITION_FAILED = 'ConditionalCheckFailed';

/** The code DynamoDB reports for an item cancelled by a concurrent transaction. */
export const TRANSACTION_CONFLICT = 'TransactionConflict';

/** The code DynamoDB reports for an item that was itself fine. */
export const NO_REASON = 'None';

/** The capacity code of a provisioned table that was asked for more than it has. */
export const THROUGHPUT_EXCEEDED = 'ProvisionedThroughputExceeded';

/** The capacity code of an on-demand table still scaling up to the offered load. */
export const THROTTLING = 'ThrottlingError';

/**
 * A `TransactWriteItems` rejection as DynamoDB really sends one: one
 * cancellation reason per requested item, in request order, with `None` for the
 * items that were fine.
 *
 * Built from the SDK's own exception class rather than from a hand-made object
 * with a matching `name`, because the ordering-and-shape of
 * `CancellationReasons` is the assumption the adapters' classification rests on
 * — a stand-in would pin the stand-in. Both classifiers reach it through
 * `instanceof`, which a look-alike would fail outright.
 */
export const transactionCancelled = (...codes: readonly string[]): TransactionCanceledException =>
  new TransactionCanceledException({
    message: 'Transaction cancelled, please refer cancellation reasons for specific reasons',
    $metadata: {},
    CancellationReasons: codes.map((Code) => ({ Code })),
  });
