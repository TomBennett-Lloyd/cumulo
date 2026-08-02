import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    /**
     * No unit test in this app may reach real AWS on ambient credentials (#128).
     * The setup module pins credentials to sentinels and the endpoint to a
     * refused loopback port; read its header for what it covers, what it
     * deliberately leaves to individual tests, and the one residual it states
     * rather than solves — which is this app's own `SendMessage`.
     *
     * A path reference to the canonical file in `@cumulo/storage`, not an
     * import: nothing in this app's module graph depends on the guard, so
     * sharing it creates no package-boundary edge. `src/aws-test-guard.test.ts`
     * is this app's committed proof that the wiring above actually bites.
     */
    setupFiles: ['../../packages/storage/src/aws-test-guard.setup.ts'],
  },
});
