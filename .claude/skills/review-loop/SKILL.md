---
name: review-loop
description: Iterate reviewer findings on the current branch until the quality bar is met, max 3 cycles. Systemic findings go to the tech-debt log instead of blocking. Ends by opening the PR.
---

You are orchestrating the quality loop on the current branch. Hard cap: **3 cycles**. The cap is what stops "exemplary quality" from becoming an infinite loop; the tech-debt log is where the overflow goes.

Per cycle:

1. Spawn the `reviewer` agent on the branch diff.
2. Partition its findings:
   - **FIX-NOW** → dispatch fixes to an `implementer` (batch related findings into one dispatch; trivial one-liners you may fix inline).
   - **SYSTEMIC** → append to `docs/tech-debt.md` in its entry format, with file refs and this PR as source. Do NOT attempt to fix them in this task.
3. Re-run checks (`pnpm verify`), next cycle.

Exit conditions:

- Reviewer returns `VERDICT: APPROVE` → done.
- Cap reached with findings outstanding: **correctness bugs must still be fixed — never merge a known bug, cap or no cap.** Remaining pure-quality FIX-NOWs get demoted to `docs/tech-debt.md` with a note that they were demoted at cap (this is signal for /retro: the bar and the cap are fighting).

Then:

4. Push branch; `gh pr create` — title references the issue (`Closes #n`), body summarizes what/why, links the plan comment, and notes any tech-debt entries this task added. Wait for CI green.
5. Classify the diff per `.claude/workflow.json`'s `merge.autoRule` / `merge.humanAlways`: **auto** (no source-code files — no `.ts`, `.tsx`, `.js`, `.mjs`, `.cjs`, `.sh`, `.py`, `.tf`, `.sql` — and nothing under `docs/adr/`) → merge (squash, delete branch) and run `/retro`. **human** (any source code, or any ADR) → add the `awaiting-review` label, notify the user with a one-paragraph review guide (what to look at, what decisions were made), and do NOT merge; continue with independent tickets. When the user reviews: log every substantive piece of feedback in `docs/review-feedback.md` (category + action), address requested changes (cycle cap still applies), and merge only after they approve. After merge: `/retro`.
