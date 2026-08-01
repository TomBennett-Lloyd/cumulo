import { z } from 'zod';

/**
 * The two shapes this service exchanges with the Lambda platform: the event SQS
 * delivers, and the response `ReportBatchItemFailures` expects back.
 *
 * Both are external data, so the inbound half is a zod schema rather than a
 * hand-written interface (`docs/standards/typing.md` rule 3) — an event is
 * `unknown` until parsed, and "the platform would never send us that" is not a
 * type-system argument.
 */

/**
 * The fields of an SQS record this service actually reads, and nothing else.
 *
 * A real record carries a dozen more (`receiptHandle`, `attributes`,
 * `messageAttributes`, `eventSourceARN`, …). None are named here, because zod
 * objects ignore unknown keys by default and every field this schema declares
 * becomes a field the platform is not free to change. `messageId` is the
 * identifier a batch item failure is reported by, and `body` is ADR 0004's
 * message — that is the whole of the coupling.
 *
 * `messageId` is `.min(1)` because an empty identifier would be reported back to
 * Lambda as a failure it cannot attribute to any message: the whole batch is then
 * retried, which is precisely the silent multiplier `ReportBatchItemFailures`
 * exists to avoid. Refusing the event outright is louder and cheaper.
 *
 * `body` is a `string`, not a parsed message. The record boundary and the message
 * contract are different layers with different failure policies: an event that
 * does not look like an SQS event is a platform bug and throws, while a body that
 * does not parse is one message's outcome (`consume-message.ts`).
 */
export const sqsEventSchema = z.object({
  Records: z.array(z.object({ messageId: z.string().min(1), body: z.string() })),
});

export type SqsEvent = z.infer<typeof sqsEventSchema>;

/** One record of a {@link SqsEvent}, as the message-processing layer receives it. */
export type SqsRecord = SqsEvent['Records'][number];

/**
 * The response shape ADR 0004 makes non-optional for this consumer: the ids of
 * the messages that actually failed, so a bad message is redelivered on its own
 * rather than redriving the batch-mates that already succeeded.
 *
 * An interface rather than a schema because nothing parses it — it is this
 * service's output, and the compiler is the only thing that needs to check it.
 * An empty `batchItemFailures` array is the success case and must still be
 * returned: Lambda reads the field, and omitting it entirely means "the whole
 * batch failed".
 */
export interface SqsBatchResponse {
  readonly batchItemFailures: readonly { readonly itemIdentifier: string }[];
}
