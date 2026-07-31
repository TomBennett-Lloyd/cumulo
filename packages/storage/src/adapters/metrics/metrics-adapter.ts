import { PutCommand } from '@aws-sdk/lib-dynamodb';
import type { ErrorMetrics, MetricsPeriod } from '@cumulo/shared';

import { StorageAdapterBase } from '../storage-adapter-base';

import { fromItem, metricsPeriodPrefix, toItem } from './metrics-item';

/**
 * The `cumulo-metrics` adapter — one row per site, evaluation period, model and
 * baseline (ADR 0002 "Key design" table 4).
 *
 * PK `siteId`, SK `<periodStart>#<periodEnd>#<model>#<baseline>`. Period leads
 * the sort key so that both models' scores for one window come back from a
 * single `begins_with` Query rather than one Query per model — access pattern
 * H5, and the payload #20's comparison endpoint returns.
 *
 * Writes are single `PutCommand`s. A hindcast run produces a handful of rows,
 * the table is on-demand (`infra/storage/tables.tf`), and one Put per row is
 * both the honest unit of failure — it either landed or it threw — and cheaper
 * to reason about than the batch drain the series and weather adapters need for
 * their thousands of items.
 *
 * `ConsistentRead` appears nowhere here (ADR 0002 Consequence 3) — see the
 * comment on `createStorageDocumentClient`.
 */
export class MetricsAdapter extends StorageAdapterBase {
  /**
   * Writes one evaluation result, replacing any previous result for the same
   * site, period, model and baseline.
   *
   * Overwrite is the intended semantic: those four values *are* the identity of
   * the row, so re-running a hindcast over the same window publishes a corrected
   * number instead of accumulating two rows that disagree.
   */
  async putMetrics(metrics: ErrorMetrics): Promise<void> {
    const item = toItem(metrics);

    await this.sending('putMetrics', { siteId: metrics.siteId, sk: item.sk }, () =>
      this.client.send(new PutCommand({ TableName: this.tableName, Item: item })),
    );
  }

  /** Every model's score for one site over one evaluation window (H5/A6). */
  async queryMetricsForPeriod(siteId: string, period: MetricsPeriod): Promise<ErrorMetrics[]> {
    if (period.endExclusive <= period.startInclusive) {
      throw new Error(
        `queryMetricsForPeriod: period ends at ${period.endExclusive}, at or before its start ${period.startInclusive}`,
      );
    }

    // `begins_with` rather than a range: the rows wanted here all share one
    // period, and what varies below it — model, then baseline — is not something
    // the caller is asking to bound. A prefix says exactly that, and says it in
    // the key condition rather than in a filter DynamoDB would charge for.
    const items = await this.queryAllPages(
      'queryMetricsForPeriod',
      { siteId },
      {
        TableName: this.tableName,
        KeyConditionExpression: 'siteId = :siteId AND begins_with(sk, :periodPrefix)',
        ExpressionAttributeValues: {
          ':siteId': siteId,
          ':periodPrefix': metricsPeriodPrefix(period),
        },
      },
    );

    return items.map(fromItem);
  }
}
