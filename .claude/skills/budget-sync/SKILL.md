---
name: budget-sync
description: Record the user's /usage percentages and set the model-budget mode (normal/conserve) that governs Fable dispatch. Use when the user reports usage numbers, asks about budget mode, or before a heavy orchestration run.
---

You maintain `.claude/budget.json`, which every Fable dispatch decision consults (see CLAUDE.md Model tiers).

v1 — manual calibration:

1. If the user hasn't provided numbers, ask them to glance at `/usage` and report: 5-hour %, weekly %, and the Fable-specific weekly % (they are on Max 5x; limits are shown only as percentages).
2. Append `{ "date": "<ISO date>", "five_hour_pct": n, "weekly_pct": n, "fable_weekly_pct": n }` to `history`; set `last_reported` to the same object.
3. Set `mode` per the thresholds in `policy.conserve_when` (any threshold met → `"conserve"`, else `"normal"`).
4. Report back: the mode, and what it changes (conserve = planning/consulting downgrade from Fable to Opus, downgrades noted in issues).

Interpretation notes:

- The 5-hour window resets quickly — a high 5-hour % alone near end-of-session matters less than a high weekly %. Use judgement and say what you assumed.
- These percentages include the user's claude.ai/mobile usage, which local tracking can never see — that's why v1 trusts reported percentages over any local estimate.

Future (ticketed, do not build ad hoc): local transcript ledger (`~/.claude/projects/*/*.jsonl` token sums, price-weighted) + implied-limit calibration from reported percentages, so `mode` updates without manual syncs.
