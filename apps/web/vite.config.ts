import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  test: {
    // The DOM is opted into per file (`@vitest-environment jsdom`) rather than
    // made the app default — the same rule packages/ui follows. jsdom implies
    // Vite's *web* transform, which rewrites `new URL('./x', import.meta.url)`
    // into a served asset URL and silently breaks any test that reads a file
    // off disk. Component tests declare the environment they need.
    environment: 'node',
  },
});
