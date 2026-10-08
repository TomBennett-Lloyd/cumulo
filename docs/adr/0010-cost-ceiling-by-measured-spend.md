# 0010 — The cost ceiling is held by measured spend, not by the stage throttle

- **Status:** accepted
- **Date:** 2026-10-07
- **Issue:** #588

**Supersedes ADR 0005 in part**: the Decision's stage-throttling bullet where it says "This is the cost guard", and the Consequence "Worst-case spend is now a computed number rather than an assumption" — that is, the stage throttle's role as the bound on the bill. The hosting decision, the throttle's existence and its values, and everything else in 0005 stand. ADR 0006, which computes its own worst case on top of 0005's, is annotated rather than superseded: its four layers stand.

## Context

ADR 0005 bounded the bill with arithmetic: the stage throttle (10 requests/second, burst 20) held continuously for a 30-day month is 25.92M requests, which 0005's Consequences priced at ≈ $39/month — "roughly a third of the ~$100/month ceiling, sustained, under continuous abuse, forever". The bound priced gateway requests, Lambda requests and compute, and log ingestion. It carried no DynamoDB term, because when it was written every table sat inside provisioned free capacity and a read flood surfaced as throttling rather than as a bill.

That premise went with ADR 0002's amendments (#156, #258), which moved every table to on-demand. #200 stated the bound's scope instead of re-deriving it, and #375 was filed to re-derive it. #322 then found that the throttle was guarded by nothing mechanical any more. Both issues close into this one, and their evidence stands.

Re-derived honestly, the throttle no longer bounds anything near the ceiling. The most expensive request that exists today is `GET /v1/fleet/actuals?hours=168` at the 100-site fleet. It fans out one Query per site, ≈ 300 eventually-consistent read units, and with the per-IP limiter's window write, the gateway, Lambda and log terms it costs ≈ $44.68 per million before compute. How fast that request can be served is bounded twice:

- by the stage, at 10 a second;
- by the account's 10-slot Lambda concurrency pool (ADR 0006, measured) at 10 ÷ its duration in seconds.

The most the platform can spend in an hour is therefore

> H = min(10, 10 ÷ d) × 3,600 × (44.68 + 4.1667 × d) ÷ 1,000,000 dollars, for a heavy request lasting d seconds at 256 MB,

which peaks at **≈ $1.76/hour** when d ≈ 1 s. Sustained, that is ≈ $1,270/month. To fit $100 under the throttle alone, the stage would have to sit near 0.8 requests/second. A single dashboard load is three requests and the Swagger page is four or five, so that would throttle real visitors to stop an attacker.

The owner's decision (chat, 2026-10-07), in their words: "having the throttle at the top end … alarms based on the rate of change in request patterns and also total requests but no physical block until we're nearing the limit", and, on tripping sooner, "what about if we had the anomaly alarm and burn rate for a whole day?" — "yeah that sounds like a good plan lets do that".

## Decision

**The stage throttle stays where it is and becomes a capacity cap. The ceiling is held by alarms on measured cost that throttle the stage to zero, and only a person resets it.** All of it lives in `infra/api/cost-guard.tf`, which owns every figure below. This document records the decision and the bound, and restates the figures only where the bound needs them.

- **The throttle.** It stays at 10/20 on the stage and 2/4 on the three writes. It is now sized to what the function can serve: the 10-slot pool at about a second per heavy request. Above that, the gateway would only be forwarding requests the function would 503 anyway. It no longer bounds the month. It remains a premise of the bound below through one term, so it is not free to raise.
- **The worst case per request** is the cost of the request the alarms price. By owner decision (2026-10-07) that is the maximum-width series read, ≈ 30 read units, **on the premise that #506 lands**. #506 serves fleet actuals from the `#FLEET` roll-up instead of fanning out per site. Lambda compute is priced at 200 ms: the measured 54 ms warm p50 of the one single-Query route anyone has measured (#473), plus a stated margin for the series read's larger response. The owner asked for "slightly above its measured time". The figure comes to ≈ $7.31 per million requests. **It is not the heaviest request even after #506.** At the 52-location ceiling, the roll-up's 168-hour actuals read is ≈ 320 read units (≈ 270 when written; see `## Amendments`) and `GET /v1/fleet/forecast` is ≈ 78. Traffic concentrated on those routes is under-counted by the projection, and the billing trip below is what catches it. The bound does not use this figure.
- **Three projections and one composite.** All are in eu-west-1 and all read the API's hourly request `Count`:
  1. An **anomaly** alarm on a band two standard deviations wide. It emails within the hour and trips nothing. A second copy of it is held for 20 of 24 hourly datapoints and has no actions of its own.
  2. A **burn-rate** alarm. It prices each hour's requests at the worst case and projects them over a 720-hour month. It is in ALARM above $100, held for 20 of 24 hourly datapoints, and has no actions of its own.
  3. A **composite**: `ALARM(anomaly-held) AND ALARM(burn-rate)`. Its actions are the trip function and the platform alerts topic.

  A composite alarm carries no hold of its own, so the hold is on each child. Two 20-of-24 holds guarantee at least 16 hours in which both conditions were true together. 24 hours of one-hour periods is the owner's choice; CloudWatch permits up to seven days at this period.

