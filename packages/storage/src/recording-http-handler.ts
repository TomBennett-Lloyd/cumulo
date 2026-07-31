import { HttpResponse, type HttpRequest } from '@smithy/core/transport';

/**
 * Keeps the signed HTTP requests and answers each with an empty successful
 * response.
 *
 * Asserting on the serialized body is what makes a marshalling test real
 * (`docs/standards/testing.md` rule 3): the marshalling under test happens in
 * the document client's own middleware, below any SDK-level stub, so a stub
 * would skip it and prove nothing about what reaches DynamoDB.
 *
 * Test support, shared by `client.test.ts` and the series adapter's marshalling
 * tests: both wanted an offline handler that records and answers 200, which is
 * one intent — a change to how the SDK's handler contract is satisfied would
 * leave either copy wrong until it changed the same way. It is absent from
 * `index.ts` on purpose.
 */
export class RecordingHttpHandler {
  readonly requests: HttpRequest[] = [];

  handle(request: HttpRequest): Promise<{ response: HttpResponse }> {
    this.requests.push(request);
    return Promise.resolve({
      response: new HttpResponse({
        statusCode: 200,
        headers: { 'content-type': 'application/x-amz-json-1.0' },
        body: new TextEncoder().encode('{}'),
      }),
    });
  }

  updateHttpClientConfig(): void {
    // No configurable HTTP behaviour is exercised by these tests.
  }

  httpHandlerConfigs(): Record<string, unknown> {
    return {};
  }
}

/**
 * The parsed JSON body of the single request that was sent. Callers hand it to
 * their own schema: what a `PutItem` body has to contain and what a
 * `BatchWriteItem` body has to contain are different questions, and only the
 * "one request, JSON body" part is shared.
 */
export const firstRequestBody = (handler: RecordingHttpHandler): unknown => {
  const [request] = handler.requests;
  if (request === undefined) {
    throw new Error('no request reached the HTTP handler');
  }
  if (typeof request.body !== 'string') {
    throw new Error('expected a JSON string body on the DynamoDB request');
  }
  return JSON.parse(request.body);
};
