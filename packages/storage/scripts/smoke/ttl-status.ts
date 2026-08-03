import { equal, ok } from 'node:assert/strict';

import { DescribeTimeToLiveCommand } from '@aws-sdk/client-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

/**
 * Asserts one table's TTL *posture*, read back from DynamoDB.
 *
 * Not a check module: it is the one assertion four of the table modules share,
 * so it lives here rather than being copied into each with a slightly different
 * failure message (`docs/standards/structure.md` rule 7 — same intent, so the
 * shared portion is extracted).
 *
 * Why configuration rather than deletion. TTL reaping is asynchronous and
 * best-effort — typically within days, never within a smoke run — so a check
 * that waited for an expired row to vanish would be a check that fails for the
 * wrong reason. What *is* provable in seconds is whether the retention story
 * the code is written against is actually applied to the table: enabled, and on
 * the attribute the adapters write. That is what `DescribeTimeToLive` answers,
 * and it answers it about the deployed table rather than about
 * `infra/storage/tables.tf`, which is the only reason to ask AWS at all.
 *
 * The command comes from `@aws-sdk/client-dynamodb`, which this package depends
 * on directly, and travels through the document client: TTL configuration has
 * no attribute values to marshal, so the document layer has nothing to do with
 * it beyond carrying it, and a second bare client would be a second
 * configuration to keep in step with `createStorageDocumentClient`.
 *
 * `Assumption:` a table on which TTL was never configured reports `DISABLED`
 * rather than an absent description. `cumulo-metrics` is that table, and the
 * operator confirms it independently with
 * `aws dynamodb describe-time-to-live --table-name cumulo-metrics-<env>` before
 * trusting a FAIL line from here. If AWS disagrees, this helper is what changes
 * — and the divergence gets reported rather than quietly accommodated.
 */

/** The one attribute name every TTL-bearing table in this repo uses. */
const TTL_ATTRIBUTE = 'expiresAt';

export const assertTtlStatus = async (
  client: DynamoDBDocumentClient,
  tableName: string,
  expected: 'ENABLED' | 'DISABLED',
): Promise<void> => {
  const { TimeToLiveDescription } = await client.send(
    new DescribeTimeToLiveCommand({ TableName: tableName }),
  );

  ok(
    TimeToLiveDescription !== undefined,
    `${tableName}: DescribeTimeToLive returned no TTL description`,
  );
  equal(
    TimeToLiveDescription.TimeToLiveStatus,
    expected,
    `${tableName}: TTL status is not ${expected}`,
  );

  if (expected === 'ENABLED') {
    // An enabled TTL on the wrong attribute is worse than no TTL at all: every
    // write would look retained and nothing would ever expire.
    equal(
      TimeToLiveDescription.AttributeName,
      TTL_ATTRIBUTE,
      `${tableName}: TTL is enabled on an attribute other than '${TTL_ATTRIBUTE}'`,
    );
  }
};
