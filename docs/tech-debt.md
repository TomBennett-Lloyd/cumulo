# Tech-debt log

A **buffer, not an archive**. `/review-loop` appends SYSTEMIC findings here instead of iterating on them; `/triage` periodically clusters entries, files root-cause GitHub issues, and **deletes** what it captured. A long-lived entry here means triage is overdue.

Entry format:

```
## YYYY-MM-DD — short title
- Where: file/module references
- What: the pattern or problem (symptom AND suspected root cause if known)
- Source: PR/issue #
```

---

## 2026-07-30 — seed parameter silently coerces to uint32

- Where: `packages/shared/src/fleet.ts` (`generateFleet`, mulberry32 seeding via `seed >>> 0`)
- What: `seed` is typed as bare `number` but coerced, so distinct inputs collide — `generateFleet(1)`, `generateFleet(1.5)`, and `generateFleet(4294967297)` all return the same fleet, and the "different seeds → different fleets" test only holds for distinct uint32s. Root cause is the missing branded type for a meaningful primitive (typing.md rule 1); a `FleetSeed` uint32 brand belongs in the #50 branded-unit retrofit rather than a local fix.
- Source: #9 review cycle 2

## 2026-07-30 — Timestamp brand is unenforced by any gate

- Where: `packages/shared/src/timestamp.ts`, `packages/shared/vitest.config.ts`, root `verify` script
- What: deleting `.brand<'UtcIsoTimestamp'>()` leaves `pnpm verify` fully green — the brand's whole purpose is to make a raw `string` unassignable to a timestamp field, and nothing checks that property. Runtime tests cannot: branding is type-level only. Root cause is a missing gate, not a missing test — Vitest's typecheck mode (`expectTypeOf`, `*.test-d.ts`) needs wiring into `verify` so type-level guarantees are as load-bearing as runtime ones. Cross-cutting: it protects every future brand, so it does not belong in this diff.
- Source: #10 review cycle 1

## 2026-07-30 — `uncertaintyBandSchema` / `UncertaintyBand` not exported

- Where: `packages/shared/src/forecast.ts`, `packages/shared/src/index.ts`
- What: the plan pinned four exports and the band is not one of them, so it stays module-private. #19's fleet aggregate needs exactly this vocabulary (summing per-site bands into a fleet band), and without a decision it will re-declare the concept in a second place. Decide before #19: export the schema and its inferred type, or standardize on `NonNullable<Forecast['uncertainty']>` as the referencing idiom. Either is defensible; silently having neither is what produces the duplicate.
- Source: #10 review cycle 1

## 2026-07-30 — Antimeridian double-representation in longitude bounds

- Where: `packages/shared/src/weather-reading.ts`, `packages/shared/src/site.ts`
- What: `longitude` accepts both −180 and +180, which are the same meridian. One physical location can therefore produce two distinct `locationId` partition keys (ADR 0002 rounds lat/long to 2 dp) and two separate Open-Meteo fetches for identical weather — a correctness split and an API-frugality leak. The fix is normalization at key-derivation time, which is #13's key-function territory, not a schema bound.
- Source: #10 review cycle 1

## 2026-07-30 — Latitude/longitude are unbranded, so a swapped pair parses cleanly

