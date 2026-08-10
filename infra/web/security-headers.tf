# The security headers the edge attaches to every response in the distribution's
# one behaviour. S3 sets none of these — an object's stored metadata is the only
# thing an origin response could carry, and the deploy stores no security
# headers — so without this policy the SPA is served with no HSTS, no CSP and no
# `nosniff`, which is the whole of #176.
#
# Custom rather than the AWS-managed `SecurityHeadersPolicy`: the managed policy
# carries no Content-Security-Policy at all and its fields cannot be tuned, so
# adopting it would still leave the one header this ticket exists for unset. Both
# kinds are $0 standing — a response headers policy is configuration on a
# distribution that already exists, not a billable resource — so the choice costs
# nothing either way and is made purely on what can be expressed.
#
# ---------------------------------------------------------------------------
# The CSP text has exactly one owner: `content-security-policy.tftpl`, beside
# this file. Two readers render it, and neither restates it
# (`docs/standards/architecture.md` rule 9):
#
#   * this file, via the `templatefile()` call below, which is what the deployed
#     distribution serves;
#   * `apps/web/e2e/content-security-policy.ts`, which serves the same rendering
#     as a real response header on the built `dist` under `vite preview`, so the
#     whole Playwright lane — map boot, worker boot, the attribution trial-click
#     — runs under the enforcing policy before it is ever applied.
#
# That second reader is the evidence this stack cannot produce on its own: the
# distribution is not appliable yet, so a CSP proven only by `terraform validate`
# would be a string nobody had ever loaded a browser against. The rendering rule
# — split on newlines, trim each line, drop the empties, join with "; " — is the
# contract between the two, and is implemented identically on both sides. Change
# it here and you must change it there; each side's comment names the other.
# ---------------------------------------------------------------------------
#
# Why each directive, in the template's order. The template carries no comments
# of its own because every non-empty line in it becomes a directive, so the
# rationale has to live here:
#
#   * `default-src 'none'` — deny by default, then name what the app actually
#     needs. Several directives below would fall back to this and are listed
#     anyway, because a reader should not have to know the fallback table to see
#     what is allowed.
#   * `script-src 'self'` — Vite emits only external module scripts;
#     `dist/index.html` contains no inline script, so no hash or nonce is needed
#     and none is granted. No `'unsafe-eval'` either, and the app is built not to
#     want it: `apps/web/src/zod-jitless.ts` runs zod interpreted so that the
#     denial produces zero violation events rather than one per page load.
#   * `style-src 'self'` — production CSS arrives via `<link>`. React and
#     maplibre set styles through the CSSOM (`element.style.width = …`), which
#     CSP does not govern; what CSP *would* govern is `setAttribute('style', …)`,
#     and no such call exists in either built chunk (verified 2026-08-10 against
#     the dist on `main`). Hence no `'unsafe-inline'`.
#   * `img-src 'self' data:` plus the basemap tiles origin — `data:` for the
#     `data:image/svg+xml` control icons embedded in the maplibre CSS
#     (`MapRegion-*.css`); the tiles origin because raster and sprite image loads
#     may route through either `fetch` (governed by `connect-src`) or an `Image`
#     element (governed by `img-src`) depending on the engine, so both have to
#     admit it. The origin itself is spelled only in the template, and is owned
#     by `apps/web/src/map/basemap.ts`, whose restatement ledger lists every site
#     a provider swap has to move (`docs/standards/architecture.md` rule 9) —
#     which is why this bullet names the directive and not the host.
#   * `connect-src 'self'` plus the same tiles origin and the API origin — the
#     tiles origin serves the style JSON, the TileJSON, the vector tiles, the
#     sprites and the glyphs, all under that one origin (verified for
#     `positron`). The API origin is appended from `var.api_origin`; see the
#     local below and that variable's description for why it is a variable and
#     never a wildcard.
#   * `worker-src 'self'`, and no `blob:` — `apps/web/src/map/MapView.tsx` pins
#     maplibre's worker to a same-origin built asset via `setWorkerUrl`, and
#     maplibre's blob trampoline engages only for a cross-origin worker URL. A
#     `blob:` grant here would re-open arbitrary same-origin script execution for
#     no capability the app uses.
#   * `child-src 'self'` — the hop CSP2 engines consult for workers, which
#     learned `worker-src` later. Where `worker-src` is understood it wins and
#     this line governs no worker at all, which is why the line below has to
#     exist: `child-src` is *also* `frame-src`'s fallback, so on its own it
#     would have been the one directive in this policy that loosens rather than
#     tightens.
#   * `frame-src 'none'` — the app frames nothing, stated rather than left to
#     the chain, because the chain does not reach `default-src` here. CSP3's
#     fallback for a frame is `frame-src` → `child-src` → `default-src`, so with
#     `frame-src` undeclared the `child-src 'self'` above resolves framing to
#     same-origin. Declared, both hops land where they should: a CSP2 engine
#     takes this for frames and `child-src` for workers, and a CSP3 engine takes
#     this for frames and `worker-src` for workers. Not `frame-ancestors`, which
#     is below and points the other way — who may frame *us*.
#   * `font-src 'self'` and `manifest-src 'self'` — no third-party font or
#     manifest host; stated rather than left to `default-src 'none'` so that
#     adding one is a visible edit rather than a silent breakage.
#   * `base-uri 'none'`, `form-action 'self'`, `frame-ancestors 'none'` — none of
#     these three fall back to `default-src`, so omitting them would leave them
#     entirely unrestricted.
#
# What no directive here governs: outbound anchor links. The Open-Meteo credit,
# the OpenFreeMap and OpenStreetMap tile credits and the GitHub link are
# *navigations*, and navigations are governed by `navigate-to`, which is not in
# this policy and is not implemented by shipping browsers. `connect-src` and
# `default-src` do not apply to them. So do not "fix" a missing
# `https://open-meteo.com` entry — there is nothing to fix, and adding those
# origins to `connect-src` would grant a real capability (background fetch to
# them) that the app does not have and must not acquire quietly.

