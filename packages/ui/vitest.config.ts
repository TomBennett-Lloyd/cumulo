import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The DOM is opted into per file (`@vitest-environment jsdom`), not made
    // the package default. jsdom implies Vite's *web* transform, which rewrites
    // `new URL('./x', import.meta.url)` into a served http:// asset URL — that
    // silently breaks the token tests, which read tokens.css off disk.
    // Component tests declare the environment they need; filesystem tests keep
    // node semantics.
    environment: 'node',
  },
});
