/**
 * One rendering of an unknown thrown value, for the `detail` strings this service's
 * outcomes carry.
 *
 * Shared rather than restated: the Open-Meteo adapter describes what a failed
 * request threw, and `cycle.ts` describes what a location's adapter threw. Those
 * are two contexts but one intent — turn a `catch`'s `unknown` into something a
 * human reads in CloudWatch — so a change to the format has to change both, which
 * is exactly the case the repetition policy says to extract rather than duplicate.
 *
 * `unknown` is the honest parameter type: JavaScript allows throwing anything, and
 * a thrown string or `undefined` is precisely the case where a naive `.message`
 * would render `undefined` and lose the incident. Naming the typeof instead is what
 * makes such a throw traceable to the code that performed it.
 */
export const describeThrown = (error: unknown): string =>
  error instanceof Error ? `${error.name}: ${error.message}` : `non-Error thrown (${typeof error})`;
