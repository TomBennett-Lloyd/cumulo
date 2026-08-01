import { Buffer } from 'node:buffer';

import { describe, expect, it } from 'vitest';

import { API_DOMAIN, OWN_ORIGIN, gatewayEvent } from '../api-fixtures';

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

  it('carries the caller’s address through, which is the limiter’s key', () => {
    expect(parseGatewayEvent(gatewayEvent({ sourceIp: '198.51.100.7' })).sourceIp).toBe(
      '198.51.100.7',
    );
  });

  it('builds this deployment’s own origin from the domain the request arrived at', () => {
    // Derived rather than configured: the api id in that hostname is assigned
    // by AWS at create time, so any constant in this repo would be a guess.
    const request = parseGatewayEvent(gatewayEvent());

    expect(request.ownOrigin).toBe(OWN_ORIGIN);
    expect(request.ownOrigin).toBe(`https://${API_DOMAIN}`);
  });

  it('reads the Origin header under the lowercase name payload v2 uses', () => {
    const request = parseGatewayEvent(gatewayEvent({ headers: { origin: 'https://example.com' } }));

    expect(request.originHeader).toBe('https://example.com');
  });

  it('a request with no Origin header has none — the drive-by client case', () => {
    expect(parseGatewayEvent(gatewayEvent({ headers: {} })).originHeader).toBeUndefined();
    expect(parseGatewayEvent(gatewayEvent({ headers: null })).originHeader).toBeUndefined();
  });

  it('rejects an event with no source address rather than limiting everyone as one caller', () => {
    // Required, unlike the absent-able fields above. A limiter that cannot tell
    // callers apart is not a limiter, so this takes the boundary's 500 path.
    // The request context is rebuilt rather than mutated, so the missing field
    // is visible in the test rather than in a `delete` two lines up.
    const event = {
      ...gatewayEvent(),
      requestContext: { domainName: API_DOMAIN, http: { method: 'GET', path: '/v1/sites' } },
    };

    expect(() => parseGatewayEvent(event)).toThrow('sourceIp');
  });

  it('rejects an event with no domain name, which no origin could be derived from', () => {
    const event = {
      ...gatewayEvent(),
      requestContext: { http: { method: 'GET', path: '/v1/sites', sourceIp: '203.0.113.1' } },
    };

    expect(() => parseGatewayEvent(event)).toThrow('domainName');
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
