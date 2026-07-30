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
6. Check `.claude/workflow.json` → `planApproval`. If `mode` is `required` **or** the issue carries any label listed in `planApproval.alwaysRequiredFor` (e.g. `adr` — major decisions always get a human, even after graduation to `auto`): surface a plan summary and link to the user and STOP — do not `/execute` until the user approves. Log any plan feedback they give to `docs/review-feedback.md` (category `plan`) as you address it. If `auto`: proceed to `/execute` unless the plan's "Risks & open questions" contains questions only the user can answer — surface those first.
