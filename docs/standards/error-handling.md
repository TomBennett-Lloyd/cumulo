# Error-handling standards

**Trigger:** writing a `catch`, calling anything that can fail (network, AWS, parsing), or deciding what a failure should do.

## Rules

1. **Expected failures are values; unexpected failures are exceptions.** Outcomes that are part of a function's domain — site not found, forecast unavailable for horizon, Open-Meteo rate-limited — are returned as discriminated unions the caller must handle. `throw` is reserved for bugs and violated invariants, and those propagate to the process/request boundary — never caught mid-stack to "keep going".

   **Who classifies, and where: the module that owns the input.** A failure reachable from inputs the module's own published schemas and types accept is an expected failure and must be a value — however deep inside the module it is detected, and however rare the input. Only states unreachable by construction throw: a violated invariant, wiring that could not have been assembled correctly. The test is "could a caller hand me this without breaking my published contract?", not "does this feel exceptional?" — the second question is answered by whoever happens to be holding the failure, which is why it produces a different verdict in every module.

   **The tiebreak is blame: who does the operator need to call?** When a failure can be argued either way, decide it by whose fault it is, and make the failure's type and message name that party. A caller bug reported as an infrastructure error sends someone to the wrong dashboard; a real outage reported as a caller bug sends them to the wrong repository. Classification exists to route the page, not to satisfy a taxonomy.

   **Process-boundary corollary: the transport may still be a throw.** Where the platform gives one failure channel — a Lambda invocation error is the only thing an alarm can see — an expected failure may be re-raised as a throw _at that boundary_, as the verdict rather than as a bug report. Classification governs the blame the message carries, not the mechanism that carries it. `apps/ingestion/src/handler.ts` throws `CycleFailedError` when a cycle's locations failed: per-location blame is already in the outcome log, and the throw is the summary verdict raised into the platform's only alarmable channel. `apps/forecast/src/consume-message.ts` is the same move one level down — the failure arrives as a value, the record boundary turns it into a `failed` outcome, and the queue's redrive into the alarmed DLQ is the operator signal (#136).

2. **Never swallow.** Every `catch` either (a) converts to a typed expected-failure value, (b) adds context and rethrows, or (c) is the top-level boundary handler that logs and responds. A `catch` that logs-and-continues, or an empty `catch`, is a review blocker.

   **Wrapper-boundary corollary: preconditions run before the `try`, not inside it.** A `catch` that translates everything within it into an infrastructure type will relabel any caller bug that wanders in, so precondition and invariant checks go ahead of it. `putArchiveDay` in `packages/storage/src/adapters/weather/weather-adapter.ts` hoists its checks to the loop head, outside `sending`, and an unusable retry policy there surfaces as the programming error it is; the batch drain paths reached the identical check _inside_ `sending`, and the same bad wiring surfaced as a `StorageError` blaming the table (#166). Same input, opposite verdict, decided by which side of a wrapper found it — so the wrapper, not the package, is the boundary that has to classify.

3. **External calls state their failure policy at the call site.** Timeout, retry count/backoff, and what happens on final failure are visible where the call is made (or in the adapter's config), not implicit in library defaults. Open-Meteo calls specifically must respect the rate-limit constraint in CLAUDE.md — backoff on 429, never hot-retry.

4. **Errors carry context.** What operation, on what entity (`siteId`, horizon, request id), caused by what. Structured logging at boundaries; no bare `console.log` in library code.

5. **Degrade honestly in the product.** A fleet aggregate computed while three sites failed to forecast says so — partial results are labeled partial, in the API response and the UI. Silently pretending completeness corrupts exactly the accuracy-tracking features this project is about.

## Worked examples

Two paths were classified by where the failure was detected rather than by whose fault it was, and were re-decided under rules 1 and 2 (#100):

- **An implausible forecast hour is a value.** `createPhysicsForecast` (`packages/forecast/src/physics-forecast.ts`) validates the forecast it builds against `forecastSchema`, and the bounds it can fail are reachable from inputs the package's published types accept — a steeply tilted site under a schema-valid extreme-irradiance hour. So implausibility is a domain outcome, returned as `{ status: 'implausible', … }`, and each caller picks its own policy from the same value: the live consumer fails the record and lets the redrive alarm (rule 1's process-boundary corollary), the hindcast replay skips the hour and reports it in the run's coverage rather than aborting the season.
- **A duplicate key or an unusable retry policy blames the caller, before anything is sent.** `packages/storage` refuses both ahead of `sending` on every batch entry point, with a plain `Error` naming the operation and the offending key — not a `StorageError`, which would point the operator at DynamoDB, and not a last-wins dedupe, which would swallow the bug outright (rule 2). A write is not a set question; only the read path dedupes.

## Why

This is a data pipeline fed by a rate-limited third-party API and displayed as accuracy metrics. The failure modes _are_ product features: an error swallowed in ingestion becomes a phantom accuracy problem in the dashboard that costs hours to trace back.
