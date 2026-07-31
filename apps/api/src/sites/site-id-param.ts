import { siteSchema } from '@cumulo/shared';

import { errorResponse, zodIssueDetails, type ApiResponse } from '../http/response';

/**
 * The `{siteId}` path parameter, validated once for the three routes that take
 * one.
 *
 * Extracted rather than repeated because the three copies would have identical
 * intent (`docs/standards/structure.md` rule 7): change what a site id looks
 * like and all three are wrong until they change together. The check is also
 * load-bearing rather than cosmetic — without it, a path segment of any shape
 * reaches DynamoDB as a key, so "is this a uuid" is the difference between a
 * 400 and a billed read.
 *
 * The uuid rule comes from `siteSchema.shape.id`, not from a second `z.uuid()`
 * here: `@cumulo/shared` owns what a site id is (`architecture.md` rule 2).
 */

/** The name the route table captures the id under, shared by pattern and parser. */
export const siteIdParamName = 'siteId';

export type SiteIdParamResult =
  | { readonly valid: true; readonly siteId: string }
  | { readonly valid: false; readonly response: ApiResponse };

export const parseSiteIdParam = (params: Record<string, string>): SiteIdParamResult => {
  const parsed = siteSchema.shape.id.safeParse(params[siteIdParamName]);
  if (parsed.success) {
    return { valid: true, siteId: parsed.data };
  }

  // The issue's own path is empty — the value was parsed on its own, not as a
  // field of anything — so the detail names the parameter the caller sent.
  return {
    valid: false,
    response: errorResponse(
      'validation_failed',
      'the site id in the path is not a uuid',
      zodIssueDetails(parsed.error).map((detail) => ({
        path: siteIdParamName,
        message: detail.message,
      })),
    ),
  };
};
