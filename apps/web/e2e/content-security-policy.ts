import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/*
 * The second reader of the CSP the edge will serve.
 *
 * The policy text has exactly one owner — `infra/web/content-security-policy.tftpl`
 * — and two readers render it. Terraform's `templatefile()` call in
 * `infra/web/security-headers.tf`'s `locals` is the one CloudFront ships; this
 * module is the other, and `vite.config.ts` hands its output to `vite preview`
 * as a real response header so the whole browser lane runs under the enforcing
 * policy. Neither reader restates the text (`architecture.md` rule 9): both read
 * the same file off disk.
 *
 * What *is* implemented twice is the rendering rule — substitute the API origin,
 * split on newlines, trim each line, drop the empties, join with "; " — because
 * one side is HCL and the other is TypeScript and there is no artefact both can
 * import. That duplication is the point of this comment and of the matching one
 * in `security-headers.tf`: the two implementations are the same intent and
 * would be wrong apart (`structure.md` rule 7), so a change to either is a
 * change to both, and each side's comment names the other.
 *
 * The lane is the evidence the Terraform stack cannot produce on its own. The
 * distribution is not appliable yet, so a policy proven only by `terraform
 * validate` would be a string nobody had ever loaded a browser against.
 */

/**
 * The template's one interpolation, spelled exactly as Terraform spells it.
 *
 * A plain string rather than a template literal on purpose — `${…}` is literal
 * text here, and TypeScript would otherwise try to interpolate the very thing
 * being matched.
 */
const API_ORIGIN_PLACEHOLDER = '${api_origin}';

/**
 * The owning template, resolved from this module rather than from the process's
 * working directory — `vite preview`, `vite build` and the Playwright runner all
 * start from different ones.
 */
const TEMPLATE_PATH = fileURLToPath(
  new URL('../../../infra/web/content-security-policy.tftpl', import.meta.url),
);

/**
 * The header value `infra/web/security-headers.tf` renders for the same
 * `api_origin`, computed from the same file.
 *
 * `apiOrigin` is the Fleet API origin, or `''` — matching `local.csp_api_origin`'s
 * two arms, including the single leading space that belongs to the `connect-src`
 * separator rather than to the value.
 *
 * Which arm is which is worth being exact about, because this lane only ever
 * runs one of them. Empty is demo mode here — `playwright.config.ts` pins
 * `VITE_API_BASE_URL: ''` — and in Terraform it is the pre-API state that lets
 * `infra/web` plan before `infra/api` exists (`infra/web/variables.tf`). It is
 * *not* a deployment mode: both deploy workflows refuse to publish a build
 * without an API base URL, so the non-empty arm is the only one that ever
 * reaches a browser outside this repo. `security-headers.spec.ts` asserts that
 * arm directly, as a pure computation, for exactly that reason.
 *
 * A template that no longer contains the placeholder throws rather than
 * rendering. Substituting nothing into nothing would produce a policy that is
 * still perfectly valid and silently missing the API origin, which is the
 * failure mode where the app works locally and cannot reach its own API in
 * production; a renamed or removed placeholder is wiring that could not have
 * been assembled correctly, so it is an exception and not a value
 * (`error-handling.md` rule 1).
 */
export const renderContentSecurityPolicy = (apiOrigin: string): string => {
  const template = readFileSync(TEMPLATE_PATH, 'utf8');

  if (!template.includes(API_ORIGIN_PLACEHOLDER)) {
    throw new Error(
      `${TEMPLATE_PATH} no longer contains the ${API_ORIGIN_PLACEHOLDER} placeholder, so the API origin cannot be rendered into it. If the placeholder was renamed, rename it here too.`,
    );
  }

  return template
    .replaceAll(API_ORIGIN_PLACEHOLDER, apiOrigin === '' ? '' : ` ${apiOrigin}`)
    .split('\n')
    .map((directive) => directive.trim())
    .filter((directive) => directive !== '')
    .join('; ');
};
