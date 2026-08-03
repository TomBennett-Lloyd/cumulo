# Architecture standards

**Trigger:** adding a module, package, or service; adding a dependency between packages; restating an owned value (infrastructure, schema ceiling, cost) in code or prose; unsure where new code belongs.

## Rules

1. **Dependency direction is one-way.** `apps/*` depend on `packages/*`. Packages never import from apps. Apps never import from other apps — anything two apps need lives in a package. Within a package, modules expose a deliberate surface via `index.ts`; deep imports across module boundaries are a smell.

2. **Domain schemas live in `@cumulo/shared`, once.** Site, forecast, reading — one zod schema each, shared by API validation, queue payloads, and frontend types. If two definitions of the same concept exist, that's a bug even when they currently agree.

3. **Pure core, effectful edges.** PV physics, aggregation math, and error metrics are pure functions of typed inputs — no I/O, no clocks, no env access. AWS clients, HTTP, and Open-Meteo calls live in thin adapter modules at the edges. This is what keeps the interesting code trivially testable and the Lambda handlers boring.

4. **Service boundaries are the ones in the ADR — resist fragmenting further.** Ingestion, forecast, fleet API, web. A new deployable needs an ADR arguing for it (independent scaling/failure/deploy cadence), not just a new concern. New concerns default to new _modules_ inside existing services.

5. **No `utils/` dumping ground.** Name modules by domain (`irradiance.ts`, `aggregation.ts`), not by genericness. If code has no domain name, question whether it belongs here at all. The `check:module-names` gate in `verify` enforces the filename half of this — a bare `utils.*` module fails the build, not just review.

6. **Significant decisions get an ADR** (`docs/adr/`, template there). Significant = expensive to reverse, cross-service, or surprising to a newcomer. The service split, the DynamoDB/Postgres split, and the PV-model runtime are all ADR-worthy; a function's internal shape is not.

7. **Functions by default; a class only where methods genuinely share state.** `this.` is the marker that makes that state visible — which is exactly what a factory closing over variables hides. One **flat** base class is acceptable for shared _mechanism_ that needs instance state (the storage adapters' error-wrapping helper is the motivating example). No hierarchies: a class extending anything other than a base that itself extends nothing is a review blocker (`Error` subclasses excepted). No speculative polymorphism: an abstract method needs ≥2 implementations in the same PR. And a detached method loses its `this`, so inject the object, not the method — `@typescript-eslint/unbound-method` enforces that.

8. **A constant that mirrors an infrastructure value is declared to the mirror gate.** Some numbers genuinely live in two places — Terraform owns the deployed value, and code has to size itself against it (`INGESTION_LAMBDA_TIMEOUT_MS` against `aws_lambda_function.ingestion`'s `timeout`). That is allowed, and citing the other file in a comment is not enough: comments do not fail builds. Add the pair to `MIRRORS` in `.claude/scripts/check-infra-mirrors.sh`, which the `check:infra-mirrors` gate in `verify` compares on every run. The gate only knows the pairs it is told about, so declaring one is the part that cannot be automated — and an undeclared mirror drifts silently, in whichever direction nobody was watching.

9. **A stated value has one owner; prose points at it, never restates it.** Every fact that reads as a value or a name — a capacity, a ceiling, a transport, a billing mode — has exactly one owning declaration: an exported constant, a Terraform attribute, one named comment block, or one named doc section. Any other mention names the owner (`MAX_PLAUSIBLE_RESIDENTIAL_KW`; "`infra/storage/tables.tf`'s header") and carries no literal of its own. A site that must carry the literal because it computes with it or asserts it (a cost table, a runbook readback expectation) is listed in a short **restatement ledger** comment beside the owner, so changing the owner finds every copy at plan time rather than serially in review (#156). Rule 8's mirror gate covers the numeric code↔Terraform half. Historical claims survive in past tense, naming the decision they reason about; ADRs are immutable and exempt.

## Why

The job this repo showcases values judgement about boundaries: a small number of genuinely independent services, documented reasoning, and restraint about further splitting. The pure-core rule is also what makes the physics-vs-ML comparison feature cheap to build — both layers are pure transforms over the same typed inputs.
