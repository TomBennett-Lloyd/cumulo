---
name: budget-sync
description: Record the user's /usage percentages into the machine-local budget ledger and report the resulting model-budget mode (normal/conserve) that governs Fable dispatch. Use when the user reports usage numbers, asks about budget mode, or before a heavy orchestration run.
---

You feed the machine-local budget ledger, which decides the mode that every Fable dispatch consults (see CLAUDE.md Model tiers). The ledger lives outside the repo — this skill maintains no repo file, and the mode value is never written into the repo.

1. **Plan change first.** If the user has switched plan since the last sync, run this _before_ recording any numbers, so the new allowance starts a fresh baseline:

   ```
   node ~/.local/share/claude-budget/bin/claude-budget.js epoch --plan <plan name> --note "<why>"
   ```

2. **Get the numbers.** If the user hasn't provided them, ask them to glance at `/usage` and report: 5-hour %, weekly %, and the Fable-specific weekly % (limits are shown only as percentages).

3. **Record the observation:**

   ```
   node ~/.local/share/claude-budget/bin/claude-budget.js observe \
     --five-hour N --weekly N --fable-weekly N \
     --source "user /usage report" --session <session id if known>
   ```

   Omit any `--five-hour` / `--weekly` / `--fable-weekly` flag the user didn't report — do not guess a value. Omit `--session` if the session id isn't known.

4. **Report back**: read `~/.local/state/claude-budget/mode` and tell the user the resulting mode and what it changes (conserve = planning/consulting downgrade from Fable to Opus, with every downgrade noted in the relevant issue). If the numbers sat near the edge of a change, say so.

Interpretation notes:

- The 5-hour window resets quickly — a high 5-hour % alone near end-of-session matters less than a high weekly %. Use judgement and say what you assumed.
- These percentages include the user's claude.ai/mobile usage, which local tracking can never see. Reported numbers are authoritative and override any local estimate.