- **Actual spend.** An alarm on `AWS/Billing EstimatedCharges` above **$70** (Maximum, 6-hour period, 1 of 1). Billing metrics exist only in us-east-1, so this alarm lives there under a provider alias. A composite reads alarms only in its own Region, so this is not a third clause in the composite's rule. It is a second path to the same function: a us-east-1 topic delivering cross-Region to the eu-west-1 trip, with an email subscription beside it. The threshold was $80 in the issue. The bound below is why it is $70.
- **The trip** is one function (`apps/api/src/cost-trip`, its own bundle). It sends one `UpdateStage` that sets the stage's default throttle and every write-route override to zero. The overrides have to go too, because they outrank the default, so a default-only trip would leave the writes open. It trips on any invocation, so its two invoke permissions are its guard. Its role holds `apigateway:PATCH` on this one stage, plus writes to its own log group, and nothing else. It sits outside the CI deploy grant, so it changes only through an apply.
- **Reset is manual.** The throttle is written back from the api stack's state, the values `gateway.tf` last applied, so no figure is retyped and nothing is deployed. After a billing-leg trip the billing alarm is forced to OK, so that it trips again while spend is still above the threshold rather than sitting silently in ALARM. After a composite trip nothing is forced: an M-of-N alarm forced to OK re-reads the same window and trips again, so the projections are left to return to OK on their own once their window ages. An automatic month-start reset would let an attacker spend the trip threshold every month. The runbook in `infra/README.md` owns the commands. One consequence follows: an apply restores the same values, so any apply of the stack undoes a trip, and the runbook's plan readback says so.

## Options considered

- **Lower the stage throttle until the month fits.** Rejected. That is ≈ 0.8 requests/second (Context). It would throttle the demo's own pages for every real visitor, and the bound would still be one apply away from gone, which was #322's finding.
- **AWS WAF rate-based rules.** Rejected again, on ADR 0006's grounds: a standing charge for every month the demo idles, for protection it needs on almost none of them.
- **An AWS Budgets action.** Rejected. Budgets can attach an IAM or SCP policy or stop instances. None of those stops anonymous traffic reaching a public gateway.
- **Trip by reserved concurrency 0 on the API function.** This works, and ADR 0005 noted it as a good emergency stop. Rejected in favour of the stage: at zero the stage rejects at the gateway, before compute or storage, whereas a concurrency-zero function still has every request reach the gateway, be billed there, and come back a 5xx.
- **The billing alarm alone.** Viable, because the bound below rests on it. Rejected as the only signal: it reacts in hours to half a day after the money has been spent. The composite trips a sustained, anomalous flood within a day of it starting, whatever the month's spend so far.
- **Chosen**: the composite plus the billing trip.

## Consequences

**The bound.** After the billing trip, the month's spend is the threshold, plus whatever accrues while the billing data catches up, plus the rest of the month's baseline:

> $70 + 12 h × H + baseline ≲ $70 + $21 + $3 ≈ **$94**

_(As it stood when written. See `## Amendments`, 2026-10-08.)_

- 12 h is the upper end of the 8–12 h the owner's design assumed for billing data to report and the alarm to evaluate.
- H ≈ $1.76/h is today's peak (Context). After #506 the peak request is the roll-up's ≈ 270-unit read, and H ≈ $1.61/h. _(≈ 270 and ≈ $1.61/h as they stood when written. See `## Amendments`, 2026-10-08.)_
- The baseline is the platform's own month: alarms, scheduled writes and stored bytes, a few dollars at most (`infra/README.md`, Cost).

The composite does not enter this arithmetic. It only ends an episode sooner: at most ≈ 24 h × $1.76 ≈ $42 on its own path before it trips, inside a month that has not yet reached $70 _(as it stood when written; see `## Amendments`, 2026-10-08)_. An attacker who never satisfies the 20-of-24 hold — a day on, a pause, a day on — still meets the billing trip. So does one concentrated on the routes the projection under-counts. At the issue's $80 the same arithmetic gives ≈ $104, which is why the threshold moved.

**What the bound rests on**, stated so that changing one of them is a visible decision:

- the account's 10-slot concurrency quota;
- the stage throttle's 10 requests/second;
- no request costlier than ≈ 300 read units;
- billing data arriving within 12 hours.

**The trade-off accepted.** A genuine 24-hour burst that projects past $100 trips the demo. The email arrives with the trip, and the reset is a runbook step. That is preferred to a low ceiling that throttles real visitors for an attacker's sake. A billing-path trip holds for the rest of the calendar month unless the threshold is raised, because that is what an actual-spend line means.

**Running cost ≈ $1.30/month.** The always-free ten alarms were already spent (`infra/README.md`, alarm budget), so the five new ones bill at list:

