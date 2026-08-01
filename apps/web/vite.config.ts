import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
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
  },
});
