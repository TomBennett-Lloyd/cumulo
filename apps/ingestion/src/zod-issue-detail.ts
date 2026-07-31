import type { ZodError } from 'zod';

/**
 * One rendering of a zod parse failure, for the `detail` strings this service's
 * failures carry.
 *
 * Shared for the same reason `thrown-detail.ts` is: the Open-Meteo parser
 * explains why a response body was rejected and the composition root explains why
 * the environment was, and both mean "say which field, and what was wrong with it".
 * They had drifted while agreeing — one guarded the empty path, the other did not —
 * which is what a duplicated intent looks like just before it becomes two formats.
 *
 * **Every** issue is listed, not the first. A body with three bad columns, or a
 * deployment missing two variables, should take one fix rather than one round trip
 * per problem.
 */
export const describeZodIssues = (error: ZodError): string =>
  error.issues
    .map((issue) => `${issue.path.length > 0 ? issue.path.join('.') : '<root>'}: ${issue.message}`)
    .join('; ');
