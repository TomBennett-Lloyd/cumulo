/*
 * The second preview server: the same app, built and served under a non-root
 * public base path.
 *
 * That is the shape GitHub Pages serves — `.github/workflows/deploy-pages.yml`
 * builds with a `--base` flag, and Vite rewrites every root-absolute URL in
 * `apps/web/index.html`'s head to sit under it — and until #541 nothing in this
 * repo ever loaded it. The rest of the browser lane previews at `/`, where
 * those hrefs are already correct, so the one transformation the deployed site
 * depends on was the one no spec could fail on.
 *
 * This module names the two things both ends of that second server need to
 * agree about. `playwright.config.ts` starts it; `base-path.spec.ts` is the
 * only spec that reads it.
 */

/**
 * The base the probe build is given.
 *
 * Deliberately not the deploy workflow's `/cumulo/`. That header claims to be
 * the only file carrying the literal — "it dies with this file" — so a copy
 * here would make the claim false and hand the teardown a site its own list
 * does not name. Nothing under test wants the real value either: the property
 * asserted is that a rewritten URL is prefixed by *whatever* base the build was
 * given, which a synthetic path states without also looking like a claim about
 * where the demo is hosted.
 *
 * It is additionally what stops the spec passing vacuously. A build that
 * ignored the flag emits `/favicon.svg`, which this prefix does not match,
 * where a `/`-shaped probe would have matched every href ever emitted.
 */
export const PROBE_BASE_PATH = '/cumulo-base-probe/';

/**
 * Where the probe build is written, relative to the `apps/web` package root.
 *
 * Not `dist/`, because Playwright starts every `webServer` in parallel and each
 * build empties its own out dir first: sharing one would be a race in which a
 * build deletes the other's output, not a flake. The path ends in a directory
 * named `dist` on purpose — `.gitignore`, `.prettierignore`,
 * `eslint.config.mjs` and `stylelint.config.mjs` are each keyed on that name,
 * so a sibling called anything else would add one new literal to four files.
 */
export const PROBE_OUT_DIR = 'base-path-preview/dist';
