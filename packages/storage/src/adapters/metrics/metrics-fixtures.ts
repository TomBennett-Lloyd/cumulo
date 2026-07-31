import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  errorMetricsSchema,
  utcIsoTimestampSchema,
  type ErrorMetrics,
  type MetricsPeriod,
  type UtcIsoTimestamp,
} from '@cumulo/shared';
import { mockClient } from 'aws-sdk-client-mock';

import { createStorageDocumentClient } from '../../client';

import { MetricsAdapter } from './metrics-adapter';

/**
 * Fixtures shared by this folder's tests — the domain builder, the stored items
 * as the wire has them, and the adapter under test.
 *
 * Test support: one module rather than a copy per test file, because these
 * encode one thing (what a `cumulo-metrics` item looks like) and a change to
 * that shape has to reach every test at once.
 */

export const TABLE_NAME = 'cumulo-metrics-test';

export const SITE_ID = '3f1a2b4c-5d6e-4f7a-8b9c-0d1e2f3a4b5c';

/**
 * Unexported: the two periods below are what tests want, and the branded-stamp
 * builder that makes them is an implementation detail of this module. A test
 * needing its own instant parses one itself rather than reaching for a fixture
 * helper that would then look like part of the shared contract.
 */
const at = (iso: string): UtcIsoTimestamp => utcIsoTimestampSchema.parse(iso);

/** The evaluation window every fixture below scores: one UTC day. */
export const JULY_30: MetricsPeriod = {
  startInclusive: at('2026-07-30T00:00:00Z'),
  endExclusive: at('2026-07-31T00:00:00Z'),
};

/** The next day — the neighbour a period prefix has to exclude. */
export const JULY_31: MetricsPeriod = {
  startInclusive: at('2026-07-31T00:00:00Z'),
  endExclusive: at('2026-08-01T00:00:00Z'),
};

export const errorMetrics = (
  overrides: Partial<Record<keyof ErrorMetrics, unknown>> = {},
): ErrorMetrics =>
  errorMetricsSchema.parse({
    siteId: SITE_ID,
    model: 'physics',
    period: { startInclusive: '2026-07-30T00:00:00Z', endExclusive: '2026-07-31T00:00:00Z' },
    baseline: 'persistence-24h',
    maeKw: 0.42,
    rmseKw: 0.61,
    skillScore: 0.27,
    sampleCount: 24,
    computedAt: '2026-07-31T01:15:00Z',
    ...overrides,
  });

/**
 * Stored items written out literally rather than produced by `toItem` — a
 * fixture that agreed with the code under test by construction would prove
 * nothing about the wire shape. Listed in the order DynamoDB returns them:
 * `#ml#` sorts before `#physics#`.
 */
export const mlItem = {
  siteId: SITE_ID,
  sk: '2026-07-30T00:00:00Z#2026-07-31T00:00:00Z#ml#persistence-24h',
  model: 'ml',
  period: { startInclusive: '2026-07-30T00:00:00Z', endExclusive: '2026-07-31T00:00:00Z' },
  baseline: 'persistence-24h',
  maeKw: 0.31,
  rmseKw: 0.48,
  skillScore: 0.46,
  sampleCount: 24,
  computedAt: '2026-07-31T01:15:00Z',
};

export const physicsItem = {
  ...mlItem,
  sk: '2026-07-30T00:00:00Z#2026-07-31T00:00:00Z#physics#persistence-24h',
  model: 'physics',
  maeKw: 0.42,
  rmseKw: 0.61,
  skillScore: 0.27,
};

/** A run where the baseline was perfect: no comparison available, not zero skill. */
export const noSkillItem = {
  ...physicsItem,
  sk: '2026-07-31T00:00:00Z#2026-08-01T00:00:00Z#physics#persistence-24h',
  period: { startInclusive: '2026-07-31T00:00:00Z', endExclusive: '2026-08-01T00:00:00Z' },
  skillScore: null,
};

export const ddbMock = mockClient(DynamoDBDocumentClient);

export const adapter = (): MetricsAdapter =>
  new MetricsAdapter({
    client: createStorageDocumentClient({
      baseClient: new DynamoDBClient({
        region: 'eu-west-1',
        credentials: { accessKeyId: 'test-access-key-id', secretAccessKey: 'test-secret' },
      }),
    }),
    tableName: TABLE_NAME,
  });
