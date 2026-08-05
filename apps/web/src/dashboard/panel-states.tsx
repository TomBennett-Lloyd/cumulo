import type { ReactElement } from 'react';

import { RETRY_ACTION_LABEL } from './state-copy';

/*
 * The content column's three async states, as three components.
 *
 * Every panel in the column answers the same three questions — is this still
 * arriving, did it fail, is there nothing to show — and before this module each
 * surface answered them in its own markup with its own roles. That is how the
 * column ended up with a pending state announced by one panel and silent in
 * another. These are the one answer; `react.md`'s "Async surface convention
 * (apps/web)" is the same rule in prose, and the classes they carry are owned
 * by `panel-states.css`.
 *
 * They are presentational and total: props in, one element out, no data
 * fetching and no state (`react.md` rule 4). The wording they display is not
 * theirs either — it lives in `state-copy.ts`, so the copy can be read and
 * changed in one place without opening a component.
 */

export interface PanelPendingProps {
  /** What is being waited for, in words the reader can act on. */
  readonly label: string;
}

/**
 * Something is on its way, and the reader is told what.
 *
 * `aria-busy="true"` on the container and a visible label — deliberately *not*
 * `role="status"`. A live region that is mounted with its text already inside
 * it announces nothing in most screen readers: the region has to exist before
 * the text changes for the change to be a change (the #161 finding). So the
 * pending state states its case in ordinary content, and the announcement
 * budget is spent where it works — the alert below, which really does mount
 * into an already-rendered tree.
 *
 * Completion is therefore the content replacing this element, not an
 * announcement about it.
 */
export const PanelPending = ({ label }: PanelPendingProps): ReactElement => (
  <div className="panel-pending" aria-busy="true">
    {label}
  </div>
);

export interface PanelEmptyProps {
  /** What is absent, and where useful, the next action that would fill it. */
  readonly message: string;
}

/**
 * There is nothing to show, and that is an ordinary answer.
 *
 * Plain content, no live semantics: an empty fleet is not an error and not an
 * event, it is the state the reader is looking at. Announcing it would put a
 * successful, expected result in the same channel as a failure.
 */
export const PanelEmpty = ({ message }: PanelEmptyProps): ReactElement => (
  <p className="panel-empty">{message}</p>
);

export interface PanelErrorProps {
  /** What failed, in the panel's own words — not a bare transport message. */
  readonly message: string;
  /** Omitted when re-running the same request is not a recourse worth offering. */
  readonly onRetry?: () => void;
}

/**
 * A request failed, said once, with a way out when one exists.
 *
 * `role="alert"` earns its announcement here: unlike the pending state, this
 * component mounts into a tree that is already on screen, so its text arrives
 * as a change and assistive technology reports it.
 *
 * The retry button is conditional rather than always present because a button
 * that cannot help is worse than no button (`error-handling.md`: degrade
 * honestly). Panels whose only retry would re-run an identical metered request
 * omit `onRetry` and let the reader's own controls — a range change, a
 * reselection — be the retry.
 */
export const PanelError = ({ message, onRetry }: PanelErrorProps): ReactElement => (
  <div className="panel-error" role="alert">
    <p className="panel-error-message">{message}</p>
    {onRetry === undefined ? null : (
      <button type="button" className="panel-retry" onClick={onRetry}>
        {RETRY_ACTION_LABEL}
      </button>
    )}
  </div>
);
