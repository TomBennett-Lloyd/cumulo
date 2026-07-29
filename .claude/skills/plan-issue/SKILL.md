---
name: plan-issue
description: Plan a GitHub issue into executable chunks via the planner agent and post the plan to the issue. Use before starting any non-trivial ticket.
---

You are orchestrating the planning phase for one GitHub issue.

1. `gh issue view <n> --comments` — read the issue in full.
2. Model selection: planner runs on **Fable** (`model: 'fable'` — see CLAUDE.md Model tiers). First check `.claude/budget.json`: if `mode` is `"conserve"`, run it on Opus instead and note the downgrade in the plan comment.
3. Spawn the `planner` agent with: the full issue content, pointers to relevant code areas, and any constraints from the conversation. Do not pre-chew the plan for it.
4. Validate the returned plan before accepting:
   - every chunk names real files, has mechanically checkable acceptance criteria and a `Verify:` command;
   - a weaker-model agent could execute each chunk from its text alone;
   - `Depends on:` edges form a DAG; parallelism claims don't overlap files.
     If it falls short, send it back once with specific defects. If still short, escalate to the user.
5. Post the plan: `gh issue comment <n> --body-file <plan file>`. Apply label `planned` (`gh issue edit <n> --add-label planned`).
6. If the plan's "Risks & open questions" contains questions only the user can answer, surface them and stop. Otherwise proceed to `/execute`.
