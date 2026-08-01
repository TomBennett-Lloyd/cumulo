/*
 * The build-time environment this app reads, declared.
 *
 * Vite's own `ImportMetaEnv` (loaded globally by `"types": ["vite/client"]` in
 * this package's tsconfig) extends `Record<string, any>`, so an undeclared key
 * arrives as `any` — the one shape `typing.md` rule 2 refuses, and one the
 * linter would let through silently at the call site. Declaring the key here
 * merges with that interface and makes the read a plain `string | undefined`
 * that `selectFleetDataSource` can be trusted to have parsed.
 *
 * No top-level import or export: this file has to stay a global script for the
 * merge to happen at all.
 */

interface ImportMetaEnv {
  /**
   * Origin of the deployed Fleet API, e.g. `https://abc123.execute-api.eu-west-1.amazonaws.com`.
   *
   * Absent or blank selects the in-memory demo fleet — see `apps/web/.env.example`.
   * Read in exactly one place, `App.tsx`, and validated by
   * `src/data/fleet-source-selection.ts`.
   */
  readonly VITE_API_BASE_URL?: string;
}
