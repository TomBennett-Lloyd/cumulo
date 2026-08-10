import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

import { renderContentSecurityPolicy } from './e2e/content-security-policy';

export default defineConfig({
  plugins: [react()],
  preview: {
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

    // Vitest owns `src/` and nothing else. Narrowed from the default glob
    // (`**/*.test.*` anywhere in the package) when the Playwright lane landed
    // in `e2e/`: those specs import `@playwright/test`, which throws outside a
    // Playwright runner, so a default glob that reached them would fail the
    // unit suite rather than skip it. `*.spec.ts` there and `*.test.ts` here
    // already differ, but the boundary that matters is the directory — it holds
    // whatever the browser lane grows next, fixtures included.
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
