import { apiErrorSchema } from '@cumulo/shared';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { jsonBodyOf } from '../api-fixtures';

import {
  apiErrorStatus,
  describeZodIssues,
  errorResponse,
  jsonResponse,
  zodIssueDetails,
} from './response';

/** A parse failure to render, produced the way the API's own failures are. */
const issuesOf = (schema: z.ZodType, value: unknown): z.ZodError => {
  const parsed = schema.safeParse(value);
  if (parsed.success) {
    throw new Error('expected the fixture value to fail its schema');
  }
  return parsed.error;
};

describe('jsonResponse', () => {
  it('serialises the value and declares JSON', () => {
    const response = jsonResponse(200, z.object({ ok: z.boolean() }), { ok: true });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('application/json');
    expect(jsonBodyOf(response)).toEqual({ ok: true });
  });

  it('strips fields the response schema does not declare', () => {
    // The stored shape is wider than the public one — an attribute added to a
    // table must not become a public field by accident.
    const stored = z.object({ kept: z.string(), internal: z.string() }).parse({
      kept: 'public',
      internal: 'private',
    });

    const response = jsonResponse(200, z.object({ kept: z.string() }), stored);

    expect(jsonBodyOf(response)).toEqual({ kept: 'public' });
  });

  it('throws when the value does not satisfy its own response schema', () => {
    // Type-correct, contract-incorrect: this is the case that would otherwise
    // reach a client as a body the OpenAPI document promised could not exist.
    expect(() =>
      jsonResponse(200, z.object({ capacityKw: z.number().positive() }), {
        capacityKw: -1,
      }),
    ).toThrow();
  });

  it('headers are per response, so one route cannot edit another route’s', () => {
    const first = jsonResponse(200, z.string(), 'a');
    const second = jsonResponse(200, z.string(), 'b');

    first.headers['x-added-by-a-caller'] = 'yes';

    expect(second.headers['x-added-by-a-caller']).toBeUndefined();
  });
});

describe('errorResponse', () => {
  it('derives the status from the code, so the contract cannot be mispaired', () => {
    expect(errorResponse('validation_failed', 'no').statusCode).toBe(400);
    expect(errorResponse('not_found', 'no').statusCode).toBe(404);
    expect(errorResponse('internal', 'no').statusCode).toBe(500);
    expect(apiErrorStatus).toEqual({ validation_failed: 400, not_found: 404, internal: 500 });
  });

  it('produces a body that validates against the shared apiErrorSchema', () => {
    const body = apiErrorSchema.parse(jsonBodyOf(errorResponse('not_found', 'no such site')));

    expect(body).toEqual({ code: 'not_found', message: 'no such site' });
  });

  it('omits details rather than sending an empty one', () => {
    // Presence of `details` is itself the signal that there is something
    // field-specific to say, so an explicit `undefined` would blur it.
    expect(jsonBodyOf(errorResponse('internal', 'no'))).not.toHaveProperty('details');
  });

  it('carries field-level details when there are any', () => {
    const details = [{ path: 'capacityKw', message: 'too big' }];

    const body = apiErrorSchema.parse(
      jsonBodyOf(errorResponse('validation_failed', 'bad site', details)),
    );

    expect(body.details).toEqual(details);
  });
});

describe('zodIssueDetails', () => {
  it('flattens a nested path to the dotted form a caller sent', () => {
    const schema = z.object({ site: z.object({ capacityKw: z.number() }) });

    const details = zodIssueDetails(issuesOf(schema, { site: { capacityKw: 'lots' } }));

    expect(details).toHaveLength(1);
    expect(details[0]?.path).toBe('site.capacityKw');
  });

  it('names the root when the failure is the whole value', () => {
    const details = zodIssueDetails(issuesOf(z.object({ a: z.string() }), 'not an object'));

    expect(details[0]?.path).toBe('<root>');
  });

  it('lists every issue, so a body with three bad fields takes one fix', () => {
    const schema = z.object({ a: z.string(), b: z.string(), c: z.string() });

    expect(zodIssueDetails(issuesOf(schema, { a: 1, b: 2, c: 3 }))).toHaveLength(3);
  });

  it('renders an array index as a path segment', () => {
    const details = zodIssueDetails(issuesOf(z.array(z.string()), ['ok', 7]));

    expect(details[0]?.path).toBe('1');
  });
});

describe('describeZodIssues', () => {
  it('joins the same details into one log line', () => {
    const schema = z.object({ a: z.string(), b: z.string() });

    const line = describeZodIssues(issuesOf(schema, { a: 1, b: 2 }));

    expect(line).toContain('a: ');
    expect(line).toContain('b: ');
    expect(line.split('; ')).toHaveLength(2);
  });
});
