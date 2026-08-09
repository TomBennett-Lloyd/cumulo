# `@cumulo/api`

The Fleet API: one Lambda behind an API Gateway HTTP API, serving sites CRUD over `cumulo-sites`
and per-site forecast reads over `cumulo-series`, plus the OpenAPI document and the Swagger UI that
renders it.

The service makes **zero Open-Meteo calls**. It reads what ingestion and the forecast service
already stored, so CLAUDE.md's API-frugality constraint holds here by construction rather than by
discipline: there is no HTTP client in this package to misuse.

## The request path

| Module                          | Responsibility                                                                         |
| ------------------------------- | -------------------------------------------------------------------------------------- |
| `http/gateway-event.ts`         | Parses the API Gateway payload-v2 event into an `ApiRequest`. No `@types/aws-lambda`.  |
| `http/response.ts`              | The response shape, the `apiErrorSchema` failure body, and response-schema validation. |
| `http/router.ts`                | Route table and matcher. 204 on preflight, 404 on no match, 400 on non-JSON body.      |
| `abuse/ip-limiter.ts`           | The per-IP limiter and its policy numbers, over the `cumulo-abuse` table.              |
| `abuse/origin-check.ts`         | Pure `Origin` allow-list check for the write routes. Friction, not auth.               |
| `sites/site-id-param.ts`        | The `{siteId}` path parameter, validated once for every `main.ts` route that has one.  |
| `sites/*.ts`                    | One module per route: list, create, get, update, delete.                               |
| `forecast/known-site.ts`        | The "is there such a site at all" gate both series routes open with.                   |
| `forecast/series-window.ts`     | Window arithmetic: a horizon into an upper bound, and a window's width in hours.       |
| `forecast/series-split.ts`      | Splits one interleaved `SeriesPoint[]` into the forecasts and actuals arrays.          |
| `forecast/get-site-forecast.ts` | `GET …/forecast` — the next 24/48/168 hours, with attribution. Empty is a 200.         |
| `forecast/get-site-series.ts`   | `GET …/series` — forecasts and actuals over an explicit window, span-capped.           |
| `openapi/components.ts`         | `components.schemas`, generated from the zod schemas the handlers parse with.          |
| `openapi/paths.ts`              | One documented operation per registered route.                                         |
| `openapi/responses.ts`          | What each error means to a caller. Statuses read from `apiErrorStatus`, never retyped. |
| `openapi/document.ts`           | The document, assembled once at module load, and `GET /openapi.json`.                  |
| `openapi/docs-assets.ts`        | The exact-filename asset allowlist — also the build's copy manifest.                   |
| `openapi/docs-page.ts`          | The Swagger UI page and the `/docs/{asset}` route that serves its assets.              |
| `main.ts`                       | The composition root: environment, adapters, route table, and the error boundary.      |
| `api-fixtures.ts`               | Test support — request and site fixtures, in one module rather than one per test file. |

Three properties are contracts rather than style:

- **Every response body is parsed through a schema before it is serialised.** `jsonResponse` takes
  the schema and the value, and a value that fails becomes a 500 rather than a client that silently
  mis-renders. It is also what stops a stored item that grew an attribute from leaking it, since zod
  strips what the schema does not declare.
