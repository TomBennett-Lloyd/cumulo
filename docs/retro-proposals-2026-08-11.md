# Retro proposals — 2026-08-11

Four items from the 2026-08-11 retro pass that touch a `humanAlways` path (`CLAUDE.md`) or ask a question only the owner can answer. **Nothing here is applied.** The rest of that pass's dispositions — the `review-loop`, `plan-issue`, `planner.md`, `browser-smoke.md` and `stylelint.config.mjs` changes — landed in the same PR as this file, because none of them touches a gated path.

The convention this file follows is the one `docs/retro-proposals-2026-08-10.md` set: proposals live here until decided, the PR that applies them **deletes this file**, and the decisions are recorded in `docs/review-feedback.md`.

Each item states the evidence, the exact text proposed, what it costs, and what happens if it is declined — so declining is a real option rather than a deferral.

---

## P1 — A standards-index trigger row for security-policy authoring

**Evidence (#176, PR #393).** A security ticket, planned on Fable and implemented on Opus, shipped a same-origin framing hole: `child-src 'self'` was added _defensively_, and CSP3 gives `child-src` two dependants — `worker-src` **and** `frame-src` — so the one directive added for safety is what opened the gap. Review cycle 1 caught it by reading the CSP3 fallback table. **No standards trigger fired, because none exists**: the index has rows for types, React, architecture, structure, error handling, testing and design, and the generic ones cannot reach this work — no type was written, no component touched, no module added. #176's handover calls this the clearest under-firing in the ticket.

**Proposed row**, to sit after the `error-handling.md` row:

> - Writing or changing a security policy whose directives have fallback semantics — a CSP, a CORS policy, any response header where an omitted directive inherits from another? → `docs/standards/security.md`

**The row cannot land alone.** There is no `docs/standards/security.md`, and the index's own contract is that a row points at a self-contained doc, one hop, no chained references. So P1 is really two decisions:

1. **Is this a standards area at all?** The repo's security surface today is one CloudFront response-headers policy, one CSP template, and the API's CORS answer. That is small — and it is also the surface where a mistake is least visible from the outside, which is the argument for a doc rather than against one.
2. **If yes, what does the doc hold?** The minimum that would have caught `frame-src`: the fallback chains as a table (`default-src` → `script-src`/`style-src`/`img-src`/`connect-src`/`font-src`/`media-src`/`object-src`/`frame-src`/`child-src`; `child-src` → `worker-src` + `frame-src`), a deny-by-default posture stating that a directive is added only when its absence is shown to break something, and the rule that adding a directive requires naming every directive that inherits from it. Roughly a page.

**Cost if adopted**: one new standards doc to write and keep true, plus one more row in an index whose value depends on staying short. **Cost if declined**: the next CSP, CORS or header change is reachable by no trigger, exactly as #176 was; the mitigation would be that security-adjacent tickets name the fallback question in their plans by hand, which is what happened here and arrived one review cycle late.

---

## P2 — A standards-index trigger for changing code whose comment argues for the behaviour being changed

**Evidence (#367, PR #394).** `layoutBoxOf`'s docblock explicitly **defended** the racing two-read shape that #367 existed to remove. Nothing in the index fires on "you are changing code whose comment justifies the behaviour you are removing" — the rows are about writing types, components, catches, tests. The plan caught it only because the orchestrator dispatched it as an explicit instruction. The same defect then **recurred twice inside the ticket**: cycle 1 found three inaccuracies in the replacement prose, and cycle 2 found that cycle 1's own new tech-debt entry asserted something false about Playwright's `toBeVisible`.

This is a recognition failure, which is what the index is for — but it is not obviously its own row. Two forms, and the choice between them is the decision:

**Form A — extend the existing `structure.md` row** (smallest change, keeps the index short):

> - Creating or splitting a file, extracting/naming a helper, choosing function vs class, copy-pasting code — or changing behaviour that a comment beside it argues for, which makes that comment part of the change surface? → `docs/standards/structure.md`

**Form B — its own row**, on the grounds that the obligation is about _prose_ rather than about structure, and would sit more naturally beside `architecture.md`'s restatement discipline (rule 9 already governs a claim's carriers; this is the same idea for an argument's carrier).

**Cost if adopted**: one row, or one longer row; plus a paragraph in whichever doc receives it. **Cost if declined**: the defect is caught by whoever happens to read the comment. It is worth noting that it _was_ caught here, three times, by review — so the honest framing is that this trigger buys the finding earlier, not that it buys the finding at all.

---

## P3 — Gate question: does reinterpreting a `humanAlways` file's wording in prose trip the same gate as editing it?

**Evidence (#356, PR #395).** `CLAUDE.md`'s attribution constraint reads "at widths where the row cannot hold **it**" — the object being the weather phrase. The #356 branch read it as "the row as composed" (both credits' full forms), which is a **broader** condition, and stated that reading as the governing constraint at seven sites. Editing `CLAUDE.md` trips the `humanAlways` gate; silently reinterpreting it in prose trips nothing. Review cycle 2 caught it, not planning. The reinterpretation was made in good faith and is defensible on the text.

**The question**: should a branch that _restates or narrows the meaning of_ a `humanAlways` file's rule be gated the same way as one that edits the file?

Three answers, none obviously right:

- **No** — the gate is about who may change a file, and a reading is not a change. Cheapest, and it accepts that a wrong reading has to be caught by review, as this one was.
- **Yes, procedurally** — a branch that states a `humanAlways` rule's meaning anywhere carries the label. Catches the class, and makes the label fire on ordinary design-doc work often enough to erode it.
- **Yes, narrowly** — only when the restatement **broadens or narrows** the rule's scope rather than quoting it. Closest to the actual defect and the hardest to mechanise: nothing can tell a paraphrase from a re-scoping without reading both.

**Note**: a gate answer of "yes" in any form is a `.claude/workflow.json` change, which is itself `humanAlways`.

---

## P4 — What "the compact form" is conditioned on, in `CLAUDE.md`'s attribution constraint

**Evidence (#356, PR #395).** This is the substance underneath P3, and it stands on its own: the compact-form condition is currently ambiguous between two readings, and the branch shipped the broader one, documented as a judgement in `docs/design/map-treatment.md`.

- **Reading 1 (as written)**: the compact form is sanctioned at widths where the row cannot hold _the weather phrase_.
- **Reading 2 (as shipped)**: at widths where the row cannot hold _itself as composed_ — both credits at full form, which triggers roughly 96px broader than reading 1.

Reading 2 is what is deployed, and it is defensible: the row is what the user sees, and a row that overflows is not attribution either. But it means the bare linked name appears on wider viewports than the sentence in `CLAUDE.md` describes, and the hard constraint says the link itself is non-negotiable in every state — which both readings honour, so the licence obligation is not at risk under either.

**What is being asked**: endorse reading 2 and true `CLAUDE.md`'s sentence up to say so, or hold reading 1 and move the breakpoint. Either way this is a **breakpoint change, not a paragraph change** — the composition and the code follow the sentence, and `docs/design/map-treatment.md` already records the decision as a judgement pending this answer.

---

## What happens next

If P1/P2/P4 are approved, the applying PR edits `CLAUDE.md` (and creates `docs/standards/security.md` for P1), deletes this file, and carries its own `docs/review-feedback.md` entry under the on-branch merge ritual. If any is declined, the decision is recorded in `docs/review-feedback.md` with the reason, and this file is deleted just the same — a declined proposal is a decision, not a backlog item. P3, if answered "yes" in either form, is a separate `.claude/workflow.json` PR.
