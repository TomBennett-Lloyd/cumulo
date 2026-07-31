import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

/**
 * Confirms there is a usable AWS session before a single command is built, and
 * returns the region it resolved.
 *
 * Without this the first failure would be an adapter's `StorageError` wrapping
 * a provider-chain rejection several frames down, which reads like a bug in the
 * storage layer. Credentials are checked before region because a missing
 * session is the overwhelmingly likely reason someone sees this script fail.
 */
export const assertAwsSession = async (client: DynamoDBDocumentClient): Promise<string> => {
  try {
    await client.config.credentials();
  } catch (cause) {
    throw new Error(
      'No AWS credentials: this script talks to live DynamoDB tables and cannot run without an operator session. Sign in (e.g. `aws sso login --profile <profile>`) and re-run with AWS_PROFILE set.',
      { cause },
    );
  }

  try {
    return await client.config.region();
  } catch (cause) {
    throw new Error(
      'No AWS region: set AWS_REGION (or a profile whose config sets one) to the region holding the cumulo storage stack — the same value as `aws_region` in infra/storage.',
      { cause },
    );
  }
};
