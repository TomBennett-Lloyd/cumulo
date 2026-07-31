# `@cumulo/api`

The Fleet API: one Lambda behind an API Gateway HTTP API, serving sites CRUD over `cumulo-sites`
and (from #14's later chunks) per-site forecast reads over `cumulo-series`, plus the OpenAPI
document and the Swagger UI that renders it.

The service makes **zero Open-Meteo calls**. It reads what ingestion and the forecast service
already stored, so CLAUDE.md's API-frugality constraint holds here by construction rather than by
discipline: there is no HTTP client in this package to misuse.

## The request path

| Module                   | Responsibility                                                                         |
| ------------------------ | -------------------------------------------------------------------------------------- |
| `http/gateway-event.ts`  | Parses the API Gateway payload-v2 event into an `ApiRequest`. No `@types/aws-lambda`.  |
| `http/response.ts`       | The response shape, the `apiErrorSchema` failure body, and response-schema validation. |
| `http/router.ts`         | The route table and its matcher. 404 on no match, 400 on a body that is not JSON.      |
| `sites/site-id-param.ts` | The `{siteId}` path parameter, validated once for the three routes that take one.      |
| `sites/*.ts`             | One module per route: list, create, get, update, delete.                               |
| `openapi/components.ts`  | `components.schemas`, generated from the zod schemas the handlers parse with.          |
| `openapi/paths.ts`       | One documented operation per registered route. Statuses read from `apiErrorStatus`.    |
| `openapi/document.ts`    | The document, assembled once at module load, and `GET /openapi.json`.                  |
| `openapi/docs-assets.ts` | The exact-filename asset allowlist — also the build's copy manifest.                   |
| `openapi/docs-page.ts`   | The Swagger UI page and the `/docs/{asset}` route that serves its assets.              |
| `main.ts`                | The composition root: environment, adapters, route table, and the error boundary.      |
| `api-fixtures.ts`        | Test support — request and site fixtures, in one module rather than one per test file. |

Three properties are contracts rather than style:

- **Every response body is parsed through a schema before it is serialised.** `jsonResponse` takes
  the schema and the value, and a value that fails becomes a 500 rather than a client that silently
  mis-renders. It is also what stops a stored item that grew an attribute from leaking it, since zod
  strips what the schema does not declare.
- **Predictable failures are values; the boundary is the only `catch`.** An unknown id, an invalid
  body and an unmatched path are already responses by the time they reach `main.ts`. An exception
  there means something nobody predicted, and it becomes a **resolved** 500 — a rejected promise is
  an unhandled Lambda error, which the gateway renders as a body no client can parse.
- **The caller gets a generic message; the operator gets the detail.** A `StorageError` names its
  table and operation, and neither is something an unauthenticated caller is entitled to. The
  boundary logs name and message only — never a stack or an SDK response object, both of which can
  carry an account id into a public log.

## Error contract

Every failing route answers with a body validating against `apiErrorSchema` from `@cumulo/shared`.
Each code is pinned to exactly one status, in `apiErrorStatus`, so a call site cannot mispair them —
`errorResponse` takes the code and derives the status.

| Code                | Status | Meaning                                                                |
| ------------------- | ------ | ---------------------------------------------------------------------- |
| `validation_failed` | 400    | Malformed JSON, a path id that is not a uuid, or a body failing zod.   |
| `not_found`         | 404    | Unknown route **or** unknown entity — one code, deliberately.          |
| `internal`          | 500    | The boundary caught something unexpected. Detail goes to the log only. |

**429 is not in the enum.** Throttled responses come from the gateway's stage-level rate limit
before this Lambda is invoked, so they carry the gateway's own body. Clients map rate limiting on
the status (plus `Retry-After` when present), never on the body.

## Routes

| Route                       | Semantics                                                                                                       |
| --------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `GET /v1/sites`             | 200 `{ sites: FleetSite[] }` — the whole fleet, seed and user, active or not.                                   |
| `POST /v1/sites`            | 201 with the created site. `id`, `origin: 'user'`, `createdAt` and `active` are server-assigned.                |
| `GET /v1/sites/{siteId}`    | 200 with the site; 404 if unknown; 400 if the id is not a uuid.                                                 |
| `PUT /v1/sites/{siteId}`    | 200 with the updated site. Read-modify-write preserving `id`, `origin`, `createdAt`, `active`. Last write wins. |
| `DELETE /v1/sites/{siteId}` | 204 empty when a site was removed; 404 when there was nothing to remove.                                        |
| `GET /openapi.json`         | 200 with the OpenAPI 3.0 document, built at start-up from the zod schemas.                                      |
| `GET /docs`                 | 200 `text/html` — Swagger UI, pointed at `/openapi.json` on the same origin.                                    |
| `GET /docs/{asset}`         | 200 with an allowlisted Swagger UI asset; 404 for every other name.                                             |

`POST /v1/sites` is unauthenticated and enforces **no site cap**. That is deliberate: #14's cost
guard on this endpoint is the API Gateway stage throttle (10 rps, burst 20) configured in
`infra/api`. The cap counter transaction, per-IP limiting, eviction and auto-block are #29's scope,
and a cap enforced in the handler without #29's counter would be a race rather than a guard.

Deleting a site does **not** delete its `cumulo-series` rows. They carry ADR 0002's 90-day TTL and
expire on their own, and nothing reads them meanwhile because every series route looks the site up
first. An explicit range-delete of the orphans (access pattern X3) belongs with #29's eviction
machinery.

## Configuration

`main.ts` parses `process.env` through a zod schema at module scope, so a wrong deployment fails
during initialization rather than mid-request.

| Variable     | Purpose                                                                |
| ------------ | ---------------------------------------------------------------------- |
| `CUMULO_ENV` | Environment suffix of the DynamoDB table names (`cumulo-sites-<env>`). |

`AWS_REGION` is not listed because Lambda always sets it and the SDK reads it directly.

## Build

```sh
pnpm --filter @cumulo/api build   # → dist/main.mjs, dist/swagger/*, dist/handler.zip
```

The zip is the artifact the API's Terraform uploads; the Lambda handler string is `main.handler`.
The three load-bearing choices in that one-line script are the same ones `apps/ingestion/README.md`
argues at length: the AWS SDK is bundled rather than `--external` (the runtime's own SDK version
changes without notice), `--main-fields=module,main` bundles the SDK's ESM build so no dynamic
`require` survives into an ESM artifact, and `rm -rf dist` runs first because `zip` appends to an
existing archive.

`scripts/copy-swagger-assets.mjs` then copies the Swagger UI files into `dist/swagger/`, which is
where `main.ts` resolves them from — `new URL('./swagger/', import.meta.url)` against the bundle's
own location, so the same code path works in the zip and nowhere else has to know a path. The script
imports the allowlist from `src/openapi/docs-assets.ts` rather than repeating it (Node strips the
types on import), so the artifact ships exactly the files the route will serve. The largest of them,
`swagger-ui-bundle.js`, is ~1.5 MB — comfortably inside Lambda's 6 MB response limit even if it were
base64-encoded, which as text it is not.
