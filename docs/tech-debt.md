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
