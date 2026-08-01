/*
 * The token gallery's entry point — `tokens.html`, and only `tokens.html`.
 *
 * Its stylesheets, in cascade order, are the same convention `src/main.tsx`
 * states: tokens first, because everything below resolves `var(--…)` against
 * them. The gallery needs the shell frame (`app.css`) as well as its own sheet,
 * since it wears the same page chrome — header, title, theme toggle — around a
 * different body.
 *
 * The resemblance to `src/main.tsx` is incidental duplication (structure.md
 * rule 7): these are two entry files for two documents with different
 * stylesheet sets and different roots, and either is free to change without
 * making the other wrong. Merging them would mean one bootstrap deciding which
 * page it was booting, which is the mode flag that rule warns about.
 */
import '@cumulo/ui/styles.css';
import '../app.css';
import './preview.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { TokensHarness } from './TokensHarness';

const container = document.getElementById('root');

if (container === null) {
  // A missing mount point is a violated invariant of tokens.html, not an
  // expected failure (error-handling.md rule 1), so it throws at the process
  // boundary rather than being recovered from.
  throw new Error('Cannot mount the Cumulo tokens harness: tokens.html has no #root element.');
}

createRoot(container).render(
  <StrictMode>
    <TokensHarness />
  </StrictMode>,
);
