# Security standards

**Trigger:** writing or changing a security policy whose directives have fallback semantics — a CSP, a CORS policy, any response header where an omitted directive inherits from another, or where omission itself has a meaning.

## Rules

1. **Deny by default, then name what the app needs.** A directive or a grant is added only when its
   absence is shown to break something, and the evidence that it does sits beside the grant — what
   wanted it, what was checked, and why the looser spelling was refused. "Probably needed", "harmless
   to include" and "the managed policy has it" are not evidence.

   The repo's worked example is the CloudFront response-headers policy. `infra/web/security-headers.tf`
   holds that per-directive rationale in prose; `infra/web/content-security-policy.tftpl` is the policy
   text's one owner, rendered by every consumer rather than re-declared in any of them. The rationale
   is the one place that quotes the values back, deliberately — an argument for a grant has to name
   what it argues for — and the next paragraph says on what terms it may.

   So do not keep a **standing** copy of the policy's current directive values — not here, not in a
   second config, not in a doc or README that states the policy at rest. A security value with two
   carriers drifts in whichever direction nobody was watching. Name the owning file and let the
   reader open it. The ban does not reach two things, and for two different reasons. Rules 2 and 3
   require a change to state what each dependant resolves to, in its plan or PR body; that is the
   change's own transient evidence and outlives nothing. The per-directive rationale beside the grant
   in the exemplar pair above is the opposite — a standing carrier of the values, sanctioned as one
   for the reason the paragraph above gives. It is not exempt, though; it is owned:
   `architecture.md` rules 9 and 11 govern it, so whoever changes a directive trues the rationale
   beside it in the same change. What the ban targets is the standing copy carrying no such
   obligation — a second config, or a doc stating the policy at rest with nobody answerable for it.
   (`child-src 'self'` appears in rule 2 as the subject of a worked example about an unenumerated hop
   — not as a statement of what the policy's text is, today or ever. For that, read the template.)

2. **Adding, changing or removing a directive means naming every directive that inherits from it, and
   stating what each one resolves to after the change.** The question is not "what does this directive
   now allow" but "what does every dependant of it now allow" — a directive you never typed can change
   meaning because of one you did.

   **Evidence — #176, PR #393.** `child-src 'self'` was added defensively, to cover workers on CSP2
   engines that predate `worker-src`. But `child-src` has two dependants, and the second one is
   `frame-src`: with `frame-src` undeclared, the directive added purely for safety silently resolved
   framing to same-origin, in a policy whose whole posture is that the app frames nothing.

   Nothing was mistyped and no value was wrong in isolation. The defect was entirely in the hop nobody
   enumerated. Review cycle 1 caught it by reading the fallback table — which is why the table is in
   this doc rather than in a reviewer's head.

3. **The CSP3 fallback table.** Enumerate the dependants from here, in writing, in the change that
   touches the policy:

   | directive                                                                                                  | resolves through                                     |
   | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
   | `script-src`, `style-src`, `img-src`, `connect-src`, `font-src`, `media-src`, `object-src`, `manifest-src` | `default-src`                                        |
   | `script-src-elem`, `script-src-attr`                                                                       | `script-src` → `default-src`                         |
   | `style-src-elem`, `style-src-attr`                                                                         | `style-src` → `default-src`                          |
   | `child-src`                                                                                                | `default-src`                                        |
   | `frame-src`                                                                                                | `child-src` → `default-src`                          |
   | `worker-src`                                                                                               | `child-src` → `script-src` → `default-src`           |
   | `base-uri`, `form-action`, `frame-ancestors`, `sandbox`                                                    | **nothing** — omitted means unrestricted, not denied |

   **The table is a floor, not a census.** Its source is the fallback list in the CSP3 specification
   (W3C, _Content Security Policy Level 3_, the fetch directives and their "fallback" wording), and
   that list is what a change enumerates against — a directive missing from the rows above is a gap in
   this table, not evidence that nothing inherits from it. A directive the spec adds, or one nobody
   here had reason to write down, is found by reading the source and is added as a row in the same
   change that needs it.

   Read the chains in both directions. Downwards they say what an omitted directive falls back to.
   Upwards they say which directives a change to `child-src`, `script-src`, `style-src` or
   `default-src` has just moved underneath you — `script-src` alone moves `worker-src`,
   `script-src-elem` and `script-src-attr`.

4. **Omission has a meaning; state it when you touch the policy.** An absent CSP directive is never
   simply "not configured". It either inherits per the table above, or — for the bottom row — leaves
   that capability entirely unrestricted. `frame-ancestors` and `base-uri` have to be declared in order
   to be denied; an omitted `img-src` is already governed by `default-src`.

   The same reasoning runs the other way in CORS, where an absent header denies cross-origin use rather
   than permitting it. A CORS config is therefore never "completed" by widening it to a wildcard so that
   something works. Where a wildcard is deliberate, its owner says so in place and names the ticket that
   removes it.

   The owners here are `infra/api/gateway.tf`'s `cors_configuration` block, which sets what the gateway
   attaches, and `routeRequest` in `apps/api/src/http/router.ts`, which owns the preflight boundary —
   that API's `$default` route matches `OPTIONS` too, so a preflight reaches the Lambda instead of being
   auto-answered. Keep the preflight-only fields separate from ordinary ones: `allow_methods`,
   `allow_headers` and `max_age` govern the preflight and nothing else, so a change there says nothing
   about what a plain `GET` response carries.

5. **A policy proven only by config validation is a string nobody loaded a browser against.**
   `terraform validate` and a clean plan tell you the header parses as HCL, not that the app boots under
   it.

   Every CSP change runs under the browser lane before it ships. `apps/web/e2e/content-security-policy.ts`
   renders the identically-produced header from the same owning template and serves it over the built
   app, so map boot, worker boot and the attribution links are exercised against the enforcing policy
   rather than an unenforced approximation. That file and `infra/web/security-headers.tf` jointly own
   the rendering contract between them and each names the other; do not restate it in a third place.

## Why

#176 is the honest shape of the gap this doc closes. Nothing was silent — the standards index fired, and
typed code, a new module and new tests were all written under rows that matched. Every row that answered
simply answered about something else.

The defect class has no home in types, components, structure, failures or tests: it is a directive whose
absence inherits from another directive, where the safe-looking edit is the one that opens the hole, and
where the only thing that catches it is enumerating dependants before a reviewer does. That surface is
small today — one response-headers policy, one CSP template, one CORS answer — and it is also the surface
where a mistake is least visible from the outside, which is the argument for writing the question down
rather than trusting it to recur to someone.
