import { describe, expect, it } from 'vitest';

import { sqsEventSchema } from './sqs-event';

/**
 * The event boundary's job is to say yes to what Lambda actually sends and no to
 * everything else. The cases below are the two halves of that: a real record's
 * extra fields must survive, and the two fields this service reads must be
 * present and usable.
 */

const validRecord = {
  messageId: '059f36b4-87a3-44ab-83d2-661975830a7d',
  body: '[]',
};

describe('the SQS event boundary', () => {
  it('accepts a record and keeps the two fields this service reads', () => {
    const parsed = sqsEventSchema.parse({ Records: [validRecord] });

    expect(parsed.Records).toEqual([validRecord]);
  });

  it('accepts an empty batch — Lambda may deliver one and it is not an error', () => {
    expect(sqsEventSchema.parse({ Records: [] }).Records).toEqual([]);
  });

  it('ignores the record fields this service does not read, rather than rejecting them', () => {
    // The real event carries a dozen more fields. Declaring them would make the
    // platform's payload something this service can break on.
    const parsed = sqsEventSchema.parse({
      Records: [
        {
          ...validRecord,
          receiptHandle: 'AQEBwJnKyrHigUMZj6rYigCgxlaS3SLy0a...',
          eventSource: 'aws:sqs',
          awsRegion: 'eu-west-1',
          attributes: { ApproximateReceiveCount: '1' },
        },
      ],
    });

    expect(parsed.Records[0]).toEqual(validRecord);
  });

  it('rejects an event with no Records at all', () => {
    expect(sqsEventSchema.safeParse({}).success).toBe(false);
  });

  it('rejects an empty messageId, which could never be attributed to a message', () => {
    expect(sqsEventSchema.safeParse({ Records: [{ messageId: '', body: '[]' }] }).success).toBe(
      false,
    );
  });

  it('rejects a body that is not a string — the record layer never parses it', () => {
    expect(
      sqsEventSchema.safeParse({ Records: [{ messageId: 'm-1', body: { readings: [] } }] }).success,
    ).toBe(false);
  });
});
