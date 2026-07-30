# Review-feedback log

Every substantive piece of human review feedback — on plans or PRs — gets an entry here as it is addressed. `/retro` mines this log to update standards and agent guidance; a category going quiet across consecutive reviews is the evidence for graduating that gate toward autonomy (a flag flip in `.claude/workflow.json`, proposed as its own PR, decided by the user).

Entry format:

```
## YYYY-MM-DD — PR/issue #n
- Category: plan | code-style | architecture | testing | other
- Feedback: what the user asked for, verbatim where short
- Action: what changed in response (code fix, standards edit, agent-guidance edit, or none + why)
```

---

## 2026-07-30 — PR #26

- Category: other (merge-policy calibration)
- Feedback: Config-only PRs should auto-merge — "the json file in there didn't matter, i'm more on about actual code … how you're structuring functions and modules and components."
- Action: merge rule refined from "every changed file is .md" to "no source-code files"; encoded in `.claude/workflow.json` (this PR).

## 2026-07-30 — issue #2 (plan review)

- Category: plan
- Feedback: "ADRs should always require a human review" — major decisions, the right altitude for human guidance without going deep into code.
- Action: `docs/adr/**` added to `merge.humanAlways`; `adr` added to `planApproval.alwaysRequiredFor`; skills updated (this PR).
