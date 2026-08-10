import { z } from 'zod';

/*
 * zod runs interpreted in the browser, because the CSP the edge serves does not
 * grant `'unsafe-eval'`.
 *
 * `infra/web/content-security-policy.tftpl` says `script-src 'self'`, so `eval`
 * and the `Function` constructor are denied. zod's object parser wants a JIT: it
 * compiles a validator with `new Function` when it can, and asks whether it can
 * by *probing* — `allowsEval` in `zod/v4/core/util.js` runs `new Function("")`
 * inside a `try` and reads the throw as the answer. The probe is lazy but it is
 * read at schema-construction time, i.e. while a module that declares a schema
 * is still evaluating, and CSP reports a denial whether or not the throw is
 * caught. So the app degraded correctly and still fired a
 * `securitypolicyviolation` and a console error on every production page load.
 *
 * `jitless` removes the question rather than tolerating the answer. In
 * `zod/v4/core/schemas.js` the parser computes `jit = !globalConfig.jitless`
 * and then `fastEnabled = jit && allowsEval.value`, so with `jitless` set the
 * `&&` short-circuits and `allowsEval.value` is never read — the probe does not
 * run at all. (4.4.3's `allowsEval` also returns `false` up front under
 * `jitless`, so it is belt and braces.) The cost is the interpreted parse path,
 * which is what the app was already falling back to under the denial.
 *
 * **This module must evaluate before any module that constructs a zod schema.**
 * `globalConfig` is read when a schema is built, not when it is parsed, so a
 * schema constructed ahead of this call keeps the JIT and probes. In practice
 * that means before `App`'s import of `@cumulo/shared`, which is why
 * `main.tsx` imports this file first and says so there. `main.tsx` is the only
 * entry point, and no other module under `apps/web/src` imports zod for its
 * value — only `import type { ZodType }`, which is erased.
 *
 * The ordering contract is held by a test rather than by care:
 * `apps/web/e2e/security-headers.spec.ts` boots the built app under the real
 * header and asserts zero violations, so an import moved back below `App`'s
 * fails that spec with the eval violation named.
 *
 * Why `apps/web` owns this and not `@cumulo/shared`: zod's config is
 * per-realm — `globalConfig` is `globalThis.__zod_globalConfig`
 * (`zod/v4/core/core.js`) — so this call reaches only the browser realm it runs
 * in. Setting it in the shared package instead would run in every consumer
 * process, switching the JIT off in `apps/api`, `apps/ingestion` and
 * `apps/forecast`, which have no CSP and for which the JIT is a real, if small,
 * win. The constraint is the browser's; the setting belongs where the
 * constraint is.
 */
z.config({ jitless: true });
