import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    typecheck: {
      /**
       * Branded types are invisible to runtime tests: deleting a `.brand<…>()`
       * changes no value, so every `*.test.ts` stays green while the compile-time
       * guarantee the brand exists for is gone (#61).
       *
       * `enabled` here rather than a `--typecheck` flag on the `test` script is
       * deliberate. The gate must not be skippable by invocation: `vitest run`,
       * `pnpm test`, `pnpm verify` and CI all read this config, so there is no
       * way to run the suite without the `*.test-d.ts` files. A flag would live
       * in one script and be absent from every other entry point.
       *
       * Adopting this in another package is a copy of this file — no shared
       * preset until a second package actually needs one.
       */
      enabled: true,
    },
  },
});
