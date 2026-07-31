/**
 * Theme selection for the app shell.
 *
 * The rule the shell needs is a pure one — an explicit choice beats the system
 * hint, and the system hint beats the light default — so it lives here as a
 * function of its two inputs rather than inside a component where it could only
 * be tested by driving `localStorage` and `matchMedia`. `App.tsx` reads both
 * browser APIs once, hands the values in, and owns nothing but the wiring.
 */

export type Theme = 'light' | 'dark';

/**
 * Where the visitor's explicit choice is persisted. Exported because the reader
 * and the writer must agree, and a repeated string literal is how they stop
 * agreeing.
 */
export const THEME_STORAGE_KEY = 'cumulo-theme';

/** Narrows a persisted value, which is `string | null` until proven otherwise. */
const isTheme = (value: string | null): value is Theme => value === 'light' || value === 'dark';

/**
 * The theme the app starts in.
 *
 * A stored `'light'` wins over a dark system preference: it is the visitor
 * saying so, and anything else makes the toggle feel like it forgets. Anything
 * else in storage — absent, corrupted, a value from an older build — falls
 * through to the system preference, which is why the parameter is typed as the
 * raw `string | null` that `localStorage.getItem` actually returns instead of
 * pretending the storage layer is trustworthy.
 */
export const resolveInitialTheme = (stored: string | null, prefersDark: boolean): Theme => {
  if (isTheme(stored)) {
    return stored;
  }

  return prefersDark ? 'dark' : 'light';
};
