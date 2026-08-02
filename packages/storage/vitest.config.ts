import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    /**
     * No unit test in this package may reach real AWS on ambient credentials
     * (#128). The setup module pins credentials to sentinels and the endpoint to
     * a refused loopback port; read its header for what it covers, what it
     * deliberately leaves to individual tests, and the one residual it states
     * rather than solves.
     *
     * A path reference, not an import — nothing in this package's module graph
     * depends on the guard, and the apps that share it point at this same file.
     */
    setupFiles: ['./src/aws-test-guard.setup.ts'],
  },
});
