/**
 * The origin check on the unauthenticated write routes: friction, not auth
 * (ADR 0006 layer 0).
 *
 * What it buys is narrow and worth stating plainly, because a reader who
 * mistakes it for a security control will trust it with something it cannot
 * hold. It stops two real things: a drive-by script pointed at the endpoint by
 * a scanner, which sends no `Origin` at all; and a *third-party page* driving a
 * visitor's browser at this API, because a browser sets `Origin` itself and a
 * page cannot forge another site's. It stops nothing else — any `curl` with
 * `-H "Origin: …"` sails through, and that is by design. This is a demo whose
 * whole point is that anyone can add a site; the limiter, the throttles and the
 * cap are what bound the damage, and the layer that actually costs an attacker
 * something is measured in dollars, not in headers.
 *
 * Pure, and separate from the limiter, because it decides on the request alone —
 * no clock, no table, no shared state. Nothing here needs a mock to test.
 */

/**
 * Whether a write may proceed on the strength of its `Origin` header.
 *
 * Case-insensitive, because a header value's scheme and host are
 * case-insensitive per RFC 6454 while the comparison `===` performs is not, and
 * `HTTPS://Example.com` naming the allowed origin is the allowed origin.
 * Otherwise exact: no prefix, suffix or subdomain matching, since `startsWith`
 * on an origin list is the classic way `https://cumulo.example.com.attacker.net`
 * gets admitted.
 *
 * An absent header is a refusal rather than a pass. That is the load-bearing
 * half — a non-browser client is exactly what sends no `Origin`, so treating
 * absence as "probably fine" would leave this function admitting everything it
 * was written to add friction to.
 */
export const checkWriteOrigin = (
  allowed: readonly string[],
  originHeader: string | undefined,
): boolean => {
  if (originHeader === undefined) {
    return false;
  }

  const origin = originHeader.toLowerCase();
  return allowed.some((candidate) => candidate.toLowerCase() === origin);
};
