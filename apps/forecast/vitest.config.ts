import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    /**
     * No unit test in this service may reach real AWS on ambient credentials
     * (#128). The setup module pins credentials to sentinels and the endpoint to
     * a refused loopback port; read its header for what it covers, what it
     * deliberately leaves to individual tests, and the one residual it states
     * rather than solves.
     *
     * A path reference to the canonical file in `@cumulo/storage`, not an
     * import: this service already depends on that package, but nothing in its
     * module graph depends on the guard, and a `setupFiles` entry keeps it that
     * way. `src/aws-test-guard.test.ts` is this service's committed proof that
     * the wiring above actually bites — `main.ts` builds a real document client
     * at module scope, and `main.test.ts` imports that module.
     */
    setupFiles: ['../../packages/storage/src/aws-test-guard.setup.ts'],
  },
});
