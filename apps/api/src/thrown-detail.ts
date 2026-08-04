/**
 * One rendering of an unknown thrown value, for this service's structured log
 * lines.
 *
 * Its consumer is `main.ts`'s request boundary, which describes what a request
 * threw. Its own module rather than a closure inside that boundary because the
 * intent — turn a `catch`'s `unknown` into something a human reads in
 * CloudWatch Logs Insights — is a decision about the *log format*, and the next
 * `catch` this service is allowed to write must render its throw identically or
 * be wrong (`docs/standards/structure.md` rule 7). Keeping it addressable is
 * what makes that a shared statement rather than a coincidence.
 *
 * `unknown` is the honest parameter type: JavaScript allows throwing anything,
 * and a thrown string is precisely the case where a naive `.message` would log
 * `undefined` and lose the incident. Naming the `typeof` instead is what makes
 * such a throw traceable to the code that performed it.
 *
 * Name and message only — never a stack, never an SDK response object. Both can
 * carry an account id or an ARN, and every line this service logs was provoked
 * by an unauthenticated caller.
 *
 * `apps/ingestion` carries the same rendering in its own `thrown-detail.ts`:
 * apps never import from apps (`docs/standards/architecture.md` rule 1), and
 * promoting a five-line log helper into a shared package is a decision worth
 * making on purpose rather than as a side effect of a chunk.
 */
export const describeThrown = (error: unknown): string =>
  error instanceof Error ? `${error.name}: ${error.message}` : `non-Error thrown (${typeof error})`;
