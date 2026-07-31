---
name: execute
description: Execute a planned issue by dispatching plan chunks to implementer sub-agents, independently verifying each result, and keeping the plan status updated on the issue.
---

You are orchestrating execution of an approved plan (in the issue's comments). Your context stays clean: sub-agents do the work; you verify, sequence, and re-plan.

1. **Worktree, always**: `git worktree add .claude/worktrees/<n>-<slug> -b <n>-<slug> origin/main`. Every task gets its own worktree even when it is the only one running — the main checkout stays on `main` so concurrent tasks, verification, and `/burn-backlog` never contend for it. Task-local untracked state (Terraform `backend.hcl`, `.terraform/`, local overrides) lives in that worktree for the task's lifetime. Never work on `main`. A fresh worktree gets its own `node_modules` from the SessionStart hook (`.claude/hooks/ensure-deps.sh`); if it is absent, run `pnpm install --frozen-lockfile` in the worktree yourself. To continue in a worktree whose previous task has already merged, reuse it instead of creating another: `bash .claude/scripts/rebranch-worktree.sh <n>-<slug>` rebases it onto updated `main` and keeps `node_modules` warm. For Terraform tasks, export `TF_PLUGIN_CACHE_DIR=~/.terraform.d/plugin-cache` (create the directory once) before `terraform init` — a fresh worktree otherwise re-downloads providers and can stall a timeboxed command.
2. **Load the plan**; compute dependency waves. Chunks in the same wave with no file overlap run in parallel — spawn their `implementer` agents in a single message.
3. **Dispatch** each chunk with: the chunk's full text verbatim, the plan's Context section, and nothing else it doesn't need.
4. **On each return, by status**:
   - `DONE` → verify independently: run the chunk's `Verify:` command yourself and spot-check the diff against each acceptance criterion. Trust but verify — an agent's own report is a claim, not evidence.
   - `PARTIAL` / `BLOCKED` → update the plan: minor adjustment inline, or re-run the planner for structural changes. Record what changed and why as an issue comment before re-dispatching.
   - `STRUGGLING` → read `~/.local/state/claude-budget/mode` (missing file → `normal`); spawn the `consultant` agent (Fable, or Opus if conserving — note it) with the implementer's full report. Re-dispatch the SAME chunk to a fresh `implementer` with the consultant's guidance attached. The consultant never implements.
   - `DISCOVERED:` items → `gh issue create --label discovered` for each (or comment on an existing issue). Never act on them in this task.
   - **Transient API failure in a parallel dispatch batch** → before re-dispatching anything, verify WHICH call actually failed by matching the surviving returns against each dispatch's description. Re-dispatching a chunk that is still running plants a duplicate in the same worktree; the implementer's pre-existing-files guard makes the duplicate return BLOCKED, but the correct move is not to create it.
5. **After each wave**: run `pnpm verify` yourself at the wave boundary — parallel chunks share the task worktree, so a composite red mid-wave caused by a sibling's in-flight files means nothing, and only the settled-tree run is evidence. Then commit completed work with a descriptive message referencing the issue; update the plan comment with per-chunk status (checkboxes).
6. **All chunks done** → run `pnpm verify` at repo root → invoke `/review-loop`.
