import { OpenMeteoAttribution } from '@cumulo/ui';
import type { ErrorInfo, ReactElement, ReactNode } from 'react';
import { Component } from 'react';

import { APP_FAILURE_ADVICE, APP_FAILURE_HEADING } from './dashboard/state-copy';

/*
 * The last line before a blank page.
 *
 * The dashboard is now the whole app: one surface, no nav, every panel and the
 * map hanging off a single tree. React answers an uncaught render error by
 * unmounting the root, so without a boundary above that tree any one panel
 * throwing takes the header, the theme toggle and the Open-Meteo credit with it
 * — and the credit is a licence obligation, not chrome. This is the standing
 * tech-debt entry "No error boundary above the dashboard's async work",
 * answered for the app as a whole.
 *
 * Two kinds of event land here, because they are the same kind of event. React
 * throws a render error *to* this boundary; the event loop reports an unhandled
 * rejection *past* it, and a boundary that only caught the first would leave a
 * form stuck on "Adding site…" forever while the page looked fine. Under
 * `error-handling.md` rule 1 the data layer returns its expected failures as
 * values, so a rejection that escapes all the way to `window` is by
 * construction a bug — the same class of thing as a throw during render, and
 * owed the same labelled failure rather than a silent hang.
 *
 * `MapRegionBoundary` in `dashboard/LazyMapRegion.tsx` is deliberately *kept*
 * rather than folded into this one. They contain different blast radii: a
 * failed map chunk is a known, routine production event (an `index.html` cached
 * from before a redeploy points at a hashed chunk that 404s) and the right
 * answer is to lose the map and keep the fleet list, the panels and the
 * add-site flow working beside it. Deleting the local boundary would promote
 * that everyday failure into a whole-page failure. This boundary is the outer
 * net for what nothing else expected.
 */

/**
 * What a visitor sees when the tree below has thrown.
 *
 * The credit is the reason this is a component rather than a bare message.
 * Open-Meteo's CC BY 4.0 terms do not lapse because our render did, and the
 * failure surface is the one place the obligation is easiest to drop — so the
 * attribution renders here, from the same `@cumulo/ui` component every other
 * surface uses, and `App.test.tsx` asserts it survives the crash.
 *
 * A reload rather than an in-page retry: this boundary caught something it has
 * no model of, so it has nothing to say about whether trying again would work
 * (`error-handling.md` — degrade honestly rather than offer a control that
 * cannot help). `role="alert"` earns its announcement because this mounts into
 * a page that was already on screen.
 */
const AppFailure = (): ReactElement => (
  <div className="app-failure" role="alert">
    <h2 className="app-failure-heading">{APP_FAILURE_HEADING}</h2>
    <p className="app-failure-message">{APP_FAILURE_ADVICE}</p>
    <OpenMeteoAttribution />
  </div>
);

/** What the boundary knows: whether the tree below it has already thrown. */
interface AppErrorBoundaryState {
  readonly failed: boolean;
}

/**
 * Containment for the whole app surface.
 *
 * A class because React offers no hook form of an error boundary;
 * `structure.md` rule 3's arrow-constant rule and `architecture.md` rule 7's
 * functions-by-default both bend for the one API that requires it, and for
 * nothing else in this file.
 *
 * `componentDidCatch` logs rather than swallows (`error-handling.md` rule 2c):
 * this is where the error stops, so it has to stop *visibly* — a render bug
 * reaching every visitor should be findable in a console rather than inferred
 * from a screenshot of a mostly-empty page. `handleRejection` is the same
 * contract for the asynchronous half.
 */
export class AppErrorBoundary extends Component<
  { readonly children: ReactNode },
  AppErrorBoundaryState
> {
  override state: AppErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): AppErrorBoundaryState {
    return { failed: true };
  }

  /**
   * The rejection nothing awaited, given the same answer as a render throw.
   *
   * Typed against `Event` and narrowed with `in` rather than
   * `instanceof PromiseRejectionEvent`: the reason is the only thing wanted
   * from the event, `in` reads it without depending on the constructor being
   * defined in whatever realm the listener happens to run in, and an
   * `instanceof` against another realm's class answers `false` while the
   * property is right there. `reason` stays `unknown` — a rejection can carry
   * any value, and the log is a boundary log, not a parse.
   *
   * No `preventDefault()`: the browser's own "Uncaught (in promise)" report is
   * the only stack trace anyone gets for this, and suppressing it to keep the
   * console tidy would be swallowing by another name (`error-handling.md`
   * rule 2). This adds a visible failure; it takes nothing away.
   */
  private readonly handleRejection = (event: Event): void => {
    const reason: unknown = 'reason' in event ? event.reason : undefined;

    console.error('Unhandled promise rejection reached the app boundary', { reason });
    this.setState({ failed: true });
  };

  override componentDidMount(): void {
    window.addEventListener('unhandledrejection', this.handleRejection);
  }

  override componentWillUnmount(): void {
    window.removeEventListener('unhandledrejection', this.handleRejection);
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('The dashboard failed to render', {
      message: error.message,
      componentStack: info.componentStack,
    });
  }

  override render(): ReactNode {
    return this.state.failed ? <AppFailure /> : this.props.children;
  }
}