- **Predictable failures are values; the boundary is the only `catch`.** An unknown id, an invalid
  body and an unmatched path are already responses by the time they reach `main.ts`. An exception
  there means something nobody predicted, and it becomes a **resolved** 500 — a rejected promise is
  an unhandled Lambda error, which the gateway renders as a body no client can parse. The boundary
  answers only while the invocation is alive: a request killed at the function timeout never reaches
  it, which is the second gateway-bodied response under [Error contract](#error-contract).
- **The caller gets a generic message; the operator gets the detail.** A `StorageError` names its
  table and operation, and neither is something an unauthenticated caller is entitled to. The
  boundary logs name and message only — never a stack or an SDK response object, both of which can
  carry an account id into a public log.

## Error contract

Every failure this service **answers** carries a body validating against `apiErrorSchema` from
`@cumulo/shared`. Each code is pinned to exactly one status, in `apiErrorStatus`, so a call site
cannot mispair them — `errorResponse` takes the code and derives the status. Two failures are not
answered here at all, and they are below the table.

| Code                | Status | Meaning                                                                            |
| ------------------- | ------ | ---------------------------------------------------------------------------------- |
| `validation_failed` | 400    | Malformed JSON, a path id that is not a uuid, or a body failing zod.               |
| `forbidden`         | 403    | A write whose `Origin` this deployment does not serve. No credential fixes it.     |
| `not_found`         | 404    | Unknown route **or** unknown entity — one code, deliberately.                      |
| `rate_limited`      | 429    | This service's per-IP limiter refused. Carries a `retry-after` header, in seconds. |
| `internal`          | 500    | The boundary caught something unexpected. Detail goes to the log only.             |

**Two responses carry the gateway's body instead of this schema**, because in both cases this
Lambda is not the thing answering. Neither is shaped by any code here, and both are the gateway's
own `{ "message": … }`:

- **429 from a gateway throttle.** The stage limit and the per-route write limits answer _before_
  this Lambda is invoked. The per-IP limiter is the other producer of 429 and does speak this
  schema — it is the `rate_limited` row above.
- **504 from a request killed at the function timeout.** The invocation dies before `main.ts`'s
  error boundary can run, so there is nothing left to answer in schema — and on `POST /v1/sites`
  that is worse than an error, because the 201 body is the only place the caller learns the new
  site's id. The per-request deadline (`http/request-deadline.ts`) makes this unreachable through
  every _looping_ path: series pagination, `POST`'s store-and-evict attempts and `DELETE`'s counted
  deletes all stop between commands and answer in schema instead, and every admitted unit is exactly
  one storage command, so none can outrun what was priced for it. One residual remains, stated
  rather than silent — independent per-command worst cases coinciding in one request's ungated
  straight-line prefix, which `request-budget.ts` counts per route and `docs/tech-debt.md` owns.

So a client cannot recognise either of these from the body and must not try: **map on the status**,
and read `Retry-After` when it is present rather than requiring it.

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

`POST /v1/sites` is unauthenticated and **capped at 40 user-created sites** (`MAX_USER_SITES` in
`@cumulo/shared`). The cap is not a refusal: a create against a full fleet still answers 201, having
first evicted the **oldest user site** to make room. The seed fleet is exempt structurally rather
than by a check — eviction reads a sparse GSI that only user sites are written into (ADR 0002's
`user-sites-by-age`), so there is no code path along which a seed site can be chosen. The count
itself is a counter item updated in the same DynamoDB transaction as the site row, which is what
makes "at most 40" a guarantee rather than a race between two concurrent creates.

Deleting a site — by eviction or by `DELETE` — leaves its `cumulo-series` rows to the table's TTL
(access pattern X3,
[ADR 0007](../../docs/adr/0007-series-deletion-is-ttl-only.md)). Nothing is deleted on the request
path, and the row's own removal is what makes that safe: every series route resolves the site first
and 404s, so the points are unreachable from the moment the site is gone, and nothing writes more of
them because ingestion and forecasting only serve fleet-listed sites. What is left costs no reads
and expires within ADR 0002's 90-day retention. The prompt half this replaces could only ever remove
one batch of a partition holding thousands of rows, and it ran after the caller's write had
committed — where its latency was the 201 or 204's to lose.

## Abuse protection

The write path is public by design (ADR 0001 — auth is #30), so what bounds it is a stack of layers
rather than a gate. [ADR 0006](../../docs/adr/0006-demo-abuse-protection.md) records the reasoning;
this is the operational summary, with the layer that bites first stated per regime.

| Layer                                  | Limit                                 | Answers    | Bites first when                         |
| -------------------------------------- | ------------------------------------- | ---------- | ---------------------------------------- |
| 0. `Origin` check (writes only)        | An allow-list, not a credential       | 403        | A client sends no `Origin` at all.       |
| 1. Per-IP limiter (`abuse/ip-limiter`) | 30 requests / 60 s → **1-hour block** | 429 + body | One address, low parallelism.            |
| 2. Per-route gateway throttle          | 2 rps, burst 4, on the three writes   | 429        | Sustained write volume from anywhere.    |
| 3. Stage throttle                      | 10 rps, burst 20 (ADR 0005, ≈ $36/mo) | 429        | Sustained total volume from anywhere.    |
| 4. Account Lambda concurrency          | 10, shared with ingestion             | 503        | **High parallelism** — measured, see S5. |

**Which routes the limiter covers** is a deliberate list, and it lives in `main.ts`'s route table:
the three writes plus `GET /v1/sites/{siteId}/series`, each of which either changes state or reads a
range whose size the caller picks. `GET /v1/sites`, `GET …/forecast`, `/openapi.json` and the two
`/docs` routes are unlimited — fixed, small cost per request, and already bounded by layer 3. A
limiter that made loading the docs page spend abuse-table writes would be paying to defend the
cheapest thing here.

Three properties of the limiter are deliberate and worth knowing before you tune it:

- **Fixed windows, so up to 2× the limit can pass across a boundary.** 30 requests at `11:00:59` and
  30 more at `11:01:00` are two full windows and neither trips. A sliding window would cost a read
  of every timestamp in the last minute, on every request. The threshold is friction against
  scripts, not an invariant anything's correctness rests on.
- **It fails closed.** If the `cumulo-abuse` table is unreadable the limited routes 500 rather than
  waving requests through. Fail-open would make the defence removable by whatever is already
  breaking DynamoDB, at the moment it is most wanted.
- **Blocks are cached in the container.** A blocked address is refused with no I/O for as long as
  the Lambda container lives, which is what stops a caller that just earned an hour's block from
  billing us for re-learning it a thousand times. The table is still the record — a cold container
  reads it.

**What the `Origin` check deliberately does not defend against.** Any non-browser client that sets
the header: `curl -H "Origin: …"` sails straight through, and that is the point. It buys exactly two
things — a drive-by scanner sending no `Origin` is refused for free, and a third-party page cannot
drive a visitor's browser at this API, because a browser sets `Origin` itself and a page cannot
forge another site's. It is friction, not authentication, and calling it security would be the kind
of mistake that gets trusted with something it cannot hold. The API's own origin is always allowed
(derived per request from the gateway's `domainName`, so Swagger UI's try-it-out works by
construction); `CUMULO_WEB_ORIGINS` adds browser origins beside it.

## Configuration

`main.ts` parses `process.env` through a zod schema at module scope, so a wrong deployment fails
during initialization rather than mid-request.

| Variable             | Purpose                                                                                |
| -------------------- | -------------------------------------------------------------------------------------- |
| `CUMULO_ENV`         | Environment suffix of the DynamoDB table names (`cumulo-sites-<env>`).                 |
| `CUMULO_WEB_ORIGINS` | Optional, comma-separated. Browser origins allowed on writes **beside** the API's own. |

`AWS_REGION` is not listed because Lambda always sets it and the SDK reads it directly.

`CUMULO_WEB_ORIGINS` is optional because a deployment with no browser front-end is a valid
deployment: the API's own origin is always allowed, and this variable only ever adds. `infra/api`
defaults it to `""`, which parses to no extra origins rather than to a misconfiguration. #144
populates it with the CloudFront URL and #21 with the custom domain — neither is hard-coded here or
there, because both are server-assigned. One origin populates it before either of those, on the same
terms; `.github/workflows/deploy-pages.yml`'s header owns #285's interim hosting arrangement and its
teardown.

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

Try-it-out passes the write routes' `Origin` check for free: the browser sets `Origin` to the page's
own origin, which is this API's, because `/docs` is served from the same Lambda (ADR 0005). **From a
terminal you have to send it yourself** — a bare `curl` gets `403 forbidden`, which is the check
working rather than a broken deployment:

```bash
curl -fsS -X POST "$API_ENDPOINT/v1/sites" \
  -H 'content-type: application/json' -H "Origin: $API_ENDPOINT" \
  -d '{"name":"Smoke test","latitude":53.3245,"longitude":-6.2601,"tiltDegrees":35,"azimuthDegrees":180,"capacityKw":4.2}'
```

**That POST creates a real site in a real table.** The next ingestion cycle will fetch weather for
its location, so unless you meant to add a permanent site to the demo fleet, remove it with the id
the response gave you — `DELETE` and `PUT` need the same header, for the same reason:

```bash
curl -fsS -X DELETE -o /dev/null -w '%{http_code}\n' \
  -H "Origin: $API_ENDPOINT" "$API_ENDPOINT/v1/sites/<id-from-the-201>"
# expect: 204
```

**Empty forecast arrays are the expected answer, not a failure.** Until #12's forecast service is
deployed and writing rows, `GET /v1/sites/{siteId}/forecast` and `/series` return `200` with
`forecasts: []` — deliberate behaviour, documented on both operations in the spec, and the exact
distinction #17's first-forecast poll keys on (`404` means the id is wrong, `[]` means keep
waiting). A reviewer clicking try-it-out on those two routes should expect empty arrays and read
them as correct.

**S5. The limits are live.** These are the guards the whole stack's bill argument rests on
(ADR 0005, ADR 0006), so it is worth one burst to see them fire rather than trusting the console:

```bash
for _ in $(seq 1 40); do
  curl -s -o /dev/null -w '%{http_code}\n' "$API_ENDPOINT/v1/sites" &
done | sort | uniq -c
# expect a mix dominated by 503, with some 200s and possibly some 429s
```

**Expect `503`s to dominate, not `429`s** — this is the measured behaviour (issue #29, 2026-08-01:
forty parallel requests returned 11 × `200` and 29 × `503`, with **zero** `429`s), and the reason is
layer 4 of the [abuse-protection table](#abuse-protection). The account's Lambda concurrency limit
is 10 and it is shared with ingestion, so at this parallelism requests are rejected _at Lambda_
before enough of them reach the gateway's per-second bucket to exhaust a burst of 20. The stage
throttle is real and is what bounds the bill under sustained load; it is simply not the layer that
bites first at forty-at-once. A run that is all `200` means something is wrong with both — stop and
read the stage back (that runbook's B4).

The `429`s worth deliberately provoking are the per-IP limiter's, which need volume rather than
parallelism: 31 serial requests to a limited route inside one minute earns a `429` with an
`apiErrorSchema` body, `"code": "rate_limited"` and a `retry-after` header — and a one-hour block on
your address, so do this knowing how to clear it (`aws dynamodb delete-item --table-name
cumulo-abuse-<env> --key '{"pk":{"S":"BLOCK#<your-ip>"}}'`).

Two details in that one-liner are load-bearing. The `&` is what makes the requests concurrent — a
serial loop cannot exceed a rate limit of 10 per second by much and will report forty `200`s from a
working throttle. And the pipe hangs off `done`, not off a `wait`: the backgrounded curls inherit
the loop's stdout, so `sort` sees their codes and finishes when the last one closes the pipe.
Piping `wait` instead sorts an empty stream while the codes scroll past on the terminal.

A `429` from the gateway arrives before this Lambda is invoked, so its body is the gateway's own
`{ "message": … }` and not an `apiErrorSchema` body; one from the per-IP limiter is an `apiErrorSchema`
body. That split is the contract described under [Error contract](#error-contract): clients map rate
limiting on the status, never on the body.
