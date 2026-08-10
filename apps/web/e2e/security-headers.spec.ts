import { expect, test } from '@playwright/test';

import { renderContentSecurityPolicy } from './content-security-policy';
import { routeBasemap } from './hermetic-basemap';

/*
 * The Content-Security-Policy the edge will serve, enforced on the built app in
 * a real browser.
 *
 * `infra/web/security-headers.tf` renders it onto a CloudFront distribution that
 * cannot be applied yet, so `terraform validate` is the only check that stack
 * can offer itself — and a policy that has passed only that is a string nobody
 * has ever loaded a browser against. `vite.config.ts` closes that by serving the
 * same rendering as a real response header on `vite preview`, which means every
 * spec in this directory already runs under the enforcing policy. This file is
 * the part that says so out loud: one case proving the header is really there,
 * one proving nothing in the app trips over it.
 *
 * Two directives are genuinely exercised here despite the hermetic basemap, and
 * both are worth naming because it looks otherwise:
 *
 *   * `connect-src`'s basemap tiles origin — spelled in the template alone, and
 *     owned by `src/map/basemap.ts`, whose restatement ledger names this lane's
 *     one carrier of it (`hermetic-basemap.ts`'s route glob). CSP is evaluated by the
 *     browser *before* Playwright's route interception sees the request — the
 *     policy check happens at fetch initiation, the stub answers afterwards — so
 *     the style fetch is a real cross-origin connection as far as the policy is
 *     concerned. Removing that origin from the template fails this file.
 *   * `worker-src 'self'`. maplibre constructs its worker when a map is
 *     constructed, whatever the style turns out to contain, so the empty style
 *     does not spare it — the built `maplibre-gl-worker-*.js` chunk is really
 *     fetched during this case, and a `worker-src 'none'` template fails it,
 *     naming that chunk. This is the criterion `composition.spec.ts` cannot see:
 *     per `src/map/MapView.tsx`'s own note, maplibre creates and sizes
 *     `.maplibregl-canvas` without its worker, so that spec's laid-out-canvas
 *     assertion stays green with the worker blocked.
 *
 *     One thing that follows and is easy to get wrong: *deleting* the
 *     `worker-src` and `child-src` lines does not fail this case, and that is
 *     the policy working rather than the case going blind. CSP's fallback chain
 *     for a worker is `worker-src` → `child-src` → `script-src` →
 *     `default-src`, so with both gone the worker is still permitted by
 *     `script-src 'self'`. Those two lines buy explicitness and older engines
 *     (`infra/web/security-headers.tf` argues `child-src` on exactly that
 *     ground); the directive that would actually strand the worker is a
 *     narrowed `worker-src`, which is why that is the mutant this claim was
 *     measured with.
 */

/**
 * What a `securitypolicyviolation` event is reduced to before it crosses back
 * out of the page.
 *
 * Two fields rather than the event: `SecurityPolicyViolationEvent` is not
 * structured-cloneable, so it cannot survive `page.evaluate`'s serialisation at
 * all, and these two are what identify a violation in a failure message — which
 * rule was broken, and by what.
 */
interface CspViolation {
  readonly violatedDirective: string;
  readonly blockedURI: string;
}

declare global {
  interface Window {
    /**
     * Every violation the document has reported, in order.
     *
     * Installed by the init script below before any application script runs, so
     * it is present for the whole of the page's life rather than optional.
     */
    cumuloCspViolations: CspViolation[];
  }
}

test.beforeEach(async ({ page }) => {
  await routeBasemap(page);
});

test('serves the content-security-policy the Terraform template owns', async ({ page }) => {
  const response = await page.goto('/');

  if (response === null) {
    throw new Error('Navigating to the app produced no response to read headers from.');
  }

  /*
   * `''` is the right rendering to expect because `playwright.config.ts` pins
   * `VITE_API_BASE_URL` to empty for the lane's server — demo mode, no API
   * origin — and `vite.config.ts` renders the header from that same value.
   *
   * Computed from the template rather than written out: a copy of the policy
   * here would be a second owner of the text (`architecture.md` rule 9), and it
   * would assert only that two strings in this repo agree rather than that the
   * server served what the template says.
   *
   * This case is also the vacuity guard for the one below. Zero violations is
   * exactly what a page with no CSP at all reports, so "nothing was blocked" is
   * evidence only once the header is known to be present and correct.
   */
  expect(response.headers()['content-security-policy']).toBe(renderContentSecurityPolicy(''));
});

