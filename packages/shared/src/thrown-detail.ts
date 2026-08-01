/**
 * One rendering of an unknown thrown value, for the `detail` strings a service's
 * outcomes carry.
 *
 * Shared rather than restated: ingestion's Open-Meteo adapter describes what a
 * failed request threw, its cycle describes what a location's adapter threw, and
 * the forecast service describes what a message's processing threw. Those are
 * several contexts but one intent — turn a `catch`'s `unknown` into something a
 * human reads in CloudWatch — so a change to the format has to change all of
 * them, which is exactly the case the repetition policy says to extract rather
 * than duplicate. It lives here because that set now spans services, and an app
 * may not import another app (`architecture.md` rule 1).
 *
 * `unknown` is the honest parameter type: JavaScript allows throwing anything, and
 * a thrown string or `undefined` is precisely the case where a naive `.message`
 * would render `undefined` and lose the incident. Naming the typeof instead is what
 * makes such a throw traceable to the code that performed it.
 */
export const describeThrown = (error: unknown): string =>
  error instanceof Error ? `${error.name}: ${error.message}` : `non-Error thrown (${typeof error})`;
