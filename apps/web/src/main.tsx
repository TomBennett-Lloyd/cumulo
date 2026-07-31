import '@cumulo/ui/styles.css';
import './preview/preview.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';

const container = document.getElementById('root');

if (container === null) {
  // A missing mount point is a violated invariant of index.html, not an
  // expected failure (error-handling.md rule 1), so it throws at the process
  // boundary rather than being recovered from.
  throw new Error('Cannot mount the Cumulo web app: index.html has no #root element.');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
