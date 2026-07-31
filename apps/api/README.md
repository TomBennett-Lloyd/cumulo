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

| Route                             | Semantics                                                                                                       |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `GET /v1/sites`                   | 200 `{ sites: FleetSite[] }` — the whole fleet, seed and user, active or not.                                   |
| `POST /v1/sites`                  | 201 with the created site. `id`, `origin: 'user'`, `createdAt` and `active` are server-assigned.                |
| `GET /v1/sites/{siteId}`          | 200 with the site; 404 if unknown; 400 if the id is not a uuid.                                                 |
| `PUT /v1/sites/{siteId}`          | 200 with the updated site. Read-modify-write preserving `id`, `origin`, `createdAt`, `active`. Last write wins. |
| `DELETE /v1/sites/{siteId}`       | 204 empty when a site was removed; 404 when there was nothing to remove.                                        |
| `GET /v1/sites/{siteId}/forecast` | 200 `{ forecasts, attribution }` from now, `hours` ∈ 24/48/168 (default 48). Empty is 200.                      |
| `GET /v1/sites/{siteId}/series`   | 200 `{ forecasts, actuals, attribution }` over required `from`/`to`; span > 336 h is 400.                       |
| `GET /openapi.json`               | 200 with the OpenAPI 3.0 document, built at start-up from the zod schemas.                                      |
| `GET /docs`                       | 200 `text/html` — Swagger UI, pointed at `/openapi.json` on the same origin.                                    |
| `GET /docs/{asset}`               | 200 with an allowlisted Swagger UI asset; 404 for every other name.                                             |

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

## Deploy

Two mechanisms, and which one you need depends entirely on what changed.

| Changed                                                              | Ships by                                                     |
| -------------------------------------------------------------------- | ------------------------------------------------------------ |
| Code — `apps/api/**`, `packages/shared/**`, `packages/storage/**`    | `.github/workflows/deploy-api.yml`, automatically on `main`. |
| Anything else about the function, the gateway, the throttle, the IAM | `terraform apply` in `infra/api/`, by an operator.           |

`deploy-api.yml` rebuilds the artifact on the same toolchain CI verified it with, assumes
`cumulo-github-actions` by OIDC (no AWS secret exists in this repository), calls
`UpdateFunctionCode` on `cumulo-api-dev`, and waits for the update to leave `InProgress` so a bundle
that fails validation fails the job rather than the next request. Its grant is two Lambda actions on
one function ARN (`infra/api/deploy.tf`) and **no `apigatewayv2` permission at all** — the stage
throttle that bounds this stack's bill is unreachable from CI by construction, and moving it takes a
reviewed `.tf` diff.

The workflow deploys code onto infrastructure that must already exist. First time through, that
means the operator apply below.

## Runbook: smoke the deployed API

The apply itself is [`infra/README.md`'s api-stack runbook](../../infra/README.md#runbook-the-api-stack) —
build the artifact first (`terraform plan` has a `fileexists` precondition on
`apps/api/dist/handler.zip` and stops with the command to run if it is missing), copy `backend.hcl`
and `api.auto.tfvars` from their committed `.example` twins, init against the real backend, plan,
review, apply. This section starts where that one's B5 hands over: proving the deployed service
answers, which is [issue #14](https://github.com/TomBennett-Lloyd/cumulo/issues/14)'s acceptance
criterion.

**S1. Take the endpoint from the apply's output. Never assemble it.**

```bash
API_ENDPOINT="$(terraform -chdir=infra/api output -raw api_endpoint)"
echo "$API_ENDPOINT"   # https://<api-id>.execute-api.<region>.amazonaws.com
```

The api id in that hostname is **server-assigned at create time**, so there is no template a correct
URL can be predicted from — a guessed one points at a different API or at nothing. It embeds no
account id, unlike most of this platform's outputs, so it is safe to quote in a PR body or an issue
comment.

**S2. The spec is being served, and it is the generated one.**

```bash
curl -fsS "$API_ENDPOINT/openapi.json" | head -c 200
```

`-f` is what makes this a check rather than a print: without it curl reports success on a 500 whose
body happens to be text. Expect the document to open `{"openapi":"3.0.3","info":{"title":"Cumulo
Fleet API"…`. There is no spec file in this repository to have gone stale — it is built from the zod
schemas at Lambda start-up — so what this proves is that the running bundle and the published
contract came out of the same build.

**S3. The fleet reads.**

```bash
curl -fsS "$API_ENDPOINT/v1/sites"
```

Expect `{"sites":[…]}`. An empty array is a legitimate answer on a fresh `cumulo-sites` table.

**S4. The docs render, and try-it-out works.**

```bash
open "$API_ENDPOINT/docs"
```

Swagger UI loads its assets from `/docs/…` on the same origin and its spec from `/openapi.json`, so
a page that renders is already evidence that three routes work. Then exercise **Try it out** on:

- `GET /v1/sites` — expect the same body as S3.
- `POST /v1/sites` — expect `201` and a body whose `id`, `origin: "user"`, `createdAt` and `active`
  the server assigned. The response is the only source of that id; nothing predicts it.

**That POST creates a real site in a real table.** The next ingestion cycle will fetch weather for
its location, so unless you meant to add a permanent site to the demo fleet, remove it with the id
the response gave you:

```bash
curl -fsS -X DELETE -o /dev/null -w '%{http_code}\n' "$API_ENDPOINT/v1/sites/<id-from-the-201>"
# expect: 204
```

**Empty forecast arrays are the expected answer, not a failure.** Until #12's forecast service is
deployed and writing rows, `GET /v1/sites/{siteId}/forecast` and `/series` return `200` with
`forecasts: []` — deliberate behaviour, documented on both operations in the spec, and the exact
distinction #17's first-forecast poll keys on (`404` means the id is wrong, `[]` means keep
waiting). A reviewer clicking try-it-out on those two routes should expect empty arrays and read
them as correct.

**S5. The throttle is live.** This is the cost guard the whole stack's bill argument rests on
(ADR 0005), so it is worth one burst to see it fire rather than trusting the console:

```bash
for _ in $(seq 1 40); do
  curl -s -o /dev/null -w '%{http_code}\n' "$API_ENDPOINT/v1/sites" &
done | sort | uniq -c
# expect two lines: some 200s and some 429s
```

Forty concurrent requests against a burst limit of 20 must produce some `429`s; a run that is all
`200` means the stage throttle is not doing what `infra/api/gateway.tf` says it does — stop and read
the stage back (that runbook's B4). The exact split varies with how the requests interleave and is
not worth pinning.

Two details in that one-liner are load-bearing. The `&` is what makes the requests concurrent — a
serial loop cannot exceed a rate limit of 10 per second by much and will report forty `200`s from a
working throttle. And the pipe hangs off `done`, not off a `wait`: the backgrounded curls inherit
the loop's stdout, so `sort` sees their codes and finishes when the last one closes the pipe.
Piping `wait` instead sorts an empty stream while the codes scroll past on the terminal.

A `429` here comes from the gateway, before this Lambda is invoked, so its body is the gateway's own
`{ "message": … }` and not an `apiErrorSchema` body. That asymmetry is the contract
described under [Error contract](#error-contract): clients map rate limiting on the status.
