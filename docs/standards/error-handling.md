# Error-handling standards

**Trigger:** writing a `catch`, calling anything that can fail (network, AWS, parsing), or deciding what a failure should do.

## Rules

1. **Expected failures are values; unexpected failures are exceptions.** Outcomes that are part of a function's domain — site not found, forecast unavailable for horizon, Open-Meteo rate-limited — are returned as discriminated unions the caller must handle. `throw` is reserved for bugs and violated invariants, and those propagate to the process/request boundary — never caught mid-stack to "keep going".

2. **Never swallow.** Every `catch` either (a) converts to a typed expected-failure value, (b) adds context and rethrows, or (c) is the top-level boundary handler that logs and responds. A `catch` that logs-and-continues, or an empty `catch`, is a review blocker.

3. **External calls state their failure policy at the call site.** Timeout, retry count/backoff, and what happens on final failure are visible where the call is made (or in the adapter's config), not implicit in library defaults. Open-Meteo calls specifically must respect the rate-limit constraint in CLAUDE.md — backoff on 429, never hot-retry.

4. **Errors carry context.** What operation, on what entity (`siteId`, horizon, request id), caused by what. Structured logging at boundaries; no bare `console.log` in library code.

5. **Degrade honestly in the product.** A fleet aggregate computed while three sites failed to forecast says so — partial results are labeled partial, in the API response and the UI. Silently pretending completeness corrupts exactly the accuracy-tracking features this project is about.

## Why

This is a data pipeline fed by a rate-limited third-party API and displayed as accuracy metrics. The failure modes _are_ product features: an error swallowed in ingestion becomes a phantom accuracy problem in the dashboard that costs hours to trace back.