test('boots the dashboard and map with zero CSP violations', async ({ page }) => {
  /*
   * Registered before navigation so the listener predates the document's own
   * scripts; Playwright injects init scripts through the debugging protocol,
   * which is not itself subject to the policy being measured.
   */
  await page.addInitScript(() => {
    window.cumuloCspViolations = [];
    document.addEventListener('securitypolicyviolation', (event) => {
      window.cumuloCspViolations.push({
        violatedDirective: event.violatedDirective,
        blockedURI: event.blockedURI,
      });
    });
  });

  await page.goto('/');

  /*
   * The states worth waiting for are the ones whose work the policy could
   * block: the map's WebGL canvas (its worker and its cross-origin style fetch),
   * the placeholder being gone rather than stacked behind it, and the fleet
   * rendering at all.
   *
   * At least one row, not the fleet size — `composition.spec.ts` owns that
   * number and asserting it twice would give it two owners (`architecture.md`
   * rule 9). What this case needs from the table is only that the app got far
   * enough to render one.
   */
  await expect(page.locator('.maplibregl-canvas')).toBeVisible();
  await expect(page.locator('.map-placeholder')).toHaveCount(0);
  await expect(page.locator('[data-site-id]').first()).toBeAttached();

  const violations = await page.evaluate(() => window.cumuloCspViolations);

  /*
   * The residual, honestly: this is a sample taken once the states above have
   * settled, so a violation fired later than that could still slip past. And the
   * hermetic basemap serves a style with no sources and no layers, so the
   * sprite, glyph and raster image loads a real style would perform are not
   * exercised here at all — `img-src`'s tiles origin and `data:` entry are
   * covered by the browser-smoke check against the real style, not by this file.
   */
  expect(
    violations,
    `The page reported CSP violations: ${violations.map((violation) => `${violation.violatedDirective} blocked ${violation.blockedURI}`).join(', ')}`,
  ).toEqual([]);
});

/**
 * A stand-in origin for the arm this lane cannot serve. `.test` is reserved by
 * RFC 2606 and resolves nowhere, which is safe precisely because the case below
 * never opens a connection to it.
 */
const SAMPLE_API_ORIGIN = 'https://api.example.test';

/** The one directive `api_origin` is permitted to change. */
const CONNECT_SRC = 'connect-src';

/**
 * The directive name a rendered directive starts with — everything up to its
 * first space, or the whole of a value-less directive.
 */
const directiveName = (directive: string): string => {
  const boundary = directive.indexOf(' ');

  return boundary === -1 ? directive : directive.slice(0, boundary);
};

/**
 * A rendered policy split back into its directives, keyed by name.
 *
 * Keyed rather than compared as one string so a difference is attributed to a
 * directive by name instead of to an offset in a 300-character line.
 */
const directivesByName = (policy: string): Map<string, string> =>
  new Map(policy.split('; ').map((directive) => [directiveName(directive), directive]));

/*
 * The arm that ships, asserted where nothing else can reach it.
 *
 * This case is a pure computation over the template — no page, no server. It is
 * here rather than in a colocated `*.test.ts` because `vite.config.ts`'s
 * `include` narrows vitest to `*.test.{ts,tsx}` files under `src/`, so nothing
 * in this directory runs there at all; and it cannot be an assertion on a
 * served header, because the lane pins
 * `VITE_API_BASE_URL: ''` (`playwright.config.ts`) and standing up a second
 * preview server for one string comparison would cost a build to prove an
 * equality. The `beforeEach` above still builds a page for it, which buys
 * nothing here and keeps this file on the same shape as every other spec.
 *
 * Why it earns its place: the served-header case above proves only the *empty*
 * arm, and the empty arm is the one no deployment runs. Both deploy workflows
 * refuse to publish a build without an API base URL, so `csp_api_origin`'s
 * non-empty branch and this file's TS mirror of it are the production path and
 * were, until this case, exercised by nothing.
 *
 * What it pins is the separator rule both implementations encode independently:
 * exactly one space between the tiles origin and the API origin, contributed by
 * the renderer and not by the value. That is also the property `infra/README.md`'s
 * Phase B header readback asks an operator to confirm by eye — a policy with two
 * spaces or none is still syntactically a policy, and the second silently
 * concatenates two origins into one nonexistent host.
 */
test('appends the API origin to connect-src alone, behind exactly one space', () => {
  const withoutApi = directivesByName(renderContentSecurityPolicy(''));
  const withApi = directivesByName(renderContentSecurityPolicy(SAMPLE_API_ORIGIN));

  /*
   * Not vacuity insurance so much as the one hole the comparison below has: if
   * `connect-src` were renamed and the placeholder moved with it, every
   * directive would still line up and the loop would assert nothing about the
   * directive this case is named for.
   */
  expect(
    [...withoutApi.keys()],
    `The rendered policy has no \`${CONNECT_SRC}\` directive to append an API origin to.`,
  ).toContain(CONNECT_SRC);

  expect(
    [...withApi.keys()],
    'An API origin changed which directives the policy declares, not just their values.',
  ).toEqual([...withoutApi.keys()]);

  for (const [name, directive] of withoutApi) {
    expect(
      withApi.get(name),
      `\`${name}\` rendered differently for an API origin than expected.`,
    ).toBe(name === CONNECT_SRC ? `${directive} ${SAMPLE_API_ORIGIN}` : directive);
  }
});
