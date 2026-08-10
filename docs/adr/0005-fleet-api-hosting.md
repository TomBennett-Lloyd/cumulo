# 0005 — Fleet API compute and hosting

- **Status:** accepted
- **Date:** 2026-07-31
- **Issue:** #14

## Context

ADR 0001 named the fleet API as one of Cumulo's four deployables — "runs on requests, from the public internet. Sites CRUD, per-site forecasts, fleet aggregates, an OpenAPI document generated from the `@cumulo/shared` zod schemas, and a hosted Swagger UI (#14)" — and assigned it its own infrastructure. Its Decision is explicit about who owns what:

> Each service ticket owns the Terraform for resources only that service uses: ingestion (#11) owns its schedule and its Kinesis stream; **fleet API (#14) owns its compute, gateway, and Swagger hosting**; web (#21) owns its bucket, CDN, certificate, and domain; forecast owns its triggers and compute.

**That ownership question is settled and this ADR does not reopen it.** It is restated because it is the reason this document exists at all: 0001 decided that #14 owns a compute, a gateway, and a Swagger host, and then said nothing whatever about what any of the three should _be_. The nouns were placeholders, exactly as "Kinesis stream" was a placeholder in the same sentence until ADR 0004 costed it and replaced it with a queue. This ADR fills in the three shapes before #14's Terraform commits to them.

The frame is ADR 0004's, deliberately. That document's Consequences open: "**The platform's total standing cost is now $0.** Not a rounding error and not 'cents' — no resource in Cumulo bills for existing." (quoted as 0004 stood when this was written; that headline was amended 2026-08-10 to read "outside an always-free allowance" — see ADR 0004's Amendments). Four DynamoDB tables sit inside the always-free provisioned allowance (0002), Lambda invocations sit inside the always-free tier (0001), and the transport is a queue whose ~675,000 requests/month sit inside the always-free million (0004). This is the first ticket since that sentence was written that provisions a new always-on, internet-facing resource. **The question this ADR answers is therefore not "what would work" — several options would — but "which of them can be added without being the resource that breaks $0."**

### The traffic, and why it is bimodal

Two regimes matter, and they are three orders of magnitude apart.

**The expected regime is a portfolio demo.** A reviewer opens the web app, loads a fleet view, adds a site, and watches #17's poll run for its ~60-second budget; some fraction of them open `/docs` and press "try it out". Call a session 30–60 requests including Swagger UI's static assets. Even at a few hundred sessions a month that is **order 10,000 requests/month**, which is inside every free allowance in this document and rounds to zero under every option. **No option can be chosen on the expected regime, because the expected regime is free everywhere.**

**The regime that decides is the abusive one.** The write endpoint is unauthenticated by design — 0001 records the owner's decision that "the demo ships anonymous on purpose", with auth deferred to #30 — and it is on the public internet with its URL printed in a README. What bounds the bill when someone points a load generator at it is not the expected traffic; it is whatever rate ceiling the hosting choice makes available. So the axis this ADR turns on is **the pair (standing cost, worst-case bounded cost)**, and the second term is a property of the gateway, not of the code.

### The cost frame

Figures are AWS list prices, us-east-1, **verified 2026-07-31** against the API Gateway, Lambda, Elastic Load Balancing and CloudWatch pricing pages, on the same basis as ADRs 0002 and 0004 (Ireland runs roughly 10–15% higher; nothing here turns on that margin). Values amended 2026-08-10 to the eu-west-1 basis are marked inline and recorded under Amendments; any figure not so marked remains on the us-east-1 basis stated here.

- **API Gateway HTTP API:** $1.11 per million requests for the first 300 million/month, $1.00 per million above (amended 2026-08-10 to the eu-west-1 rates; see Amendments).
- **API Gateway REST API:** $3.50 per million for the first 333 million/month.
- **Lambda:** free tier of **one million requests and 400,000 GB-seconds per month**, which is _always_ free and does not expire at the end of the twelve-month term; beyond it, $0.20 per million requests and $0.0000166667 per GB-second (x86).
- **Application Load Balancer:** $0.0225 per ALB-hour plus $0.008 per LCU-hour. No always-free tier.
- **CloudWatch Logs:** $0.57 per GB ingested (amended 2026-08-10 to the eu-west-1 rate; see Amendments), $0.03 per GB-month archived, against an always-free 5 GB/month.

API Gateway does have a free tier — "one million API calls received for HTTP APIs … per month for up to 12 months" — but it is a **twelve-month, new-account** allowance, and **this ADR does not lean on it.** Every figure below is quoted at list price with that tier assumed absent. A cost claim that rests on an expiring allowance expires with it, and the account's age is not a fact this document should have to know. The always-free Lambda and CloudWatch allowances are used, because they do not expire.

## Decision

**The fleet API is a single Node.js Lambda behind an API Gateway HTTP API, and the Swagger UI is served by that same Lambda from bundled, version-pinned `swagger-ui-dist` assets.**

Concretely, and owned by #14's Terraform per ADR 0001:

- One function, `cumulo-api-dev`, `nodejs22.x`, an esbuild bundle, with an explicit log group at 30-day retention.
- One `aws_apigatewayv2_api` (protocol HTTP), an `AWS_PROXY` integration at payload format version 2.0, and a `$default` stage with `auto_deploy`.
- **Stage-level throttling on that stage: rate 10 requests/second, burst 20.** This is the cost guard, and it is the whole of the abuse posture #14 ships.
- No S3 bucket, no CloudFront distribution, no VPC, no load balancer, and no second deployable. The docs, the OpenAPI document and the API are one artefact with one lifecycle.

**The #29 boundary is drawn here explicitly.** #14 ships blunt stage-level throttling and nothing else. The site-cap counter transaction, per-IP rate limiting, eviction, auto-block, and the range-delete of a deleted site's series rows all belong to #29. A consequence of that split, stated plainly because it will look like an oversight otherwise: 429 responses are generated by the gateway and carry the gateway's own body, not the `apiErrorSchema` shape every other error uses. Clients map on status code, not on body.

**The API makes zero Open-Meteo calls.** Every endpoint reads stored rows through the ADR 0002 adapters; weather attribution travels as stored provenance on `forecastSchema` plus a payload-level `attribution` object. This is a property of the hosting decision and not merely of the handlers: it means the public, unauthenticated surface cannot be turned into a lever on the 10,000-calls/day Open-Meteo quota that CLAUDE.md makes a hard constraint. An attacker can cost us API Gateway requests, bounded above; they cannot cost us the fleet's weather data.

## Options considered

Standing cost is what the resource charges for existing. Marginal cost is per million requests, at list price, with the twelve-month gateway tier assumed absent and Lambda's always-free allowances assumed present.

| Option                                        | Standing $/month                        | Marginal $ per 1M requests                                           | Rate ceiling available                                                                  |
| --------------------------------------------- | --------------------------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| **A. Lambda + API Gateway HTTP API — chosen** | **$0**                                  | **$1.31** ($1.11 gateway + $0.20 Lambda requests; compute free ≤16M) | stage rate + burst, independent of concurrency                                          |
| B. Lambda function URL                        | $0                                      | $0.20 (Lambda only)                                                  | reserved concurrency only, at a fixed 10 × concurrency                                  |
| C. Lambda + API Gateway REST API              | $0                                      | $3.70 ($3.50 + $0.20)                                                | same as A, plus per-method — 3.5× for features unused (us-east-1 basis; see Amendments) |
| D. ALB → Lambda target                        | **≈ $16.43** ($0.0225/ALB-hour × 730 h) | ~$0.20 + LCU charges                                                 | none native; needs WAF (a further per-month charge)                                     |

"Compute free ≤16M" is the point at which Lambda's always-free 400,000 GB-seconds runs out: at 256 MB and a 100 ms average duration each request costs 0.025 GB-s, so the allowance covers **16 million requests/month** before compute bills at all. Both figures are assumptions about a function not yet written; they are stated so the arithmetic below can be checked rather than believed.

### The number that decides it

At the chosen throttle, held at its ceiling continuously for a 30-day month, traffic is `10 × 2,592,000 = 25.92M` requests. That bill is:

| Line                      | Arithmetic                                                   | $/month   |
| ------------------------- | ------------------------------------------------------------ | --------- |
| HTTP API requests         | 25.92M × $1.11/M                                             | 28.77     |
| Lambda requests           | 25.92M × $0.20/M                                             | 5.18      |
| Lambda compute            | (25.92M × 0.025 GB-s − 400,000 free) × $0.0000166667         | 4.13      |
| CloudWatch Logs ingest    | ~6.5 GB at ~250 B/invocation, less the free 5 GB, × $0.57/GB | 0.86      |
| **Worst case, sustained** |                                                              | **≈ $39** |

**Roughly a third of the ~$100/month ceiling, sustained, under continuous abuse, forever.** That is the argument for option A in one line: the throttle turns "we hope nobody hammers the demo" into an arithmetic bound, and $1.11 per million requests is what the bound costs. At the expected regime the same configuration bills about **one cent a month**.

The bound is only as good as the configuration that produces it, which is the honest caveat: it lives in `default_route_settings` on the stage, and an apply that dropped it would remove the guarantee silently. That is a reason to alarm on spend, not a reason to prefer an option with no ceiling at all.

### A. Lambda + API Gateway HTTP API — chosen

$0 standing: HTTP APIs have no per-hour charge, no minimum, and no per-stage fee; an idle API costs nothing, and — as with 0004's queue — an API somebody _forgets_ to destroy also costs nothing.

What the $1.11 per million buys over option B's $0.20:

- **A rate ceiling that is not a concurrency ceiling.** `throttling_rate_limit` and `throttling_burst_limit` are a token bucket: 10 requests/second sustained with a burst of 20 above it, expressed independently of how many executions run at once. This is the entire cost argument above, and it is the surface #29 extends rather than replaces.
- **Routes and stages as first-class objects.** The route table still lives in code (seven routes do not justify a framework), but access logs carry route keys, and per-route throttle overrides exist unused today and available to #29 — the write endpoint is the one that needs a tighter limit than the reads.
- **A custom domain path.** HTTP APIs support custom domain names, so when #21 owns a domain the API can sit under it without a second resource in front. The default `https://<api-id>.execute-api.<region>.amazonaws.com` is ugly on a portfolio README; it is also, notably, server-assigned — the endpoint is captured from the Terraform output rather than predicted.
- **CORS as gateway configuration**, so the browser contract is Terraform rather than response-header code in every handler.

Genuine downsides:

- **Every Swagger UI asset is a billed gateway request _and_ a Lambda invocation.** A `/docs` page view is roughly four or five requests (HTML, CSS, the bundle, `/openapi.json`), so the demo's most-viewed page is also its most request-hungry. At demo volume this is cents; it is nevertheless the place where option A's per-request premium lands hardest, and it is a direct consequence of the Swagger decision below.
- **A second resource in the teardown path.** `terraform destroy` removes the API and its stage cleanly, but ADR 0001's warning about per-service Terraform multiplying the places an idle resource can hide applies. The mitigation is the same as 0004's: what hides here does not bill.
- **Stage throttling is per-stage, not per-client.** One abusive caller consuming the full 10 requests/second 429s every legitimate visitor. **That is a denial of service, and this ADR does not solve it** — it bounds the bill and hands availability to #29's per-IP work. Naming it is the point: the throttle is a cost control that looks like an abuse control.
- **A network hop, and a second cold start surface.** The gateway adds single-digit milliseconds and one more component that can be misconfigured between a request and a handler.
- **Payload and timeout limits** — 30-second integration timeout, 10 MB request payload, 6 MB Lambda response — bind on the Swagger asset path specifically, since binary assets must be base64-encoded within the response limit.

### B. Lambda function URL

The strongest rejected option, and it deserves accuracy rather than the usual dismissal. **Two things commonly said against function URLs are false, and were assumed in this ticket's plan:** they support CORS configuration natively (`AllowOrigins`, `AllowMethods`, `AllowHeaders`, `MaxAge` — set on the URL, applied by Lambda to every response), and they are **not** throttle-less. AWS documents the mechanism precisely: "You can throttle the rate of requests that your Lambda function processes through a function URL by configuring reserved concurrency … your function's maximum request rate per second (RPS) is equivalent to 10 times the configured reserved concurrency", with excess requests returning HTTP 429. Setting reserved concurrency to zero rejects all traffic, which is a genuinely good emergency stop that option A has no direct equivalent for.

It is also **six and a half times cheaper per request** — $0.20/M against $1.31/M — and needs no second resource at all: HTTPS endpoint, IPv6, resource policy, done.

Rejected because the rate ceiling it offers is welded to a quantity that should be set independently:

- **10 × reserved concurrency is a coarse, coupled knob.** The only way to reach this ADR's 10 requests/second ceiling is reserved concurrency **1** — which also means the API serves exactly one request at a time. A single slow DynamoDB Query then 429s every concurrent visitor, and the abuse guard has been paid for in availability. The next setting up, concurrency 2, doubles the ceiling to 20 rps and roughly doubles the worst-case bill. Rate and concurrency are different quantities and this system wants them different: ~10 rps sustained, but comfortable concurrency so that two people can load the demo at once.
- **No burst allowance.** A token bucket lets a page load fire its handful of parallel requests and then settle; a concurrency cap has no equivalent, so ordinary bursty browser traffic is exactly what it punishes.
- **Nothing for #29 to extend.** Every request arrives on one implicit route with no gateway-side knobs, so per-route limits, per-IP limits and request-level rejection all become Lambda code — **billed per invocation**. An abuse control you pay to run is the wrong shape: option A rejects excess traffic before it reaches compute, at no cost.
- **No custom domain.** Fronting `https://<url-id>.lambda-url.<region>.on.aws` with a real name means putting CloudFront in front of it, at which point the resource count is back where option A started and the routing metadata is still missing.

The saving being declined is real and small: at the expected regime the difference between $0.20/M and $1.31/M is a fraction of a cent per month. **The trade is a rate limiter for a cent**, and stated that way it is not close.

### C. Lambda + API Gateway REST API

REST APIs are the older, richer product, and the features are genuinely richer: usage plans and API keys, request and response validation against gateway models, WAF integration, private endpoints, canary deployments, per-method throttling, and a response cache.

Rejected because **every one of those features is either unused, duplicated, or itself a per-hour charge**, and the premium is 3.5× on every request forever:

- **Usage plans and API keys presume identified clients.** The demo is anonymous on purpose (0001), and #30 owns the auth question. Buying a key-management surface for callers who have no keys is paying for the feature that most distinguishes this option and using none of it.
- **Gateway request validation duplicates the zod schemas.** `docs/standards/architecture.md` rule 2 puts exactly one schema per domain concept in `@cumulo/shared`, and this ticket's whole OpenAPI mechanism generates the document _from_ those schemas. Expressing the same constraints again as gateway models is a second source of truth that can drift — precisely the failure rule 2 exists to prevent — and it would drift silently, because nothing type-checks a gateway model against a zod schema.
- **The one feature that would genuinely help — the response cache — is a per-hour charge** for a dedicated cache instance. ADR 0004 rejected Kinesis on the principle that a resource billing for existing is the wrong shape for a demo that idles; a cache instance is the same shape, and buying a 3.5× per-request premium in order to gain access to it would be paying twice.
- **WAF is a further standing monthly charge** per web ACL, on top.

At 25.92M worst-case requests the REST premium alone is `25.92 × $2.50 ≈ $65/month` more than option A (us-east-1 basis on both sides; see Amendments) — pushing the bounded worst case from roughly a third of the ceiling to essentially all of it, in exchange for capability this system has argued it does not want. If #30 ever chooses API keys as the auth mechanism, this option is worth re-costing; that is a revisit trigger, not a reason to buy it now.

### D. Application Load Balancer with a Lambda target group

The conventional answer, and it brings real things: a stable DNS name independent of the API's identity, health checks, an idle timeout configurable far beyond API Gateway's 30 seconds, path-based routing across many targets, and per-request costs that are effectively noise.

Rejected on ADR 0004's precedent, applied without modification:

- **≈ $16.43/month standing, before a single request** (`$0.0225 × 730`), plus LCU charges. It would be **the only resource in Cumulo that bills for existing at a nonzero rate**, undoing in one apply the property 0004 established. 0004 rejected a ≈ $10.95/month provisioned Kinesis shard as "11% of the ceiling for a transport"; this is 16% of the ceiling for a router, and the argument is not weaker just because the ticket is more visible.
- **It requires a VPC with subnets in at least two Availability Zones.** ADR 0002 counted "no VPC, no NAT Gateway, no instance, no proxy" among the specific reasons the storage layer costs $0. An ALB reintroduces that topology — and with it a class of misconfiguration this platform has never had to reason about — for a service whose only dependency is a public AWS API endpoint.
- **Its free tier cannot be leaned on.** New accounts get shared load-balancer hours, but the allowance expires, and per the frame above this document does not rest cost claims on expiring tiers.
- **Nothing it uniquely provides is needed.** There are no long-lived connections, no fleet of targets to health-check, no path-based routing across multiple services, and no request that legitimately runs longer than 30 seconds. It also has **no native rate limiting at all** — that is AWS WAF, at a further per-month charge — so the option with the highest standing cost is also the one that does not solve the problem option A was chosen for.

### Swagger UI hosting

The issue requires a hosted Swagger UI with a working "try it out". Three shapes were considered; all three cost approximately $0, so this sub-decision turns entirely on coupling and on supply chain.

**S1. Bundled `swagger-ui-dist`, served by the API Lambda — chosen.** The assets ship inside the deployment zip and are served from an exact-filename allowlist. It wins on three properties:

- **Same origin as the API.** "Try it out" issues a real browser request to `/v1/sites` from a page served at `/docs`, so there is no CORS negotiation on the demo's showpiece interaction. Every other option makes the docs a second origin and the try-it-out button a CORS question.
- **One artefact, one lifecycle, one version.** The UI, the assets and the OpenAPI document that describes them ship in the same zip from the same commit. There is no deploy ordering in which the rendered spec and the running API disagree.
- **It is reviewable by the gates this repo already has.** `swagger-ui-dist` is a pinned dependency in `pnpm-lock.yaml`, subject to the `minimumReleaseAge` quarantine that `pnpm check:supply-chain-policy` enforces, and visible to every dependency review the project performs.

Its downsides are real and are accepted: serving static bytes from compute is inelegant and makes each asset a billed request plus an invocation (see option A above); the deployment package grows by several megabytes against Lambda's 50 MB zipped / 250 MB unzipped limits; binary assets must be base64-encoded within the 6 MB response limit; there is no CDN in front, so `Cache-Control` on the pinned asset paths is doing the work a CDN would; and changing the docs requires a Lambda deploy.

**S2. S3 static site (with CloudFront for HTTPS).** Also ~$0 — a few megabytes of storage and trivial request volume — and the technically correct home for static assets. Rejected on coupling, not on money: it makes the docs a second origin, so try-it-out needs CORS; S3 website endpoints are HTTP-only, so HTTPS drags in a CloudFront distribution and an invalidation step; the docs and the API acquire independent deploy paths that can ship a spec describing an API that is not deployed yet; and buckets and CDNs are explicitly **#21's** in ADR 0001's ownership list, so putting the API's docs there blurs a boundary that document just drew.

**S3. CDN-referenced HTML — `<script src="https://unpkg.com/swagger-ui-dist@…">`.** $0, about ten lines, and by far the least code. Rejected because it is **the one dependency mechanism that bypasses every control this repo has**: a script tag is not in `pnpm-lock.yaml`, is not covered by the release-age quarantine, is not seen by `pnpm check:supply-chain-policy`, and is not reviewed by anything. It puts a third party in the runtime path of the demo's most-viewed page — their outage is our broken docs — and it sends every visitor's IP to a CDN we do not operate. For a repo whose supply-chain posture is itself a gate, shipping a page that loads unreviewed executable code from someone else's host would be the loudest possible contradiction.

## Consequences

**The platform's standing cost stays $0.** ADR 0004's headline survives this ticket intact: the Lambda bills only for invocations, the HTTP API bills only for requests, and the log group bills only for bytes — three resources, none of which charge for existing outside an always-free allowance (amended 2026-08-10; see Amendments). Cumulo still has no per-hour resource anywhere, and the ~$100/month ceiling remains entirely unspent at rest.

**Worst-case spend is now a computed number rather than an assumption.** ≈ $39/month with the API pegged at its throttle ceiling continuously, derived above. This is the first place in the platform where an unbounded external input meets a metered resource, and the throttle is what makes the answer finite. Two things follow: the throttle settings are load-bearing configuration and belong in review whenever `infra/api` changes, and a billing alarm is the backstop for the case where they are removed.

**The cost guard is not a capacity guard, and the gap should be visible.** ADR 0002 sized `cumulo-series` at 21 provisioned RCU and named the backstop explicitly — "#29's gateway throttling and the billing alarms remain the right backstop either way". This is that throttling, arriving one ticket early. But the arithmetic does not fully close: a maximum-width `GET /v1/sites/{siteId}/series` over the 336-hour span cap reads on the order of a thousand small items, roughly 30 read units on an eventually-consistent Query (assuming ~250 B/item). Ten of those per second is an order of magnitude above 21 RCU sustained. 0002's 300-second burst reserve of 6,300 units absorbs a couple of hundred such requests instantly, which covers every demo-shaped load — but a determined caller pegging the throttle with maximum-width range reads surfaces as DynamoDB read throttling, not as a bill. That is the correct failure (0002 mandates `ReadThrottleEvents` alarms, and capacity mode is a one-attribute change), and it is recorded here rather than discovered later.

**What #14 owns**, per ADR 0001 and unchanged by this document: the function and its log group, the HTTP API, its `$default` stage and throttle settings, the `AWS_PROXY` integration, the `aws_lambda_permission`, the execution role, and the deploy-role grant — all in `infra/api`, with no cross-stack references (table ARNs assembled by naming convention, as `infra/ingestion` does). The execution role gets `GetItem, PutItem, DeleteItem, Query` on the sites table and `Query` only on the series table; the API reads and writes nothing else.

**What #29 inherits.** The per-route throttle overrides, access logs with route keys, and the CORS configuration are all sitting on the API unused or wide open. #29 tightens them alongside its per-IP limiter, the site-cap counter, eviction and auto-block. CORS stays `*` until #21 fixes a real web origin; the Terraform says so at the resource.

**The API cannot be turned into an Open-Meteo amplifier.** Zero outbound weather calls on every path means the 10,000-calls/day quota is untouchable from the public surface. This is the property that makes shipping an unauthenticated write endpoint tolerable at all under CLAUDE.md's API-frugality constraint, and any future endpoint that fetches upstream data on a request path reopens this ADR rather than quietly inheriting its conclusion.

**Two corrections of record, since this ticket's plan asserted otherwise.** Lambda function URLs **do** support CORS configuration, and they **do** offer a throttle — reserved concurrency, at a fixed 10 × concurrency requests/second. Option B is rejected on the coupling of that knob, not on its absence. The distinction matters because a future reader re-evaluating function URLs should re-evaluate the real argument.

**What would make us revisit.** ADRs are immutable: any change supersedes this one with a new ADR and never edits it. Concrete triggers:

1. **Auth arrives (#30) and chooses API keys or usage plans as the mechanism** — the one scenario in which option C's 3.5× premium buys something real.
2. **Sustained traffic above roughly 16 million requests/month**, where Lambda's always-free 400,000 GB-seconds stops covering compute and the marginal cost per million starts rising with function duration rather than staying flat.
3. **A request path that legitimately exceeds the 30-second integration timeout** — a fleet aggregate fanning out server-side is the plausible one — which is an argument for asynchronous responses long before it is an argument for a load balancer.
4. **Swagger asset traffic becoming a material share of requests**, which would make S2's CDN the right answer after all; the trigger is measurable from access logs rather than guessed.
5. **A second HTTP surface** — an internal or admin API — at which point one gateway with two stages, or a shared gateway, is worth costing against a second function URL.
6. **The throttle proving too blunt in practice**, i.e. legitimate visitors 429ing each other before #29 lands. The fix is per-route limits on the existing stage, not a change of hosting.

## Amendments

Per `docs/adr/README.md`: amendments true up stated values that have legitimately moved; the decision and its rationale are immutable.

- **2026-08-10 — the chosen option's worst-case bound re-based us-east-1 → eu-west-1 (#200).** The cost frame above was computed at us-east-1 list prices with a stated "Ireland runs roughly 10–15% higher" margin. The platform deploys into eu-west-1, and two of the four rates behind the bound are regional: HTTP API requests $1.00/M → $1.11/M (first 300M; the over-300M tier $0.90 → $1.00; AmazonApiGateway offer for eu-west-1, publication 2026-07-24, SKU `WPZ6JK7P27W4K4QK`) and CloudWatch Logs ingestion $0.50/GB → $0.57/GB (AmazonCloudWatch offer, publication 2026-08-06, SKU `KJBTQPDHW2H92B8Y`). Lambda's $0.20/M requests and $0.0000166667/GB-s are identical in both Regions (AWSLambda offer, publication 2026-07-17). The worst-case table moves — gateway row $25.92 → $28.77, logs row $0.75 → $0.86, bound ≈ $36 → ≈ $39/month — and the chosen option's marginal, $1.20/M → $1.31/M, is trued everywhere it is stated in this document, including inside option B's comparison, whose own $0.20/M is Region-identical and whose argument (a rate limiter for a fraction of a cent at demo volume) is unchanged. No conclusion turns on it: the option comparisons are ratios, and the movement is ≲13% and near-uniform, so figures belonging to the rejected options alone (REST's $3.50/M and ≈ $65 premium, ALB's ≈ $16.43 standing) are left on their original us-east-1 basis rather than re-derived. That carve-out covers option C's `3.5×` per-request premium wherever it appears — the options table, and the rejection argument's restatements of it — which is a ratio of REST's $3.50/M to option A's pre-amendment $1.00/M; at the amended rate the ratio is 3.15× and the delta behind the "≈ $65/month" figure is $2.39 rather than $2.50, neither of which changes the argument that the premium buys capability this system does not want. Option B's comparison moved with the rate it is drawn from: $1.20/M ÷ $0.20/M was exactly six, and at $1.31/M it is 6.55, so "six times cheaper" reads "six and a half" above. `infra/README.md` ("What it costs", api stack) records the eu-west-1 CloudWatch ingestion rate; its gateway figures still stand at the us-east-1 $1.00/M, so on that rate this document leads the README rather than following it — #376 propagates it and the other eleven restatement sites.
- **2026-08-10 — "none of which charge for existing" made precise (#200, after #179/#188's audit).** Log groups, alarms, and stored bytes do bill for existing — at $0 because always-free allowances absorb them, not because no meter runs. The Consequences line now reads "outside an always-free allowance"; the magnitude, ≈ $0, is unchanged, and so is the argument it supports. The per-resource statement lives in `infra/README.md` ("What it costs" notes, per stack).
- **2026-08-10 — the scope of the ≈ $39 bound stated (#200).** The bound prices gateway requests, Lambda requests and compute, and log ingestion — the terms that billed per-request when this was written, when every DynamoDB table sat inside provisioned free capacity and a read flood surfaced as throttling, not dollars (stated plainly in Consequences above). ADR 0002's Amendments (#156, #258) have since moved every table to on-demand, so throttle-pegged traffic now also bills DynamoDB request units this bound does not include: ADR 0006's worst-case table carries the abuse-table term (≈ $20/month at eu-west-1 rates), and per-request storage reads range from $0 (docs assets) to ≈ $110/month were every request a maximum-width series read (25.92M × ~30 RRU × $0.1415/M — the read this document itself sized at "roughly 30 read units"). This entry states the scope; re-deriving a platform-wide worst case is follow-up work (#375), not an amendment.
