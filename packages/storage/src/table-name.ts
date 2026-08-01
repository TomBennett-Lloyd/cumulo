/**
 * The single point where DynamoDB physical table names are formed.
 *
 * The Terraform storage stack names its tables `cumulo-<table>-<environment>`.
 * That convention is duplicated in exactly two places by necessity — the
 * infrastructure that creates the tables and the code that addresses them — so
 * the code side is one function rather than a string literal per adapter.
 */

/**
 * The tables of ADR 0002's single-store design, plus `abuse` — #29's per-IP
 * limiter state, which is request-shaped rather than part of the domain model
 * but is created by the same stack and named by the same convention.
 */
export type StorageTable = 'sites' | 'series' | 'weather' | 'metrics' | 'abuse';

/**
 * Mirrors the `environment` variable validation in `infra/storage/variables.tf`.
 * An environment name outside this alphabet cannot name a real table, so it is
 * a programming/config bug rather than a domain outcome — hence a throw
 * (`docs/standards/error-handling.md` rule 1) at the point of construction,
 * instead of a `ResourceNotFoundException` from AWS several layers later.
 */
const ENVIRONMENT_PATTERN = /^[a-z0-9-]+$/;

export const storageTableName = (table: StorageTable, env: string): string => {
  if (!ENVIRONMENT_PATTERN.test(env)) {
    throw new Error(
      `storageTableName: environment must match ${ENVIRONMENT_PATTERN.source}, got '${env}'`,
    );
  }
  return `cumulo-${table}-${env}`;
};
