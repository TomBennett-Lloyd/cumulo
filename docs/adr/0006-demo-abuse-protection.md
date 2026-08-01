# 0006 — Demo abuse and cost protection

- **Status:** accepted
- **Date:** 2026-08-01
- **Issue:** #29

## Context

Cumulo's `POST /v1/sites` is anonymous on purpose. ADR 0001 records the owner's decision that "the demo ships anonymous on purpose" — login friction would undermine the one interaction a portfolio reviewer actually performs — and defers auth to #30. #14 then shipped that endpoint to the public internet with its URL printed in a README, guarded by exactly one thing: stage-level throttling at 10 requests/second, burst 20. ADR 0005 named that boundary rather than hiding it: "#14 ships blunt stage-level throttling and nothing else. The site-cap counter transaction, per-IP rate limiting, eviction, auto-block, and the range-delete of a deleted site's series rows all belong to #29."

This is #29. It is the ticket that has to make an unauthenticated public write endpoint survivable under a ~$100/month ceiling and a 10,000-calls/day Open-Meteo quota, without buying anything that bills for existing.

**Two of the three problems are already solved on paper.** ADR 0002 designed the storage mechanics in advance and left them unimplemented: a counter item at (`FLEET`, `#META#counters`) updated inside a `TransactWriteItems` so the cap is enforced atomically rather than read-then-write; a **sparse** GSI2 `user-sites-by-age` whose key attributes are written only for `origin = user`, so — in 0002's words — "#29's 'never evict a seed site' becomes a property of the data model, not of the code path"; and a range delete on `cumulo-series` for an evicted site. This ADR does not redesign any of that. It decides the three things 0002 deliberately left open: **what the cap number is and why**, **how per-IP limiting is done at all given the gateway product we chose**, and **what "raise the effort needed to call the API programmatically" means concretely**.

### What the deployed system actually does under load

The design axis here is not "what would bound the bill" — the stage throttle already does — but **which layer bites first**, and that turned out not to be the layer anyone assumed. Measured during #14's deployed smoke (2026-08-01, recorded on issue #29):

- The account's Lambda concurrency limit is **10** — the new-account default, confirmed with `aws lambda get-account-settings`.
- A 40-parallel burst against the API returned **11×200 + 29×503, and zero 429s.** Lambda concurrency saturates before the gateway's burst-20 throttle can fire.

So the effective ceiling at high parallelism today is concurrency-10 → 503, not throttle → 429. Two consequences follow and both shape this decision. First, any 429-shaped design has to say honestly that it is not the outermost guard. Second — and this is the one that matters operationally — **the API and the ingestion function share that same 10-slot pool.** The ingestion schedule pins `maximum_retry_attempts = 0` with a 60-second maximum event age (`infra/ingestion/schedule.tf`), so a flood landing on the cycle minute drops the hour's cycle outright, and drops it silently: nothing in the platform reports it except the Lambda `AsyncEventsDropped` metric, which nothing was watching.

### The cost frame

Figures are AWS list prices, us-east-1, **verified 2026-08-01** against the DynamoDB on-demand, CloudWatch, AWS WAF and SNS pricing pages, on the same basis as ADRs 0002, 0004 and 0005 (Ireland runs roughly 10–15% higher; nothing below turns on that margin).

- **DynamoDB on-demand:** $0.625 per million write request units, $0.125 per million read request units. An eventually-consistent `GetItem` on an item under 4 KB is half a read request unit, so **$0.0625 per million such reads**. Storage: always-free 25 GB.
- **CloudWatch alarms:** **10 standard-resolution alarm metrics always free**, $0.10 per alarm metric per month beyond.
- **CloudWatch Logs:** 5 GB/month ingest always free, then $0.50/GB.
- **AWS WAF:** **$5.00 per web ACL per month, $1.00 per rule per month, $0.60 per million requests.** No free tier.
- **Amazon SNS:** a standard topic has no per-hour or per-topic charge; the always-free tier covers 1 million publishes and **1,000 email deliveries per month**, against an expected volume of a handful of alarm emails.

### Two capability facts, checked rather than assumed

