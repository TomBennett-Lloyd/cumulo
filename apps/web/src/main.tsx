/*
 * Every stylesheet in this app, in one place and in cascade order.
 *
 * Tokens first: everything below resolves `var(--…)` against them, and a sheet
 * loaded ahead of the declarations it consumes has nothing to read. The rest is
 * one convention rather than two — a component that imported its own CSS would
 * put that file's position in the cascade at the mercy of module evaluation
 * order, which is a bundler detail no reviewer can see from the component. The
 * exception is maplibre's vendor stylesheet, which `MapView` imports beside the
 * library it belongs to.
 */
import '@cumulo/ui/styles.css';
import './app.css';
import './dashboard/dashboard.css';
import './map/map.css';
import './add-site/add-site.css';
import './dashboard/site-panels.css';
import './dashboard/panel-states.css';
import './charts/charts.css';
import './views/views.css';

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
