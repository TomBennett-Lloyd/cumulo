/**
 * How much of this invocation's time is left, as a value a handler can ask.
 *
 * The API's counterpart to the ingestion cycle's `deadlineMs` — and it exists
 * for the reason `request-budget.ts` states at length: a handler that keeps
 * starting storage work until it runs out of things to do eventually outlives
 * the function timeout, and a request killed at the timeout never reaches
 * `main.ts`'s error boundary. The caller gets a gateway 504 whose body is not an
 * `apiErrorSchema` one, which on `POST /v1/sites` costs the caller the new
 * site's id for good.
 *
 * Nothing here decides *whether* there is enough time — that predicate is
 * arithmetic over storage's worst case and lives in `request-budget.ts`. This
 * module owns only the other half: where the number comes from, and the fact
 * that a handler asks for it per call rather than being handed a number that
 * was true when the request started.
 */

/**
 * The remaining-time source a handler sees.
 *
 * A function rather than a number, deliberately: a handler that is about to
 * start its third storage command needs the time left *now*, not the time left
 * when the router matched it. Every implementation here is cheap and
 * side-effect-free to call.
 */
export interface RequestDeadline {
  readonly remainingMs: () => number;
}

/**
 * The one part of a Lambda invocation context this service reads.
 *
 * Declared rather than imported: `@types/aws-lambda`'s `Context` describes
 * twenty fields the boundary neither reads nor could supply in a test, and
 * depending on it would make the handler's signature a statement about the SDK
 * rather than about what the code needs.
 */
interface InvocationTimeSource {
  readonly getRemainingTimeInMillis: () => number;
}

/**
 * Is this invocation payload a context that can answer "how long is left?"
 *
 * A type guard rather than a zod parse, which is the narrow exception
 * `docs/standards/typing.md` rule 3 leaves room for: the value being checked is
 * a **live method**, and a schema can only ever confirm that a function was
 * present at parse time — it cannot carry the binding through, because parsing
 * produces a new object. So the check is `typeof … === 'function'`, and the
 * predicate return type is what the compiler follows afterwards (rule 2: a type
 * guard the compiler can follow, never an assertion).
 */
const isInvocationTimeSource = (value: unknown): value is InvocationTimeSource =>
  typeof value === 'object' &&
  value !== null &&
  'getRemainingTimeInMillis' in value &&
  typeof value.getRemainingTimeInMillis === 'function';

/**
 * The fallback's arithmetic, as a unit that needs no context to read
 * (`docs/standards/structure.md` rule 1). Both clock readings arrive as
 * parameters, so the subtraction is legible without knowing which closure
 * captured what.
 */
const countdownRemainingMs = (budgetMs: number, startedAtMs: number, nowMs: number): number =>
  budgetMs - (nowMs - startedAtMs);

/**
 * The deadline for one invocation: Lambda's own clock where there is one, and a
 * countdown from `budgetMs` where there is not.
 *
 * **Delegation is the production path.** Lambda passes a context to every
 * invocation and its `getRemainingTimeInMillis` is the only number that knows
 * about init time already spent, a warm container's clock skew, or a timeout
 * that was changed in Terraform since this bundle was built. Wrapped in an
 * arrow rather than handed back as `context.getRemainingTimeInMillis` on its
 * own: a detached method loses its `this` (`docs/standards/structure.md`
 * rule 3 — inject the object, not the method).
 *
 * **The countdown is the fallback**, for the two callers that have no context:
 * a direct `aws lambda invoke` with no payload plumbing, and this service's own
 * tests. It reads the clock once at construction and subtracts on every call,
 * so it decays like the real one instead of being a constant — a constant
 * deadline would make every budget check in the service pass, which is exactly
 * the shape of "the guard is off in the only configuration the tests run"
 * (`docs/standards/testing.md` rule 7).
 *
 * Negative values are legal from both sources and are not clamped: "9 ms of
 * overdraft" and "0 ms left" are different facts, and the predicate that
 * consumes them (`request-budget.ts`) compares rather than divides.
 */
export const lambdaContextDeadline = (
  context: unknown,
  budgetMs: number,
  // Wrapped rather than defaulted to `Date.now`: a detached method is the bug
  // this codebase already writes the comment for (`apps/ingestion/src/main.ts`).
  now: () => number = () => Date.now(),
): RequestDeadline => {
  if (isInvocationTimeSource(context)) {
    return { remainingMs: () => context.getRemainingTimeInMillis() };
  }

  const startedAtMs = now();
  return { remainingMs: () => countdownRemainingMs(budgetMs, startedAtMs, now()) };
};