Both were verified against the API Gateway developer guide's REST-versus-HTTP feature tables (`http-api-vs-rest`, retrieved 2026-08-01), because both are load-bearing rejections and both are commonly stated the other way round:

- **AWS WAF cannot be associated with an HTTP API.** The Security table reads: AWS WAF — REST API **Yes**, HTTP API **No**. WAF attaches to CloudFront distributions, Application Load Balancers, REST APIs, AppSync, Cognito user pools and a few others; an `aws_apigatewayv2_api` is not on the list. This is not a cost objection that could be overruled by spending money. The resource we deployed in #14 cannot take a web ACL at all.
- **Usage plans, API keys and per-client throttling are REST-only.** The API management table reads: API keys — REST **Yes**, HTTP **No**; per-client rate limiting — REST **Yes**, HTTP **No**; per-client usage throttling — REST **Yes**, HTTP **No**.

The issue asked for "API Gateway throttling/usage plans before reaching for WAF, which carries a monthly cost". The honest answer is that on an HTTP API neither of the cheap options exists, and the expensive one does not attach. **Per-IP limiting therefore has to be application-level state**, and the only question left is where that state lives.

## Decision

**Four layers, one of which we build; a cap of 40 user sites with oldest-first eviction; a per-IP limiter backed by an on-demand DynamoDB table; origin checking as friction, not authentication; and alarm notifications finally wired to an SNS topic. Standing cost stays $0.**

### 1. The four layers, and which one bites first

