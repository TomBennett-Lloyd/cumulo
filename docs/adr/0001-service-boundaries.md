# 0001 — Service boundaries

- **Status:** accepted
- **Date:** 2026-07-30
- **Issue:** #2

## Context

Cumulo does four distinguishable jobs, and what distinguishes them is not subject matter but _what makes them run_:

- **Ingestion** runs on a clock. A scheduled job fetches Open-Meteo forecasts for every distinct location where an active site exists — de-duplicated per location, never per site — and publishes normalised readings to a Kinesis stream (#11).
- **Forecast** runs on data arriving. A physics model (irradiance decomposition → plane-of-array transposition → DC-to-AC conversion) plus an ML correction layer turns those readings into per-site power forecasts, and the same pure functions hindcast against actuals to produce error metrics (#12, #16, #20).
- **Fleet API** runs on requests, from the public internet. Sites CRUD, per-site forecasts, fleet aggregates, an OpenAPI document generated from the `@cumulo/shared` zod schemas, and a hosted Swagger UI (#14).
- **Web** does not run on our compute at all. It is a built bundle on a CDN that executes on the visitor's machine (#17, #19, #21).

Three trigger models (cron, stream, HTTP) and one browser artefact. That asymmetry is the substance of this decision; everything else is cost.

Cost is a hard constraint, not a footnote: free-tier-first AWS under a ceiling of roughly $100/month. The interesting thing about that ceiling is that at this fleet size — tens of sites, forecasts refreshed hourly — the _compute_ is close to free in every possible decomposition. Lambda invocations at this volume sit inside the always-free tier whether they land in one function or six. What each additional deployable actually costs is fixed overhead: a Terraform module, an IAM execution role plus deploy permissions, a CI path that builds and ships it, a teardown path that has to be exercised rather than merely written down, and — the part that bills silently — any transport it needs in order to talk to its neighbours. A Kinesis stream bills for existing, not for being used; so does anything else standing between two deployables. So the honest cost model for a service split is: cheap per invocation, expensive per boundary, and the expense is mostly paid in surface area rather than dollars.

Two structural rules already constrain the answer. `docs/standards/architecture.md` rule 1 makes dependency direction one-way: apps depend on packages, packages never import from apps, and apps never import from each other — anything two services need lives in a package. Rule 2 puts exactly one zod schema per domain concept in `@cumulo/shared`. Together they mean cross-service contracts are expressed as shared schemas rather than as service-to-service imports, which is what makes more than one deployable tolerable at all, and also what makes each new inter-service payload a real cost: a second wire format for the same concept is a rule 2 violation waiting to happen.

Finally, two forces that are deliberately not resolved here but shape what this ADR may not foreclose. First, **auth**: the demo ships anonymous on purpose — a login wall in front of an interview demo costs more in friction than it protects (user decision, 2026-07-30) — but future expansion needs authentication, and where it belongs is an open design question (#30: separate auth service, inside the fleet API, or at a web/BFF layer with backend services on internal-only networking). Second, this is a portfolio repo whose reasoning is read by humans, which raises the bar in a specific way: restraint that is argued is worth something, restraint that is merely asserted is worth nothing, and a boundary count chosen to look impressive would be the worst of both.

## Decision

Cumulo has **exactly four deployables: ingestion, forecast, fleet API, and web.** No others.

The count is honest because `packages/*` are libraries, not deployables. `@cumulo/shared` is not a service; it is how the four services agree on what a site, a reading, and a forecast are, and it ships inside their artefacts. Adding a package is not adding a service and never needs an ADR.

**A fifth deployable must clear a bar.** It must demonstrate at least one of:

- **independent scaling** — a load profile the host service genuinely cannot absorb;
- **independent failure** — an outage that must not take a sibling down with it;
- **independent deploy cadence** — a component whose shipping rhythm is incompatible with its host's.

_Demonstrate_ means with evidence from this system: observed load, an actual incident shape, a cadence conflict that has bitten. Analogy to larger systems is not evidence. The argument goes in a new ADR referencing this one. Absent such an argument, a new concern becomes a new **module** inside one of the four services (architecture rule 4). This is the default, and it is expected to hold for nearly everything: aggregation, uncertainty bands, the physics-versus-ML comparison, abuse controls, and — should it arrive — authentication logic are all modules.

**Infrastructure ownership follows service boundaries.** This confirms the pattern proposed in the scope notes on #11 and #14 rather than overruling it. Each service ticket owns the Terraform for resources only that service uses: ingestion (#11) owns its schedule and its Kinesis stream; fleet API (#14) owns its compute, gateway, and Swagger hosting; web (#21) owns its bucket, CDN, certificate, and domain; forecast owns its triggers and compute. Cross-cutting infrastructure stays with platform tickets: #7 owns the remote state backend and the GitHub Actions OIDC role, and #13 owns the shared data stores decided by ADR #3.

The test for placement is not "is this infrastructure?" but **"how many services would notice if this resource changed?"** One means service-owned; more than one means platform-owned. That is exactly why storage is deliberately _not_ service-owned — ingestion, forecast, and the fleet API all read or write it — and why the stream is, despite being shared in the everyday sense: only ingestion provisions and produces to it, and if it changed, only ingestion's deploy would care. The reason to align infrastructure lifecycle with service lifecycle is that a resource used by one service already has that service's deploy cadence, teardown, and blast radius; centralising it means every service deploy touches shared state and teardown becomes all-or-nothing.

Nothing above decides where authentication lives. A future auth capability may be a module in the fleet API, or a boundary change argued in its own ADR; #30 assesses the options and this Decision constrains none of them beyond applying the same fifth-deployable bar to a standalone auth service that applies to anything else.

## Options considered

### A. Four services, split by trigger model — chosen

Ingestion, forecast, fleet API, web. Each boundary falls where the invocation model changes, so each deployable has one reason to be woken up and one reason to be redeployed.

Genuine downsides:

- **Fixed overhead is paid four times** for a workload that would fit in one function: four Terraform modules, four IAM roles, up to four CI deploy paths, and four teardown paths that each have to actually work. None of that is billed, all of it is maintained.
- **Three internal contracts** — the stream payload ingestion writes and forecast reads, and what forecast and the fleet API each read and write in storage — must stay aligned without a compiler checking across the process boundary. Rule 2's "one schema per concept" stops being tidiness and becomes load-bearing.
- **Deploys are not atomic.** A schema-widening change needs an ordered rollout across two services rather than one commit landing everywhere at once.
- **Debugging crosses boundaries.** "Why is this site's forecast stale?" spans a schedule, a stream, and two functions, and no single local process reproduces the whole path.
- **A standing charge exists that a monolith would avoid** — the stream bills for existing — and per-service Terraform multiplies the number of places an idle billable resource can hide, which under a $100 ceiling is a real risk rather than a theoretical one.

### B. More fragmented — split fetch from normalisation, and lift the ML correction layer out of forecast

The upsides are real and worth stating properly. Fetching from a third party is the flakiest thing in the system — rate limits, malformed payloads, partial failures — and isolating it from pure normalisation would give that failure surface its own retry and alarm story. The ML correction layer plausibly iterates on a different cadence to the physics model: retraining, model artefacts, and experiment turnaround do not naturally match the rhythm of a deterministic transform. And if ADR #4 chooses a Python pvlib Lambda, there is a genuine _runtime_ seam inside forecast, which a deployable boundary would express naturally.

Rejected because:

- **No independent scaling or failure need exists at this size.** All decompositions have identical, trivial invocation volume. Fetch and normalise share one trigger and one cadence — they are a pipeline, not two systems — so splitting them adds a network hop between two halves of a single logical step.
- **Splitting fetch from normalisation requires publishing an un-normalised intermediate payload**, i.e. a second wire format for weather that `@cumulo/shared` does not own. That is precisely the drift rule 2 exists to prevent, traded for a retry boundary that Lambda's own retry and DLQ behaviour largely already provides.
- **Every split needs a transport, and transports bill for existing.** Two more deployables plausibly mean two more standing charges to buy no throughput.
- **A runtime seam does not require a deployment seam.** If #4 picks Python, the forecast service becomes a Python deployable — one runtime boundary, aligned with a boundary that already exists. Making it two Python deployables adds a schema-crossing edge on the exact axis (#4's TypeScript-to-Python drift risk) that is hardest to keep honest.
- Model-iteration cadence is a fair argument that has not yet bitten. If it does, it is precisely a fifth-deployable case: a new ADR, with the cadence conflict as evidence.

### C. One backend monolith

One function, one Terraform stack, one deploy path, one IAM role, no internal contracts, and the cheapest possible answer.

Rejected because:

- **It is not actually one deployable.** A browser bundle on a CDN is not Lambda compute; web cannot collapse into it. The honest version of this option is two deployables, so the comparison is four versus two, not four versus one — which shrinks the saving it is being credited with.
- **It conflates invocation models.** One function behind both EventBridge and API Gateway is sized, packaged, and cold-start-tuned by whichever concern is heaviest. The public API's latency profile would be set by the ingestion and physics dependencies it never uses on a request.
- **It conflates failure domains.** A bad forecast deploy takes the public API down with it; an ingestion loop that exhausts concurrency degrades user-facing reads. Under anonymous public writes (#29) that is worse than untidy: a request burst competes for concurrency with the scheduled job that the whole dataset depends on.
- **It couples deploy cadence.** Model retraining, dashboard-driven API changes, and ingestion schedule tweaks would all ship through one artefact.
- **It forecloses ADR #4.** One artefact means one runtime, so a Python pvlib model would force the entire backend into Python or into a container image, and that decision would be made here as a side effect instead of there on its merits.
- For a repo whose boundary judgement is part of the deliverable, "we put everything in one Lambda" is defensible but says very little — and, unlike the choice above, it could not be undone cheaply once three concerns had grown into each other's code.

## Consequences

**Easier.** Every later ticket has a settled answer to "does this need a new service?" — almost always no, it needs a module. #3 and #4 can plan against fixed boundaries: #3 decides what forecast and the fleet API read and write, and #4's runtime choice is contained inside one deployable. Service-owned Terraform keeps teardown granular: destroying ingestion takes its schedule and stream with it, and no service's resources are stranded inside a shared everything-module.

**Accepted.** Four deploy paths, four IAM roles, and four Terraform modules to maintain, plus one standing transport charge, inside the ~$100/month ceiling — affordable because compute is per-invocation at this fleet size and the standing charges are few and named. Internal contracts are policed by `@cumulo/shared` plus CI rather than by a single type-checker run, and cross-service debugging is genuinely harder than single-process debugging. These are the prices of the asymmetry argued above, paid deliberately.

**Auth is a deferred force, not an omission.** The anonymous demo is a product decision, and this ADR does not decide where authentication eventually lives (#30). Of the three options, only one interacts with these boundaries: folding auth into the fleet API is a module and needs nothing from this document; a standalone auth service faces the fifth-deployable bar like anything else, and being a familiar service shape is not an argument for clearing it; a web/BFF gateway is the option that genuinely changes this picture, because it would turn `web` from a static artefact into server compute and put backend services on internal-only networking. That is a boundary change, and it remains available — it simply has to be argued in its own ADR superseding this one, rather than arriving by drift.

**The anonymous write path is an abuse and cost surface, and it is enforced at the fleet API and its edge.** Every created site adds Open-Meteo call volume against the 10,000/day free tier plus storage and compute under the ceiling. #29 owns the controls — a hard cap on user-generated sites with oldest-first eviction that never touches the seed fleet, per-IP rate limiting via the cheapest mechanism that works (gateway throttling before reaching for WAF's monthly charge), automatic temporary blocking of abusive sources, friction against programmatic use, and billing alarms as a backstop — and it gates public hosting: #21 is blocked by #29. These boundaries deliberately place that enforcement in the request path where requests arrive, not in a new deployable: a separate enforcement service would have to sit in the same path anyway, adding a hop and a failure mode to buy nothing. Ingestion feels the pressure but does not enforce it — it fetches only for active sites, so the site cap is what bounds its call volume.

**What would make us revisit.** ADRs are immutable: any change supersedes this one with a new ADR and never edits it. Concrete triggers — ML retraining that needs long-running or accelerated compute the forecast service cannot host; a component whose outage must be survivable by its siblings; a shipping cadence that a shared artefact keeps blocking; ADR #4 choosing a runtime that cannot be packaged alongside the rest of forecast; or #30 landing on the BFF answer. Each is a fifth-deployable argument, and each is welcome on those terms.
