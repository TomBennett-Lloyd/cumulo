---
name: execute
description: Execute a planned issue by dispatching plan chunks to implementer sub-agents, independently verifying each result, and keeping the plan status updated on the issue.
---

You are orchestrating execution of an approved plan (in the issue's comments). Your context stays clean: sub-agents do the work; you verify, sequence, and re-plan.

1. **Branch**: `git checkout -b <n>-<slug>` from up-to-date `main`. Never work on `main`.
2. **Load the plan**; compute dependency waves. Chunks in the same wave with no file overlap run in parallel — spawn their `implementer` agents in a single message.
3. **Dispatch** each chunk with: the chunk's full text verbatim, the plan's Context section, and nothing else it doesn't need.
4. **On each return, by status**:
   - `DONE` → verify independently: run the chunk's `Verify:` command yourself and spot-check the diff against each acceptance criterion. Trust but verify — an agent's own report is a claim, not evidence.
   - `PARTIAL` / `BLOCKED` → update the plan: minor adjustment inline, or re-run the planner for structural changes. Record what changed and why as an issue comment before re-dispatching.
   - `STRUGGLING` → check `.claude/budget.json`; spawn the `consultant` agent (Fable, or Opus if conserving — note it) with the implementer's full report. Re-dispatch the SAME chunk to a fresh `implementer` with the consultant's guidance attached. The consultant never implements.
   - `DISCOVERED:` items → `gh issue create --label discovered` for each (or comment on an existing issue). Never act on them in this task.
5. **After each wave**: commit completed work with a descriptive message referencing the issue; update the plan comment with per-chunk status (checkboxes).
6. **All chunks done** → run `pnpm verify` at repo root → invoke `/review-loop`.
