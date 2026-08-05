import { defineConfig } from '@playwright/test';

/*
 * The browser lane: the shipping composition, in a real Chromium.
 *
 * Every jsdom substitution under `src/` is individually justified — WebGL is
 * unmountable there, and `testing.md` rule 3 forbids mocking maplibre — but
 * their sum leaves the default nobody asserts: the real `LazyMapRegion` inside
 * the real shell, served from a real build. That gap is what this config fills,
 * and it is why the lane is deliberately thin. It is not a second component
 * suite; it asserts only the things that stop being true the moment the pieces
 * are assembled.
 */

/**
 * The port the preview server binds, written once — the server command, the
 * readiness probe and `baseURL` all read it from here.
 *
 * `--strictPort` makes a busy 4173 a loud failure instead of vite's silent hop
 * to 4174, which would leave `baseURL` pointing at nothing while the run
 * reported a healthy server.
 */
const PREVIEW_PORT = 4173;

/**
 * The loopback address, pinned on *both* ends — the server binds it, the tests
 * navigate to it.
 *
 * Not cosmetic. `vite preview`'s default host is the name `localhost`, and node
 * resolves that to `::1` on this machine and binds IPv6 only: a `baseURL` of
 * `http://127.0.0.1:4173` then gets ECONNREFUSED while Playwright's own
 * readiness probe (which resolves the same name, and so reaches `::1`) reports
 * the server up. The whole suite fails at `page.goto` with a server that is
 * demonstrably running. Naming a literal address takes the resolver out of the
 * lane entirely, which also stops the failure recurring on a CI image whose
 * `localhost` resolves the other way round.
 */
const PREVIEW_HOST = '127.0.0.1';

export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',

  /*
   * No retries, here and on CI alike. A flaky browser assertion is a defect in
   * the assertion or in the app, and a retry budget is how a suite learns to
   * hide one. The specs wait on states (`toBeVisible`, `toHaveCount`) rather
   * than on time, so there is nothing a second attempt legitimately fixes.
   */
  retries: 0,

  /*
   * A committed `test.only` is a silent narrowing of the gate: the run stays
   * green, reports a pass, and has stopped asserting everything else. Focusing
   * one spec while working on it is still available — pass the file as a CLI
   * argument — and that leaves no trace in the tree. What must be impossible is
   * the version of it that gets committed.
   */
  forbidOnly: true,

  /*
   * `list` for readable logs; `html` writes the report that CI uploads on a
   * failed run. Both are named explicitly because the default flips by
   * environment — `dot` under CI, which writes no report at all, so the
   * failure-only artifact upload in the `web-e2e` job would find nothing.
   * `open: 'never'` keeps a locally failing run from launching a browser UI.
   */
  reporter: [['list'], ['html', { open: 'never' }]],

  use: {
    baseURL: `http://${PREVIEW_HOST}:${String(PREVIEW_PORT)}`,

    /*
     * What a red run leaves behind. With `retries: 0` there is no second
     * attempt to reproduce on, and nobody can re-run a failure on the CI
     * runner's machine, so whatever is captured on the failing attempt is the
     * entire debugging surface — which is what the `web-e2e` job's artifact
     * step promises. Failure-only on both: a trace per passing test would be
     * tens of megabytes of upload for a run nobody will look at.
     */
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },

  /*
   * One project. The lane costs a production build per run and asserts
   * composition rather than rendering, so a second engine would roughly double
   * that cost to re-assert the same three facts. Chromium because it is the
   * engine whose headless WebGL was measured here (below); adding Firefox or
   * WebKit is a decision for whoever has a cross-engine bug to catch, and
   * would need its own GL probe first.
   *
   * No `launchOptions.args` override. The assumption that headless Chromium
   * can hand maplibre a GL context was measured rather than hoped: a probe in
   * this exact configuration reports a live `webgl2` context on
   * `ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device ...), SwiftShader
   * driver)`. ANGLE already resolves to software rendering unaided, so the
   * commonly copy-pasted `--use-angle=swiftshader` would only restate the
   * default. If a future build stops supplying it, the laid-out-canvas
   * assertion in `composition.spec.ts` is what fails, and adding the flag
   * there is the fix.
   */
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],

  webServer: {
    /*
     * `vite build` runs *inside* the server command deliberately: it is what
     * makes "the lane boots the built app" true rather than aspirational.
     * `vite preview` serves the emitted `dist/`, so this exercises the
     * production bundle — minified, code-split, with `LazyMapRegion` fetching
     * a real hashed chunk over HTTP.
     */
    command: `vite build && vite preview --host ${PREVIEW_HOST} --port ${String(PREVIEW_PORT)} --strictPort`,

    /*
     * Resolved against this config's directory by Playwright, so `..` is the
     * `apps/web` package root — where `vite.config.ts` and `index.html` live.
     */
    cwd: '..',
    port: PREVIEW_PORT,

    /*
     * Empty pins the demo fleet: `selectFleetDataSource` (src/data) treats
     * empty-after-trim as "no deployment configured" and returns
     * `DemoFleetDataSource`. Set explicitly rather than left absent so a
     * developer's `.env` pointing at a live Fleet API cannot silently change
     * what the lane is asserting against.
     */
    env: { VITE_API_BASE_URL: '' },

    /*
     * Never adopt a stray. A server already on 4173 is some other build — an
     * old `pnpm dev`, a sibling worktree — and reusing it would report on code
     * that is not in this tree.
     */
    reuseExistingServer: false,

    /** A cold production build plus server start; generous, not a target. */
    timeout: 120_000,
  },
});