| Regime                                         | Layer that bites first                                               | What the caller sees                                       |
| ---------------------------------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------- |
| One IP, sustained, low parallelism             | **Per-IP application limiter** — 30 limited-route requests per 60 s  | 429 `rate_limited` with `retry-after`, then a 1-hour block |
| One IP, writes only                            | **Per-route gateway throttle** — 2 rps / burst 4 on the three writes | gateway 429 (gateway body), then the limiter's 429         |
| Many IPs, low parallelism                      | **Stage throttle** — 10 rps / burst 20 (shipped by #14)              | gateway 429; the bill stays inside ADR 0005's ≈ $36/month  |
| Any source, high parallelism (≳ 10 concurrent) | **Account Lambda concurrency, 10** — not ours, and not fixed here    | 503 — measured: 40-parallel → 11×200 + 29×503, zero 429s   |

Layers 2 and 3 are gateway configuration and reject traffic before it reaches compute, which is free. Layer 1 costs a DynamoDB round trip per limited request, which is why it is the innermost and why the routes it covers are chosen rather than universal. Layer 4 is an account quota that nobody chose; it is recorded here because it is the layer that actually fires first in the one regime an attacker would use, and pretending otherwise would make the other three read as stronger than they are.

At the stage ceiling a single IP crosses the limiter's 30-request threshold in about **three seconds**; on the write routes, held at 2 rps, in about fifteen. The block that follows lasts an hour.

**Which routes are limited.** The three writes (`POST /v1/sites`, `PUT /v1/sites/{siteId}`, `DELETE /v1/sites/{siteId}`) plus `GET /v1/sites/{siteId}/series`. The series range read is the expensive one ADR 0005 already identified — "a maximum-width `GET /v1/sites/{siteId}/series` over the 336-hour span cap reads on the order of a thousand small items, roughly 30 read units", against `cumulo-series`'s 21 provisioned RCU. `GET /v1/sites`, `GET /v1/sites/{siteId}/forecast` and the docs routes stay unlimited: Swagger UI's own page load is four or five requests (ADR 0005), and a limiter that breaks the showpiece page would be protecting the demo from its audience.

### 2. The cap: 40 user sites, and the arithmetic that picked the number

The seed fleet is 60 sites over 12 distinct weather locations (`packages/shared/src/fleet.ts` — "5 sites around each of the 12 cluster centres, 60 in total"). The cap is `MAX_USER_SITES`, currently **40**, declared in `packages/shared/src/site.ts`. Worst case is every user site at a distinct location:

- **Sites:** 60 + 40 = **100** — exactly ADR 0002's fleet-headroom row: 14% of the free 25 WCU, a 693-second ingest drain with zero burst assumed, 25 sustained dashboard loads/minute at 21 RCU. The cap was chosen to land on a row that document already costed rather than on a round number.
- **Locations per cycle:** 12 + 40 = **52**, against `MAX_LOCATIONS_PER_CYCLE` (100, `apps/ingestion/src/cycle-budget.ts`) — no deferrals, with roughly half the budget unspent.
- **Open-Meteo calls:** 52 locations × 24 hourly cycles = **1,248 calls/day against the free tier's 10,000**. 12.5%.

That last line is the hard constraint CLAUDE.md names, and it is worth being precise about why a burst cannot touch it directly: **the API makes zero Open-Meteo calls on any path** (ADR 0005). The only route from the public write endpoint to the weather quota is fleet growth, and the cap is what bounds fleet growth. An attacker can cost us gateway requests, bounded above; they cannot cost us weather quota beyond the 1,248/day this cap fixes.

**Eviction is oldest-user-site-first and structurally cannot touch the seed fleet**, because GSI2 `user-sites-by-age` is sparse over `origin = user` (ADR 0002). A create at the cap queries that index ascending with `Limit: 1`, then performs one transaction that deletes the oldest and puts the new site — the counter is untouched, because the net user count did not change. A lost race (someone else evicted the same site first) is a condition failure on the delete and retries, bounded at three attempts before returning 500. The evicted site's series rows are then range-deleted best-effort; a failure logs `api.site.series-cleanup-failed` and still returns 201, because the new site genuinely exists and orphaned series expire on the existing 90-day TTL.

### 3. The per-IP limiter: an on-demand DynamoDB table

A fifth table, `cumulo-abuse-<env>`, single hash key, TTL on `expiresAt`, **on-demand** — per ADR 0002's standing rule, "a new table defaults to on-demand unless its load is batch-shaped", and nothing is less batch-shaped than the arrival rate of whoever is attacking you. It holds two item shapes: a per-(IP, 60-second-window) counter, and a block record. Both expire by TTL; nothing accumulates.

**The identity being limited is `requestContext.http.sourceIp` — the direct TCP peer**, which today is the visitor because nothing sits between them and the gateway. That "today" is load-bearing and is picked up as a consequence below.

The policy numbers live in `apps/api/src/abuse/ip-limiter.ts` as `MAX_LIMITED_REQUESTS_PER_WINDOW` (**30**), `RATE_WINDOW_SECONDS` (**60**), and `BLOCK_SECONDS` (**3600** — one hour). Crossing the threshold writes a block record and denies with 429 `rate_limited` plus a `retry-after` header. A container-scoped `Map` caches **block expiries, never verdicts**, so a blocked IP is denied with no I/O at all while a not-yet-blocked one always consults the table.

Three properties of that design are deliberate and are the parts a reader should push on:

- **Fixed windows, not sliding.** A caller straddling a window boundary can land up to 2× the limit in 60 wall-clock seconds. Accepted: this is friction with a documented threshold, not an invariant, and a sliding window costs more state per request to buy precision nobody is relying on.
- **Fail closed.** If the abuse table is unavailable, the limited routes 500 rather than waving traffic through. Failing open would mean a DynamoDB throttle silently disables abuse protection at exactly the moment abuse is likely.
- **The block cache is what makes the cost collapse.** Sustained single-IP abuse pays for roughly 30 table round trips and then costs essentially nothing, because every subsequent request is denied from memory. The worst-case bill below is therefore a **distributed** attacker's bill, not a single one's.

### 4. Origin friction, and what it deliberately does not defend against

The three write routes require an `Origin` header matching the API's own origin or one of the configured browser origins (`CUMULO_WEB_ORIGINS`, populated by #144's CloudFront URL and #21's custom domain — never hard-coded). A mismatch or absence is 403 `forbidden`.

**What this buys:** drive-by scripts and naive `curl` loops fail without anyone noticing they needed a header, and a browser on another origin cannot forge one — `Origin` is a forbidden header name that page JavaScript may not set.

**What it explicitly does not buy, stated because it will otherwise read as security:** any non-browser client that sets the header passes. One `curl` flag defeats it entirely. It raises the effort needed to script the API from zero to one line, which is precisely what the issue asked for — "raise the effort needed to call the API programmatically … not CAPTCHA-grade friction" — and nothing more. It is not authentication; #30 owns authentication. **There is no CAPTCHA and no proof-of-work**, by the owner's decision (2026-07-30): the demo's entire value is that a reviewer can add a site in one click, and a challenge on that path costs more than the abuse it prevents. A third-party CAPTCHA script would also put unreviewed executable code in the runtime path of the demo, which ADR 0005 rejected on its own terms when it rejected CDN-hosted Swagger assets.

### 5. The backstops: alarm notifications and the budget

Every `alarms.tf` in this repo currently ends with a variant of the same paragraph — "No `alarm_actions` … there is nowhere to send them yet. Notification wiring (SNS topic, subscriptions) arrives with #29." This is that arrival. A new `infra/alerting` stack owns one standard SNS topic, `cumulo-alerts-<environment>`, with an email subscription whose address comes from the operator-created SSM parameter `/cumulo/notification-email` (the same data source and the same out-of-git handling as `infra/bootstrap/budget.tf`). Every existing alarm gains `alarm_actions` and `ok_actions`. One new alarm watches Lambda `AsyncEventsDropped` on the ingestion function — the metric that makes the starvation path from §"What the deployed system actually does under load" visible instead of silent.

The money backstop is unchanged and is the existing budget in `infra/bootstrap/budget.tf`: a $100 limit with ACTUAL notifications at 50%, 80% and 100% plus a FORECASTED notification at 100%, emailing the operator directly with no subscription confirmation needed.

One honest observation about that backstop, since `infra/api/alarms.tf` already made the opposite one. It notes that the budget's first threshold — 50% of ~$100 — "under ADR 0005's ≈ $36 worst case … would never fire at all". With this ticket's abuse table added, sustained worst-case abuse reaches ≈ $54/month (below), which **does** cross $50 — but only after roughly four weeks at the ceiling. The budget is a backstop that arrives late by construction; the `cumulo-api-<env>-request-flood` alarm (six requests/second averaged over five minutes) remains the fast signal, and this ADR does not change either threshold.

### 6. The alarm budget, settled (#126)

Issue #126 exists because the always-free ten CloudWatch alarms had been spent to eight with nobody owning the allowance. This ticket claims the tenth and closes the question:

**The allocation is storage 4, ingestion 3, api 2, forecast 1 — exactly the always-free 10.** The eleventh alarm bills $0.10/month, which is not a lot of money and is entirely beside the point: the rule is that **any PR adding an alarm must say so in its description and update the infra cost tables**, so that "$0.00/mo" in `infra/README.md` stays a true statement rather than a decoration. The per-stack counts and the rule live in that README's "CloudWatch alarm budget" subsection, which is their owner of record; the count above is what this plan settles on (forecast's alarm arrives with #136, in flight as this is written).

### Where each number actually lives

This document quotes; it does not own. Per `docs/adr/README.md`'s amendment convention, a value that legitimately moves later is trued up inline here with a dated `## Amendments` entry, while the reasoning above stays immutable.

| Value                                    | Owned by                                                        |
| ---------------------------------------- | --------------------------------------------------------------- |
| `MAX_USER_SITES` = 40                    | `packages/shared/src/site.ts`                                   |
| 30 requests / 60 s window / 3600 s block | `apps/api/src/abuse/ip-limiter.ts`                              |
| Per-route write throttle 2 rps / burst 4 | `infra/api/gateway.tf` (stage `route_settings`)                 |
| Stage throttle 10 rps / burst 20         | `infra/api/gateway.tf` (`default_route_settings`, ADR 0005)     |
| `MAX_LOCATIONS_PER_CYCLE` = 100          | `apps/ingestion/src/cycle-budget.ts`                            |
| Budget limit and thresholds              | `infra/bootstrap/budget.tf`                                     |
| Alarm allocation                         | `infra/README.md`, "CloudWatch alarm budget"                    |
| Account Lambda concurrency = 10          | the AWS account quota — nowhere in this repo, which is the risk |

None of these is a code-to-Terraform mirror in the sense of architecture rule 8, so none is declarable to `check:infra-mirrors`: the limiter constants exist only in code, the throttles only in Terraform, and the cap is sized against a quota AWS owns. **This document is the only place they all appear together**, which is exactly why the amendment convention matters here more than it does for an ADR whose numbers are decorative.

## Options considered

### A. Per-IP limiting in the application, on an on-demand DynamoDB table — chosen

$0 standing. Works on the gateway product already deployed. Reuses the storage adapter pattern, the error vocabulary, and the IAM idiom the platform already has, so the whole layer is one table and one class.

Genuine downsides, none of them small:

- **It bills per limited request** — one write and one eventually-consistent read — where a gateway-side limiter would reject traffic before compute. This is the cost line the worst-case table below is dominated by.
- **It runs inside the thing it protects.** The limiter's own work consumes an invocation from the same 10-slot concurrency pool the flood is exhausting. It cannot help with layer 4 and it slightly worsens it.
- **Latency on every limited request**, single-digit milliseconds against a table in the same Region, on paths that already do one or more DynamoDB calls.
- **Fixed windows admit up to 2×**, and **failing closed converts an abuse-table outage into a 500 on four routes.** Both stated above as deliberate; both are real.
- **IP is a weak identity.** Callers behind one NAT share a limit, and an attacker with a pool of addresses gets a fresh budget per address. This is true of every IP-based scheme including WAF's, but it is worth writing down that the mechanism the issue asked for is inherently approximate.

### B. AWS WAF rate-based rules — rejected, and not on price first

This is the option the issue named as the expensive fallback, and it is genuinely the better product: managed IP reputation lists, rate-based rules evaluated at the edge before any compute runs, and real handling of distributed abuse rather than per-address counting.

It is rejected because **it does not attach to what we deployed.** Verified above against the developer guide: AWS WAF is REST-API-only among API Gateway products. Reaching it requires either putting CloudFront in front of the HTTP API or migrating to a REST API — and ADR 0005 already costed that migration at a 3.5× per-request premium and rejected it.

The price is the second objection rather than the first, and it is still disqualifying on its own terms: **$5.00/web ACL + $1.00/rule ≈ $6/month standing**, plus $0.60 per million requests — which at the 25.92M worst case adds a further $15.55. ADR 0004 got the platform's standing cost to exactly $0 and wrote "no resource in Cumulo bills for existing"; a web ACL would be the first resource to break that sentence, in exchange for protection on a demo that is idle almost all of the time. **This is the upgrade path, not a permanent no** — see revisit trigger 2.

### C. API Gateway usage plans and API keys — rejected, unavailable

Verified above: API keys, per-client rate limiting and per-client usage throttling are all REST-only. Even on a REST API they would be the wrong shape here, for the reason ADR 0005 already gave when it rejected REST: "usage plans and API keys presume identified clients. The demo is anonymous on purpose (0001), and #30 owns the auth question." An anonymous demo has no keys to plan usage for.

### D. Pure in-memory per-IP limiting — rejected, but kept as a cache

Free, zero latency, no table, no IAM. The reason it cannot be the mechanism is that **Lambda execution environments are created and destroyed at AWS's discretion**: every cold container starts with an empty map, so a counter resets whenever the platform scales out or recycles an environment. That makes it least reliable exactly when it matters — a flood is the event that causes scale-out — and an attacker does not need to know any of this to defeat it.

It survives in a narrower role, which is the honest version of the idea: the limiter caches **block expiries** in a container-scoped map, so a known-blocked IP is denied without I/O. A cold container simply pays one read to rediscover the block. The cache can never manufacture a block it did not read, and it stores an expiry rather than a verdict, so a stale entry ages out by comparison rather than by trust.

### E. CAPTCHA or proof-of-work on the write path — rejected by the owner

The issue is explicit: "not CAPTCHA-grade friction". Recorded as an option because it is the obvious answer to "raise the effort needed to call the API programmatically" and because its rejection is a product decision rather than a technical one — the demo's value is a one-click add-a-site, and a challenge sits directly on that click. A hosted CAPTCHA would additionally load third-party executable code into the demo's most important page, which is the exact shape ADR 0005 rejected for Swagger assets.

### F. Reserved concurrency on the API function as a rate cap — rejected

ADR 0005 dismantled this for function URLs: 10 × reserved concurrency welds the request rate to the concurrency, and "rate and concurrency are different quantities and this system wants them different". Here it is worse. Reserving concurrency out of a **10-slot account pool** takes those slots away from ingestion permanently, so the mechanism intended to stop a flood starving the hourly cycle would starve it by configuration instead. The right fix for layer 4 is a quota increase (free, account-level, the owner's call — filed as a separate issue), not a reservation.

### G. Keep #14's stage throttle and add nothing — rejected

Worth stating because it is not absurd: the stage throttle already bounds the bill at ≈ $36/month, and the expected regime is a few hundred demo sessions. What it does not bound is **the fleet** — nothing stops a patient script adding sites one per second for an hour and pushing the location count past `MAX_LOCATIONS_PER_CYCLE`, at which point the Open-Meteo quota, the hard constraint in CLAUDE.md, is the thing under pressure rather than the bill. The cap, not the limiter, is the part of this ticket that protects the constraint the project actually cannot violate.

## Consequences

### The worst-case bill, computed

The stage throttle held at its ceiling continuously for a 30-day month is `10 × 2,592,000 = 25.92M` requests (ADR 0005). Assume the pathological case: every one of them lands on a limited route, from enough distinct IPs that the block cache never helps.

| Line                                              | Arithmetic                   | $/month   |
| ------------------------------------------------- | ---------------------------- | --------- |
| Gateway + Lambda + logs at the ceiling (ADR 0005) | 25.92M requests              | ≈ 36.00   |
| Abuse-table writes (one per limited request)      | 25.92M × $0.625/M            | 16.20     |
| Abuse-table reads (one eventually-consistent get) | 25.92M × $0.0625/M           | 1.62      |
| Abuse-table storage                               | TTL'd within the hour        | ~0        |
| SNS, alarms                                       | inside the always-free tiers | 0.00      |
| **Worst case, sustained, distributed**            |                              | **≈ $54** |

**Roughly half the ~$100 ceiling, under continuous distributed abuse, forever** — up from ADR 0005's ≈ $36, and the increase is entirely the price of knowing who is calling. Single-IP abuse costs a few cents, because the block cache serves the denial. At the expected regime the abuse table bills fractions of a cent and the whole platform still rounds to about one cent a month.

**Standing cost stays $0.** The abuse table is on-demand and bills only for requests; the SNS topic has no per-topic charge; the alarms are held at exactly the always-free ten. ADR 0004's headline — no resource in Cumulo bills for existing — survives this ticket, which is the single strongest reason WAF was not bought.

### What becomes easier

The Open-Meteo quota is now bounded twice over, structurally: the API makes no upstream calls at all, and fleet growth is capped at 100 sites / 52 locations / 1,248 calls per day. #21 can expose the demo publicly, which is what it was blocked on. Alarms have somewhere to go, so every alarm the platform has written since #13 becomes a notification rather than a console state. And the ingestion starvation path that the #14 smoke discovered has a metric watching it.

### What becomes harder, and what we are accepting

- **Eviction is destructive and silent.** A visitor's site can disappear because someone else added one. There is no owner to notify — that is what anonymous means — and the alternative (rejecting creates at the cap) makes the demo break for the 101st visitor instead of the first. The seed fleet is exempt structurally, so the failure is bounded to user-created data.
- **Orphaned series rows are possible.** Cleanup is best-effort by design; failures are logged, and the 90-day TTL is the sweeper. ADR 0002 predicted exactly this: "nothing prevents series items outliving a deleted site … orphans are prevented by discipline and TTL rather than by a foreign key."
- **The counter can drift from GSI2.** It is an application-level invariant, as 0002 said it would be — "correct, but it is ours to keep correct". Reconciliation is a `Select=COUNT` query on the index, run once at deploy; a scheduled reconciler is deliberately not built unless drift recurs for a reason a one-off fix does not explain.
- **A fifth table and a fifth stack.** One more resource in the teardown path and one more IAM surface. Both destroy cleanly and neither bills idle, which is the same answer ADR 0004 gave.
- **Denial of service is still not solved.** ADR 0005 was blunt that its throttle "is a cost control that looks like an abuse control", and this ticket narrows the gap without closing it: one IP can no longer 429 everybody else, but a distributed flood still saturates 10 concurrent executions and 503s legitimate visitors — and can still drop an ingestion cycle. That is now alarmed rather than fixed, and fixing it is an account-quota decision, not a code one.
- **The limiter's identity is only valid while nothing proxies the API, and getting that wrong is a self-inflicted outage.** `sourceIp` is the direct TCP peer. Put any reverse proxy in front — a CloudFront distribution, most obviously — and every visitor on Earth collapses onto the handful of addresses belonging to their nearest edge POP. The limiter would then be counting **the POP, not the person**: 30 requests spread across _all_ visitors sharing that edge, inside one 60-second window, blocks the POP for an hour and takes the demo down for everyone behind it. The block cache makes the outage cheap to sustain and invisible in the abuse table, because after the first denial no request touches storage at all. This is worse than the abuse it defends against, and it is triggered by a routine infrastructure change rather than by an attacker.

  **The distinction that makes #144 safe and a naive #21 not.** #144's shape is CloudFront serving the static SPA while **the browser calls the API directly** — two origins, nothing proxied, `sourceIp` still the visitor. That is safe as designed and needs nothing from this ADR beyond the origin allow-list. What is _not_ safe is putting a distribution **in front of the API itself** to get one hostname — the obvious-looking way to implement #21's custom domain, and the same move that would make WAF attachable. Before any distribution fronts this API, the limiter's identity source must move to the leftmost-untrusted hop of `x-forwarded-for` with an explicitly stated trust boundary (how many trailing hops are ours and therefore strippable), because a naive left-most read of that header is attacker-controlled and a naive right-most read is the proxy again. HTTP APIs support custom domain names natively (ADR 0005), so #21 has a route to a real hostname that never introduces the problem — taking it is the cheaper answer than fixing the limiter.

### What would make us revisit

ADRs are immutable: any change supersedes this one with a new ADR and never edits it (values that move are amended per `docs/adr/README.md`, reasoning is not). Concrete triggers:

1. **`cumulo-api-<env>-request-flood` or the ingestion `AsyncEventsDropped` alarm firing repeatedly.** Sustained or distributed abuse is the regime this design handles worst, and the answer is an edge layer, not a tighter application limiter.
2. **Any reverse proxy appearing in front of the API** — a CloudFront distribution fronting the API itself, as opposed to #144's distribution fronting only the static SPA. This trigger has two halves and the second is a **prerequisite, not a consequence**:
   - _The opportunity._ It is the moment WAF becomes attachable, and the documented upgrade path from trigger 1: re-cost $5.00/ACL + $1.00/rule + $0.60/M against the traffic actually seen, and move rate limiting to the edge where it costs no invocations.
   - _The obligation._ `sourceIp` stops identifying the visitor the instant that distribution exists, so the limiter must move to the leftmost-untrusted hop of `x-forwarded-for` with a stated trust boundary **in the same change**, or the origin check and limiter must be lifted to the edge entirely. Shipping the distribution first blocks an edge POP for an hour on 30 aggregate requests, per the consequence above. If the goal is only a nicer hostname for #21, HTTP APIs take custom domains natively and no proxy is needed.
3. **#30 choosing keyed auth.** Identified callers make usage plans meaningful — available only by migrating to a REST API, which is already ADR 0005's own revisit trigger 1 — and turn a fleet-wide cap into a per-caller one.
4. **The cap binding on real visitors rather than on an attacker.** Steady eviction churn among genuine users means 40 is the wrong number; raise it against the location arithmetic in §2, never by feel, because the 10,000-calls/day quota is what the arithmetic is protecting.
5. **The account Lambda concurrency quota moving.** A granted increase changes which layer bites first — the fourth row of the table becomes a gateway 429 instead of a 503 — and makes the measured facts in this document historical.
6. **The abuse table becoming a visible cost line**, which is the signal that abuse is distributed enough for the block cache never to help, and therefore the same signal as trigger 1 arriving through the bill instead of an alarm.
7. **The fixed-window 2× boundary being exploited in practice**, which buys a sliding window or a token bucket in the same table — a change of algorithm, not of architecture.
