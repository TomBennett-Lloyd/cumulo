# Architecture standards

**Trigger:** adding a module, package, or service; adding a dependency between packages; unsure where new code belongs.

## Rules

1. **Dependency direction is one-way.** `apps/*` depend on `packages/*`. Packages never import from apps. Apps never import from other apps — anything two apps need lives in a package. Within a package, modules expose a deliberate surface via `index.ts`; deep imports across module boundaries are a smell.

2. **Domain schemas live in `@cumulo/shared`, once.** Site, forecast, reading — one zod schema each, shared by API validation, stream payloads, and frontend types. If two definitions of the same concept exist, that's a bug even when they currently agree.

3. **Pure core, effectful edges.** PV physics, aggregation math, and error metrics are pure functions of typed inputs — no I/O, no clocks, no env access. AWS clients, HTTP, and Open-Meteo calls live in thin adapter modules at the edges. This is what keeps the interesting code trivially testable and the Lambda handlers boring.

4. **Service boundaries are the ones in the ADR — resist fragmenting further.** Ingestion, forecast, fleet API, web. A new deployable needs an ADR arguing for it (independent scaling/failure/deploy cadence), not just a new concern. New concerns default to new _modules_ inside existing services.

5. **No `utils/` dumping ground.** Name modules by domain (`irradiance.ts`, `aggregation.ts`), not by genericness. If code has no domain name, question whether it belongs here at all.

6. **Significant decisions get an ADR** (`docs/adr/`, template there). Significant = expensive to reverse, cross-service, or surprising to a newcomer. The service split, the DynamoDB/Postgres split, and the PV-model runtime are all ADR-worthy; a function's internal shape is not.

## Why

The job this repo showcases values judgement about boundaries: a small number of genuinely independent services, documented reasoning, and restraint about further splitting. The pure-core rule is also what makes the physics-vs-ML comparison feature cheap to build — both layers are pure transforms over the same typed inputs.