locals {
  # The API origin, ready to concatenate onto the end of the `connect-src` line
  # — hence the leading space, which belongs to the separator and not to the
  # value. Empty stays empty: the empty arm is the pre-API state — this stack
  # planning and applying before `infra/api` exists, per `var.api_origin` — and
  # its `connect-src` must not end in a stray space that a reader could mistake
  # for a dropped entry. Every distribution actually serving the deployed SPA
  # has an origin here; see that variable's description.
  csp_api_origin = var.api_origin == "" ? "" : " ${var.api_origin}"

  # The rendering contract, stated once and implemented twice — see the header
  # comment. `apps/web/e2e/content-security-policy.ts` runs this exact rule
  # (split on "\n", trimspace each line, drop the empties, join with "; ") over
  # the same file, which is what makes the header the browser lane enforces
  # byte-identical to the header the edge will serve.
  content_security_policy = join("; ", [
    for d in split("\n", templatefile("${path.module}/content-security-policy.tftpl", { api_origin = local.csp_api_origin })) :
    trimspace(d) if trimspace(d) != ""
  ])
}

resource "aws_cloudfront_response_headers_policy" "web" {
  name    = "cumulo-web-${var.environment}"
  comment = "Security headers for the cumulo-web-${var.environment} distribution — see infra/web/security-headers.tf"

  security_headers_config {
    content_security_policy {
      content_security_policy = local.content_security_policy
      override                = true
    }

    # Emits `X-Content-Type-Options: nosniff`. There is no value field: the
    # header has exactly one legal value and the provider models it as a
    # presence flag.
    content_type_options {
      override = true
    }

    # Belt to `frame-ancestors 'none'`'s braces, for engines that predate CSP
    # Level 2. The two say the same thing; where both are understood,
    # `frame-ancestors` wins and this is inert.
    frame_options {
      frame_option = "DENY"
      override     = true
    }

    # The full URL, path and query included, on a same-origin request; the
    # origin alone cross-origin over HTTPS; nothing at all on a downgrade to
    # HTTP. The outbound credit links are exactly the cross-origin case, and the
    # origin is what an attribution target may legitimately see.
    referrer_policy {
      referrer_policy = "strict-origin-when-cross-origin"
      override        = true
    }

    # One year, the value every HSTS preload guide converged on and the floor
    # browsers' own preload rules require.
    #
    # `include_subdomains = false` and `preload = false` are deliberate, not
    # unfinished. `includeSubDomains` pins names strictly *beneath* the host
    # that sent it — from `<id>.cloudfront.net` that is `*.<id>.cloudfront.net`,
    # not sibling distributions and not `cloudfront.net` itself — and no name
    # exists under this host, so the assertion buys nothing here. `preload` is
    # the one that would overreach: it is a request to have a domain baked into
    # browser binaries, not ours to make for `cloudfront.net`, and invalid
    # without `includeSubdomains` anyway. Both become worth revisiting when #21
    # brings a custom domain, alongside the ACM/alias seam already commented on
    # `viewer_certificate` in cloudfront.tf.
    #
    # Restatement ledger (`docs/standards/architecture.md` rule 9) for
    # this `max-age`: `infra/README.md`'s web Phase B header readback asserts
    # the number against the deployed `Strict-Transport-Security` response
    # header. An expectation computed from this attribute would assert nothing,
    # so it spells the number out; that is the asserting carrier rule 9 ledgers
    # rather than forbids, and it is the only member. Note that grepping the
    # digits alone finds three unrelated sites — `public,max-age=31536000,
    # immutable` on the hashed assets, in the same runbook and in
    # deploy-web.yml. Same number, different owner (the deploy's Cache-Control),
    # no relationship: changing either leaves the other correct.
    strict_transport_security {
      access_control_max_age_sec = 31536000
      include_subdomains         = false
      preload                    = false
      override                   = true
    }
  }

  # Permissions-Policy has no AWS-native field in `security_headers_config`, so
  # it goes through the custom-headers escape hatch. The app uses none of these
  # three: there is no `GeolocateControl` anywhere in `apps/web/src`, and nothing
  # touches `getUserMedia`. Denying them costs nothing and means a future
  # dependency cannot quietly start asking.
  custom_headers_config {
    items {
      header   = "Permissions-Policy"
      value    = "camera=(), geolocation=(), microphone=()"
      override = true
    }
  }
}

