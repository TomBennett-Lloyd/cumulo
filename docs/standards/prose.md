# Prose — code comments, docblocks, and standing documentation

The unit of value is the claim, not the line. Standing prose is a liability that must earn its keep: nothing in `verify` fails when it rots. These rules keep the prose surface small enough to sweep and true — and they bind `.claude/` skills, agent docs, and `docs/` exactly as they bind source, because process prose rots the same way.

## Rules

1. **The code explains itself first.** A comment is the fallback, not the default: prefer a name that carries the meaning — a well-named constant over a comment defining one, a small named helper over a paragraph narrating a block. A long docblock on ordinary code is a smell that the code wants restructuring, not narrating. What earns lines: constraints the code cannot express, invariants, and the why behind a non-obvious choice. What never does: restating what the code visibly says.

2. **Figures live in tests, not prose.** A measured or derived figure — a pixel, a count, a threshold, a duration — appears in standing prose only when a named test or gate asserts it, or when it is approximate by form (`~330 kW`, "thousands") and survives any plausible drift. Otherwise the number goes into a test and the prose keeps the argument: a figure in a comment rots silently, the same figure in a test fails loudly. When a measured value moves, the edit is to the asserting test; prose that named the test needs nothing. Worked examples and tuned inputs have their own mechanics in `docs/standards/architecture.md` rule 12.

3. **References are greppable, never paraphrased.** Prose that refers to other code names it verbatim — the repo-relative path (`apps/web/src/dashboard/fleet-panel.css`) or the exported identifier (`CHART_VIEW_BOX_HEIGHT`) — and does not restate what it says. Changing X then finds every comment about X mechanically: `git grep` for X's path and symbols is the sweep. A paraphrase ("the stylesheet that sizes the row") is invisible to every sweep and rots without a trace. Owned values additionally keep architecture.md rules 8–10's mirror-gate and ledger machinery; this rule governs the references that machinery does not reach.

4. **Architectural reasoning cites the record.** Where the why is a recorded decision, write one sentence of local relevance and cite the owner — an ADR by filename, or a standard's rule by number. Restating the argument inline creates a second copy that drifts from the first.

5. **Condense on touch.** Editing a file makes its prose part of the edit: trim what the code now shows, convert paraphrases to verbatim references, move figures into the tests that assert them. Wholesale trims of untouched files are campaign work (#467), never drive-by scope.

## Why

Adopted by owner decision, 2026-08-25 (#464). At adoption, 45% of `apps/web/src` was comment lines; review loops converged on prose findings while finding zero behaviour bugs; and the period's one serious defect was environmental — a class no prose-reading review can catch. The prose surface had become the main cost of every change without being the main source of risk.
