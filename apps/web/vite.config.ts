import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

import { renderContentSecurityPolicy } from './e2e/content-security-policy';
import { DEV_SERVER_PORT, PREVIEW_PORT } from './e2e/lane-ports';

export default defineConfig({
  plugins: [react()],
  server: {
    /*
     * Derived from which tree this is, not hard-coded — 5173 in the primary
     * checkout, a lane port in a worktree. `e2e/lane-ports.ts` owns the
     * derivation and the argument for it; the short version is that two
     * worktrees serving on one port is what used to force browser sessions to
     * run one at a time.
     *
     * `strictPort` is the half that makes the derivation trustworthy. Vite's
     * default is to hop to the next free port and print it, which would leave a
     * session measuring one tree while believing it had started another's
     * server; here a taken port is a refusal to start.
     */
    port: DEV_SERVER_PORT,
    strictPort: true,
  },
  preview: {
    /** The same derivation, a whole block clear of the dev server's lanes. */
    port: PREVIEW_PORT,
    strictPort: true,
    /*
     * The built `dist` is served under the same enforcing CSP the CloudFront
     * response headers policy ships, rendered from the one file that owns it
     * (`infra/web/content-security-policy.tftpl`; see
     * `e2e/content-security-policy.ts` and `infra/web/security-headers.tf`).
     *
     * This is what makes the whole Playwright lane evidence rather than
     * decoration: every spec in `e2e/` — the map boot, maplibre's worker boot,
     * the Open-Meteo attribution trial-clicks — runs against a real response
     * header, on the production bundle, in a real browser. The distribution
     * itself cannot be applied yet, so without this the policy would be a
     * string nobody had ever loaded a browser against.
     *
     * `preview` and not `server`: the dev server deliberately gets no CSP.
     * HMR injects inline `<style>` elements, so a dev policy would have to
     * grant `'unsafe-inline'` — and a policy relaxed until it stops complaining
     * asserts nothing about the one that ships.
     *
     * Only the CSP is served here, not the rest of the policy's headers. It is
     * the one header that can break the app, so it is the one worth proving in
     * a browser; the others are either inert over plain HTTP (HSTS is ignored
     * on an insecure origin) or have nothing a spec could observe, and copying
     * them here would give them a second owner for no evidence in return
     * (`docs/standards/architecture.md` rule 9). They stay owned solely by
     * `infra/web/security-headers.tf`.
     *
     * The origin argument mirrors what the app itself reads: empty-after-trim
     * is how `src/data` recognises "no deployment configured", and it is what
     * `e2e/playwright.config.ts` pins for the lane.
     */
    headers: {
      'content-security-policy': renderContentSecurityPolicy(
        (process.env.VITE_API_BASE_URL ?? '').trim(),
      ),
    },
  },
  build: {
    /*
     * Raised from Vite's default 500 kB, against measured numbers rather than
     * to make a warning go away.
     *
     * After the map split (`src/dashboard/LazyMapRegion.tsx`) the build emits:
     * the entry at 305 kB min / 92 kB gz, the lazily imported map chunk at 949
     * kB min / 248 kB gz, and maplibre's worker at 469 kB. Only the map chunk
     * is over 500 kB, and it is irreducible vendor code that no longer blocks
     * first paint — the warning's own advice ("use dynamic import() to
     * code-split") is exactly what was done, so leaving it firing would train
     * everyone to ignore the one signal that still means something.
     *
     * 1000 kB is chosen to stay a live gate rather than a formality: it sits
     * ~50 kB above today's map chunk, so that chunk growing materially trips it
     * again, and any *synchronous* payload regressing past 1000 kB — the
     * failure this warning actually protects against — still warns loudly.
     *
     * Rejected: `manualChunks` splitting maplibre into two ~470 kB halves to
     * duck the default limit. It would silence the warning without moving a
     * byte off any visitor's wire, which is gaming the metric rather than
     * meeting it.
     */
    chunkSizeWarningLimit: 1000,
  },
  test: {
    // The DOM is opted into per file (`@vitest-environment jsdom`) rather than
    // made the app default — the same rule packages/ui follows. jsdom implies
    // Vite's *web* transform, which rewrites `new URL('./x', import.meta.url)`
    // into a served asset URL and silently breaks any test that reads a file
    // off disk. Component tests declare the environment they need.
    environment: 'node',

    // Vitest owns `src/`, plus `*.test.ts` at the top of `e2e/`. Narrowed from
    // the default glob (`**/*.test.*` anywhere in the package) when the
    // Playwright lane landed in `e2e/`: those specs import `@playwright/test`,
    // which throws outside a Playwright runner, so a default glob that reached
    // them would fail the unit suite rather than skip it.
    //
    // The `e2e/` entry keeps that reason intact and narrows on the suffix
    // instead of the directory — `*.spec.ts` is still nobody's but Playwright's
    // (`testing.md` rule 10 makes that split the naming rule repo-wide), and no
    // glob here can reach one. What it admits is the Node-side config code
    // `e2e/` holds alongside the specs: `lane-ports.ts` is imported by *this*
    // file for the dev and preview servers, so it is not the browser lane's at
    // all, and a pure function of a path has no business paying for a
    // production build and a Chromium download to be asserted.
    include: ['src/**/*.test.{ts,tsx}', 'e2e/*.test.ts'],
  },
});