# `override = true` on every block above, argued once: the S3 origin sets no
# security headers at all, so there is nothing an origin value could be
# preserving. Making the edge the unconditional owner means the guarantee holds
# even if a future deploy stores object metadata that collides — a stray header
# on one object can never win, and cannot silently weaken one path through the
# distribution while every other path stays correct.
#
# Deliberately absent, in the house pattern of cloudfront.tf's closing note:
#
#   * `xss_protection` — the `X-XSS-Protection` header is deprecated and its
#     filtering behaviour was itself a vulnerability class. CSP supersedes it
#     entirely; setting it to anything would be noise, and setting it to `1`
#     would be worse than noise.
#   * COOP, COEP and CORP — the cross-origin isolation trio. Nothing here needs
#     `SharedArrayBuffer` or precise timers, and COEP would require the
#     third-party tile responses to opt in with CORP headers we do not control,
#     breaking the map for no benefit this app can spend.
#   * `Report-To` / `report-uri` — violation reporting needs an endpoint that
#     exists, is reachable and absorbs unauthenticated internet traffic, which
#     is a standing cost and an abuse surface against a hard ~$100/month
#     ceiling. The trade taken instead: enforce from the first deploy, and get
#     the evidence a report endpoint would have produced *before* merge, from
#     the Playwright lane described in the header comment.
