import { describe, expect, it } from 'vitest';

import { checkWriteOrigin } from './origin-check';

const OWN = 'https://abc123.execute-api.eu-west-1.amazonaws.com';
const WEB = 'https://d111111abcdef8.cloudfront.net';

describe('checkWriteOrigin', () => {
  it('admits the origin the request arrived at, which is what same-origin Swagger UI sends', () => {
    expect(checkWriteOrigin([OWN], OWN)).toBe(true);
  });

  it('admits a configured browser origin beside the API’s own', () => {
    expect(checkWriteOrigin([OWN, WEB], WEB)).toBe(true);
  });

  it('refuses a request with no Origin at all — the drive-by script case', () => {
    // The load-bearing case. Absence is what a scanner and a bare `curl` send,
    // so treating it as "probably fine" would admit everything this exists for.
    expect(checkWriteOrigin([OWN, WEB], undefined)).toBe(false);
  });

  it('refuses an origin nobody configured', () => {
    expect(checkWriteOrigin([OWN], 'https://attacker.example')).toBe(false);
  });

  it('refuses when nothing is allowed, rather than treating an empty list as open', () => {
    expect(checkWriteOrigin([], OWN)).toBe(false);
  });

  it('compares case-insensitively, because scheme and host are', () => {
    expect(checkWriteOrigin([OWN], 'HTTPS://ABC123.EXECUTE-API.EU-WEST-1.AMAZONAWS.COM')).toBe(
      true,
    );
    expect(checkWriteOrigin(['HTTPS://Example.COM'], 'https://example.com')).toBe(true);
  });

  it('matches whole origins, so a lookalike host that merely starts with one is refused', () => {
    // `startsWith` on an allow-list is the classic way
    // `https://cumulo.example.com.attacker.net` gets in.
    expect(
      checkWriteOrigin(['https://cumulo.example.com'], 'https://cumulo.example.com.evil.net'),
    ).toBe(false);
    expect(
      checkWriteOrigin(['https://cumulo.example.com'], 'https://evil.cumulo.example.com'),
    ).toBe(false);
  });

  it('does not treat a differing scheme or port as the same origin', () => {
    expect(checkWriteOrigin(['https://example.com'], 'http://example.com')).toBe(false);
    expect(checkWriteOrigin(['https://example.com'], 'https://example.com:8443')).toBe(false);
  });
});