- two anomaly alarms at $0.30 each;
- the burn-rate and billing alarms at $0.10 each;
- the composite at $0.50.

The trip function, its topic and its subscriptions cost nothing until a trip.

**This takes the platform further past its $0 standing cost, on purpose.** ADR 0004 established that nothing in Cumulo bills for existing outside an always-free allowance, and 0005 and 0006 each kept that true. #603's canary alarm, the eleventh, ended it first at $0.10 a month. The guard's alarms add ≈ $1.30 a month, which is what holding the ceiling by reaction costs. ADRs 0004, 0005 and 0006 carry as-it-stood notes and dated entries for the sentences that say otherwise.

**Operator obligations.** Billing alerts have to be enabled once. This is a billing-account preference, not a Terraform resource, so the runbook's prerequisite runs `aws billing update-billing-preferences` and reads it back. Until then the billing alarm sits in INSUFFICIENT_DATA and trips nothing. The us-east-1 email subscription needs confirming. A trip drill — invoke the function, see 429s, reset — is the acceptance test, and it is the only proof that a zero throttle on this HTTP API rejects every route. All three steps are in the api runbook.

**What gates stop doing.** `check-infra-mirrors.sh`'s `ts-lt` mode is retired. Its one record went with #296's fan-out, and the per-request cost has no TypeScript twin to mirror.

**What would make us revisit.** Supersede, never edit. Concrete triggers:

1. **The account's Lambda concurrency quota is raised** (ADR 0006's trigger 5). With the pool no longer binding, a 15-second heavy request at the stage's 10/second is ≈ $3.86/h, and 12 hours of billing lag is ≈ $46. The stage cap or the billing threshold must move before the quota does.
2. **A request costlier than ≈ 300 read units appears**, or the fleet's location ceiling rises.
3. **#506 lands without bounding its look-back.** This leaves the bound alone and the projection's under-count where it is. Bounding the roll-up's read is what would make the series read the heaviest request in fact rather than by decision.
4. **Billing data is observed arriving later than 12 hours**, or the anomaly model never trains on a metric that is absent while the API idles. In the second case only the billing trip is live, which the bound already assumes.
5. **A real visitor burst trips the demo.** At that point the hold, the projection or the threshold is re-weighed against the ceiling it buys.

## Amendments

- **2026-10-08 — the 168-hour roll-up actuals read ≈ 270 → ≈ 320 read units (#506, PR #624).**
  - **Why it moved.** The ≈ 270 priced the `#FLEET` item at its pre-#602 size. `infra/storage/tables.tf`'s `series` section owns the item size, ~300 B since #602, and that gives `168 × 52 × 300 B` ≈ 2.6 MB, ≈ 320 eventually-consistent units.
  - **Where it changed.** The Decision bullet, a carrier, is trued up inline. The Consequences H line, the bound, and the composite's "$70" sentence are premises, so they are annotated as-it-stood and not reworded.
  - **The moved values,** on this document's own formula, with C = units × $0.1415 + $2.23 and the peak at d ≈ 1 s:
    - **The roll-up read alone (≈ 320 units):** H ≈ $1.86/h, and the bound is $70 + $22 + $3 ≈ **$95**.
    - **A roll-up read followed by the fan-out fallback (≈ 320 + ≈ 300 ≈ 620 units).** This happens while #507 has not yet removed the fallback, and a visitor can force it by adding a site at a new location. It gives H ≈ $3.39/h, and the bound is $70 + $41 + $3 ≈ **$114**, past the ~$100 ceiling. On that path the composite's 24 h × H ≈ $81 also passes $70.

  **Revisit triggers 2 and 3 both fire.** For trigger 2, both reads above exceed the "≈ 300 read units" premise. For trigger 3, #506 lands with the 168-hour look-back still offered, as the owner decided on 2026-10-07 (#506 Q1). This entry records the values and redecides nothing. The response, whether to supersede, re-price, or bound the fallback, is the owner's, and it is tracked in [#630](https://github.com/TomBennett-Lloyd/cumulo/issues/630).

  **Quoter sweep: a floor, not a census.** Run 2026-10-08 with `git grep -nE '≈ ?(270|300|320|620)|about 320|\$9[0-9]|1\.(61|76|86)|heaviest (request|read)' -- docs infra apps packages`. Every hit was read. Trued up or cited in the same change:
  - the Decision bullet above;
  - `infra/api/cost-guard.tf`'s priced-request comment, which now cites this entry;
  - `infra/README.md`'s api cost note, whose "≈ $94" now cites this entry instead of restating it;
  - ADR 0009's #506 entry, which computes the same ≈ 320.

  Annotated as-it-stood: the Consequences H line, the bound, and the composite sentence. ADR 0010's Context figures (≈ 300, ≈ $1.76) are dated reasoning about the request that existed when it was written, and are owed nothing. `docs/review-feedback.md`'s entries are records.