- Where: `packages/shared/src/weather-reading.ts`, `packages/shared/src/site.ts`
- What: both files declare `latitude`/`longitude` as bare `z.number()` with copy-pasted bounds. Structurally the two are the same type, so `{ latitude: -6.26, longitude: 53.35 }` — Dublin's coordinates transposed — parses without complaint and sends a weather fetch to a field in Kazakhstan; the duplicated bounds also drift independently. `typing.md` rule 1 names exactly this (physical-unit confusion, with lat vs lon as its worked example) as the case for branded types. The fix is one shared branded coordinate schema adopted by `site.ts`, ingestion (#11), and ADR 0002's `locationId` key function (#13) in a single move — a coordinated cross-module change, not a bound tweak, and it feeds the #50 branding retrofit. Adjacent to the antimeridian entry above: both are the same missing coordinate abstraction seen from different sides.
- Source: #10 review cycle 2

## 2026-07-30 — `.optional()` under `exactOptionalPropertyTypes` admits explicit `undefined`

- Where: `packages/shared/src/forecast.ts` (`uncertainty`), any future optional schema field
- What: Zod's `.optional()` produces `uncertainty?: T | undefined`, so `{ uncertainty: undefined }` parses even with `exactOptionalPropertyTypes` on — the key is present with an undefined value. DynamoDB `PutItem` marshalling throws on exactly that unless `removeUndefinedValues: true` is set on the document client. #13 needs a house rule (set the marshalling option, or strip undefined keys at the adapter boundary) so this fails at one known place rather than at runtime per-field.
- Source: #10 review cycle 1

## 2026-07-30 — Self-protection guards match paths as globs, not literals

- Where: `.claude/scripts/reap-worktree.sh`:84,109; `.claude/scripts/sweep-worktrees.sh`:69
- What: `case "$path" in "$wt" | "$wt"/*)` expands `$wt` as a glob pattern. A worktree path containing `[`, `*` or `?` can fail to match its own literal cwd, bypassing both the `own-cwd` and `live-session` guards — reap could then remove the directory the running session sits in. No work is lost (the tree must still be clean and merged to reach that point), and the repo's `<n>-<slug>` naming never produces such a path, so this is latent rather than live. The literal form is `[ "${pwd_canon#"$wt"}" != "$pwd_canon" ]`; the idiom repeats in three places, so the fix is one shared helper rather than three edits.
- Source: #42

## 2026-07-30 — Sweep shares stdin with its reap children

- Where: `.claude/scripts/sweep-worktrees.sh`:62-94
- What: the `while read` loop over worktree entries shares stdin (a heredoc) with each `reap-worktree.sh` child, which itself runs a caller-supplied `$WORKTREE_GH_CMD`. A child that reads stdin silently consumes worktree entries, and the sweep skips those worktrees without a word. The failure direction is safe (skipped = kept), but silent skipping in a backstop defeats the point of having a backstop — it would report `swept 0, kept 2` on a repo with five worktrees and look correct. Fix is `< /dev/null` on the child invocations.
- Source: #42

## 2026-07-30 — Reap re-derives the admin dir instead of using the one it was given

- Where: `.claude/scripts/reap-worktree.sh`:97
- What: `git_dir` comes from `rev-parse --absolute-git-dir` run inside the target, which searches ancestors. Because Cumulo nests worktrees _inside_ the main checkout (`.claude/worktrees/`), a worktree whose `.git` file is missing resolves to the **main repo's** `.git`. The min-age probe then measures the main checkout's activity and `is_clean` reports the main checkout's status — two safety guards judging a different repository than the one under consideration. Reproduced by the cycle-2 reviewer. Fail-safe today (`worktree remove` refuses validation, reap exits 2, nothing deleted), which is why it did not block. Structural fix: take the admin dir from the `worktree list --porcelain` block that reap already parses, rather than re-deriving it.
- Source: #42

## 2026-07-30 — Nothing resolves a stale worktree admin entry

- Where: `.claude/scripts/sweep-worktrees.sh`:106; `.claude/skills/execute/SKILL.md` step 1
- What: dropping the unconditional prune was correct (it destroyed recoverable admin data under `--dry-run`), but now nothing in the workflow clears a genuinely dead entry. Consequence, verified: `git worktree add` at that path fails with `fatal: … is a missing but already registered worktree`. Since the execute skill uses deterministic paths (`.claude/worktrees/<n>-<slug>`), a killed session whose directory was deleted by hand blocks re-execution of that same issue until a human prunes. Sweep detects it and re-counts it `kept` on every future run, so the warning repeats indefinitely. Git's own error names the remedy, so this is friction rather than a bug — wants a line in the skill docs or an explicit opt-in flag, not a behaviour change.
- Source: #42

## 2026-07-30 — `--dry-run` destroys nothing, but is not read-only

- Where: `.claude/scripts/worktree-lib.sh`:57 (`is_merged`), called from `reap-worktree.sh`:126 before the dry-run branch at :132
- What: `is_merged` runs `git fetch origin main` in the main checkout, so a dry sweep issues one fetch per candidate — writing remote-tracking refs and objects, plus whatever `gc --auto` decides. The mutation is additive and cannot lose work, so the safety property holds, but the distinction matters: the comments now say "destroys nothing" rather than "read-only". Making the fetch conditional on non-dry-run (or hoisting one fetch per sweep) would both restore the stronger property and remove N-1 redundant network calls.
- Source: #42

## 2026-07-30 — Lifecycle tooling has an undeclared python3 dependency

- Where: `.claude/scripts/worktree-lib.sh`:20,68 (and the porcelain parsing in `reap-worktree.sh`)
- What: a Node/pnpm repo's worktree tooling hard-depends on `python3` for realpath resolution, `worktree list --porcelain` parsing, and JSON handling. Failure is safe (exit 2 everywhere) but total, and it is invisible in `package.json` and CI, so a host without `python3` gets a lifecycle system that silently does nothing useful. `gh pr list --json headRefOid --jq …` and `git worktree list --porcelain -z` would remove most of the need. Related to #47 (CI does not run these scripts at all) and #48 (no shellcheck gate).
- Source: #42
