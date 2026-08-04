import { z } from 'zod';

import { TTL_ATTRIBUTE_NAME } from '../../ttl';

/**
 * The wire format of a `cumulo-abuse` item: the two kinds of row the per-IP
 * limiter keeps, the keys that address them, and the parses that read them back.
 *
 * These live apart from the adapter for the reason the other adapters' item
 * modules do — this is the part a reader checks against
 * `infra/storage/tables.tf` — but the table itself is shaped unlike the other
 * four. It is a single hash key `pk` with no sort key, because nothing ever
 * asks for a *range* of this data: every access is "this exact address, this
 * exact window" or "this exact address's block". One key attribute is therefore
 * the whole key design, and the two row kinds are told apart by a prefix on it.
 *
 * Both kinds carry `expiresAt` and are reaped by DynamoDB TTL, which is what
 * keeps the table's stored size at roughly "addresses seen in the last few
 * minutes" and its bill at nothing. TTL is asynchronous and not punctual, so
 * nothing here may treat "the item is present" as "the fact is still true" —
 * see `AbuseAdapter.getBlock`.
 */

/**
 * Separates the row kind, the address and the window inside `pk`. Also the one
 * character an address may not contain, since an address carrying it could
 * address another address's row.
 */
const KEY_DELIMITER = '#';

/** Prefix of a rate-counting row: one per address per fixed window. */
export const RATE_KEY_PREFIX = `RATE${KEY_DELIMITER}`;

/** Prefix of a block row: at most one per address. */
export const BLOCK_KEY_PREFIX = `BLOCK${KEY_DELIMITER}`;

/**
 * Rejects a client address that cannot safely become part of a key.
 *
 * A source address arrives from the API gateway event, which is a boundary, so
 * "it will be a well-formed IP" is an assumption rather than a fact. An empty
 * or delimiter-bearing address is a bug in whatever produced it — a violated
 * invariant, so it throws (`docs/standards/error-handling.md` rule 1) instead
 * of quietly counting one client's requests against another's budget.
 */
const requireAddress = (ip: string): void => {
  if (ip.length === 0 || ip.includes(KEY_DELIMITER)) {
    throw new Error(
      `abuse key: client address must be non-empty and free of '${KEY_DELIMITER}', got '${ip}'`,
    );
  }
};

/**
 * The key of one address's counter for one fixed window.
 *
 * The window start is part of the key rather than an attribute, so a new window
 * is a new item rather than a reset nobody can perform atomically — and the old
 * one is left for TTL to collect.
 */
export const rateWindowKey = (ip: string, windowStartEpochSeconds: number): string => {
  requireAddress(ip);
  return `${RATE_KEY_PREFIX}${ip}${KEY_DELIMITER}${String(windowStartEpochSeconds)}`;
};

/** The key of one address's block row. */
export const blockKey = (ip: string): string => {
  requireAddress(ip);
  return `${BLOCK_KEY_PREFIX}${ip}`;
};

/**
 * A stored block row: until when, and a TTL set to the same instant so the row
 * disappears once it stops meaning anything.
 */
export interface BlockItem {
  readonly pk: string;
  readonly blockedUntil: number;
  readonly [TTL_ATTRIBUTE_NAME]: number;
}

export const toBlockItem = (ip: string, blockedUntilEpochSeconds: number): BlockItem => ({
  pk: blockKey(ip),
  blockedUntil: blockedUntilEpochSeconds,
  // Deliberately the same number: the row's usefulness and its lifetime are the
  // same fact, so there is nothing to keep in step.
  [TTL_ATTRIBUTE_NAME]: blockedUntilEpochSeconds,
});

/**
 * What `UpdateItem` hands back under `ReturnValues: 'UPDATED_NEW'` — the
 * post-increment count, which is the answer the limiter acts on.
 *
 * Parsed rather than trusted, and non-negative-integer rather than `number`: a
 * count that came back as a string or a float would mean this row was written
 * by something other than `incrementRateWindow`, and comparing that to a
 * threshold would produce a silently wrong verdict rather than an error
 * (typing rule 3).
 */
const updatedCountSchema = z.object({ requestCount: z.number().int().nonnegative() });

export const toRequestCount = (attributes: Record<string, unknown> | undefined): number =>
  updatedCountSchema.parse(attributes).requestCount;

/**
 * The stored block instant. Only `blockedUntil` is read: `expiresAt` is
 * DynamoDB's business, and re-deriving the verdict from it would give the row
 * two sources of truth.
 */
const blockItemSchema = z.object({ blockedUntil: z.number().int() });

export const toBlockedUntil = (item: Record<string, unknown>): number =>
  blockItemSchema.parse(item).blockedUntil;
