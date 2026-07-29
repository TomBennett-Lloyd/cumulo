---
name: burn-backlog
description: 'PHASE 2 — NOT YET ACTIVE. Orchestrate a fleet of agents through the issue backlog with conflict-aware scheduling and rebase handling. Do not use until the single-ticket loop has been through several retros.'
---

**STATUS: design stub.** If invoked now: explain that this activates after the single-ticket workflow (plan-issue → execute → review-loop → retro) has stabilized over several tickets, then stop. Do not orchestrate.

## Design sketch (refine before activation)

- **Unit of work**: one issue = one isolated git worktree = one full plan-issue → execute → review-loop run.
- **Wave scheduling**: pick the next wave (max 2–3 concurrent) by area-label disjointness — never two concurrent tickets touching the same package/app. Rebase churn grows superlinearly with wave size; small waves are the point.
- **Debt-first rule**: before scheduling a feature ticket, check for open `tech-debt` issues touching the same files (triage marks these "do before #n"). Run the debt ticket first so the feature starts from the good pattern instead of expanding the bad one.
- **Merge discipline**: merges are serialized. After each merge, surviving worktrees rebase onto main before continuing; a rebase with conflicts pauses that ticket for orchestrator attention rather than letting an agent resolve conflicts unsupervised.
- **Budget awareness**: check `.claude/budget.json` before each wave; conserve mode shrinks wave size to 1 and downgrades planning to Opus.
- **Escalation unchanged**: BLOCKED/STRUGGLING behave exactly as in /execute, but the orchestrator handles them per-worktree.

## Activation checklist

- [ ] ≥5 tickets through the single-ticket loop; retros stabilized (no workflow-change PR needed for 2 consecutive tickets)
- [ ] CI green on main, branch protection on
- [ ] Area labels exist and are applied to all open issues
- [ ] This sketch reviewed and promoted to real skill steps
