import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { describeZodIssues } from './zod-issue-detail';

/**
 * The contract two callers depend on identically: a rejected Open-Meteo body and a
 * wrong deployment are both explained by this one line, so the properties asserted
 * here are the ones each of them needs — every issue listed, and every issue
 * locatable.
 */
const schema = z.object({
  hourly: z.object({ time: z.array(z.string()) }),
  QUEUE_URL: z.url(),
});

const detailOf = (value: unknown): string => {
  const parsed = schema.safeParse(value);
  if (parsed.success) {
    return expect.fail('expected the fixture to fail parsing');
  }
  return describeZodIssues(parsed.error);
};

describe('describeZodIssues', () => {
  it('names the failing field with its dotted path', () => {
    const detail = detailOf({ hourly: { time: 'not an array' }, QUEUE_URL: 'https://queue.test' });

    expect(detail).toContain('hourly.time');
  });

  it('lists every issue, so one fix can address them all', () => {
    const detail = detailOf({});

    // A deployment missing two variables should take one round trip, not two.
    expect(detail).toContain('hourly');
    expect(detail).toContain('QUEUE_URL');
    expect(detail.split('; ')).toHaveLength(2);
  });

  it('an issue about the value as a whole is attributed to <root>, not to an empty path', () => {
    // Without the guard this reads as a leading ": expected object", which names
    // nothing at all — the one case the two former copies disagreed about.
    const detail = detailOf('not an object');

    expect(detail.startsWith('<root>: ')).toBe(true);
  });
});
