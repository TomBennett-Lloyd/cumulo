/**
 * One rendering of an unknown thrown value, for this service's structured log
 * lines.
 *
 * Shared rather than restated: `main.ts`'s boundary describes what a request
 * threw, and `sites/series-cleanup.ts` describes what a best-effort cleanup
 * threw. Two contexts, one intent — turn a `catch`'s `unknown` into something a
 * human reads in CloudWatch Logs Insights — so a change to the format would
 * leave the other caller wrong until it changed the same way, which is the
 * repetition policy's test for extracting (`docs/standards/structure.md` rule 7).
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
