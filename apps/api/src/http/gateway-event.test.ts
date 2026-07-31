import { Buffer } from 'node:buffer';

import { describe, expect, it } from 'vitest';

import { gatewayEvent } from '../api-fixtures';

import { parseGatewayEvent } from './gateway-event';

describe('parseGatewayEvent', () => {
  it('takes the method from the request context and the path from rawPath', () => {
    // Payload v2 puts the method inside `requestContext.http` and leaves a v1
    // reader looking at `httpMethod`, which is not there.
    const request = parseGatewayEvent(gatewayEvent({ method: 'DELETE', rawPath: '/v1/sites/abc' }));

    expect(request.method).toBe('DELETE');
    expect(request.path).toBe('/v1/sites/abc');
  });

  it('an absent query string is an empty map, not an absent one', () => {
    expect(parseGatewayEvent(gatewayEvent()).query).toEqual({});
  });

  it('tolerates a null query string, which no route should have to think about', () => {
    expect(parseGatewayEvent(gatewayEvent({ queryStringParameters: null })).query).toEqual({});
  });

  it('carries query parameters through verbatim', () => {
    const request = parseGatewayEvent(gatewayEvent({ queryStringParameters: { hours: '48' } }));

    expect(request.query.hours).toBe('48');
  });

  it('hands a text body through untouched', () => {
    const request = parseGatewayEvent(gatewayEvent({ body: '{"name":"Ranelagh"}' }));

    expect(request.rawBody).toBe('{"name":"Ranelagh"}');
  });

  it('decodes a base64 body, which the gateway may send for any content type', () => {
    const body = Buffer.from('{"name":"Ranelagh"}', 'utf8').toString('base64');

    const request = parseGatewayEvent(gatewayEvent({ body, isBase64Encoded: true }));

    expect(request.rawBody).toBe('{"name":"Ranelagh"}');
  });

  it('a request with no body has no body, whether the field is absent or null', () => {
    expect(parseGatewayEvent(gatewayEvent()).rawBody).toBeUndefined();
    expect(parseGatewayEvent(gatewayEvent({ body: null })).rawBody).toBeUndefined();
  });

  it('throws naming the fields when the payload is not a v2 event', () => {
    // The v1 shape: `path` and `httpMethod` at the top level, no `rawPath` and
    // no `requestContext.http`. Wiring this function to a v1 integration is a
    // broken deployment, and the message has to say which fields were missing.
    const error = (): unknown => {
      try {
        parseGatewayEvent({ path: '/v1/sites', httpMethod: 'GET' });
      } catch (thrown: unknown) {
        return thrown;
      }
      throw new Error('expected a v1 event to be rejected');
    };

    expect(String(error())).toContain('rawPath');
    expect(String(error())).toContain('requestContext');
  });

  it('throws rather than guessing when the event is not an object at all', () => {
    expect(() => parseGatewayEvent(null)).toThrow('payload v2');
  });
});
