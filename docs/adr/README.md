# Architecture Decision Records

Numbered. Once **merged**, a decision is immutable: changed your mind → supersede, never rewrite. Stated parameter values that the code later legitimately moves are the one narrow exception — see **Amendments** below. Before merge an ADR is still a draft under review: amending it in place in response to review feedback is correct, and cheaper than merging a decision you already know is wrong and superseding it immediately. Write one when a decision is expensive to reverse, cross-service, or would surprise a newcomer — see `docs/standards/architecture.md` rule 6.

Format: copy `0000-template.md` → `NNNN-short-title.md`, then add a row to the index below.

The index is not decorative: `pnpm verify` runs `.claude/scripts/check-adr-index.sh`, which fails
if a `NNNN-*.md` file here has no index row, or if a row links a file that does not exist under
that number. Rows must keep the `- [NNNN — Title](NNNN-slug.md)` shape the gate parses.

A row may carry one optional annotation after the link — an em dash with a space on each side,
then non-empty text — which is where supersession is recorded, since ADRs are superseded rather
than edited:

```
- [0002 — Storage split](0002-storage-split.md) — superseded by 0007
```

The suffix is optional but not free-form: `— ` with nothing after it, or an annotation that
misses the separator, is a malformed row and fails the gate.

Two more things the gate checks, so that a decision's standing can be read mechanically:

- **Status.** Every `NNNN-*.md` except `0000-template.md` must carry a `Status:` line in its
  header (above the first `##` section) whose value is exactly `proposed`, `accepted`, or
  `superseded by NNNN` — the template's vocabulary, lower-case. Markup around the label is up
  to you (`- **Status:** accepted` is what the existing ADRs use); the value is not.
- **Supersession pointers.** Any `superseded by NNNN`, whether in a Status line or an index
  annotation, must name an ADR file that exists here. The template's own `0000` does not count:
  it is a form, not a decision.

## Amendments

A merged ADR's decision, rationale, and status never change — retconning a decision is what
supersession exists to prevent, and git preserves every prior version regardless. But an ADR
also states facts — parameter values, sizes, counts — that code legitimately moves later, and
a stale number in an authoritative document misleads every reader who takes it as current;
planners here are _instructed_ to read ADRs before code, so wrong numbers propagate into plans
silently (decided 2026-08-01, prompted by #122 moving a retry budget ADR 0002 states).

When only a stated value has moved and the decision stands:

- true the value up inline where it appears, and
- append a dated entry to an `## Amendments` section at the bottom of the ADR: old value →
  new value, the driving issue/PR, and the code location that now owns the value.

The guardrail: an amendment never touches reasoning. If you find yourself rewording _why_,
that is a supersession in disguise — write the new ADR.

## Index

- [0001 — Service boundaries](0001-service-boundaries.md)
- [0002 — Storage split](0002-storage-split.md)
- [0003 — PV physics model runtime](0003-pv-model-runtime.md)
- [0004 — Ingestion transport](0004-ingestion-transport.md)
- [0005 — Fleet API compute and hosting](0005-fleet-api-hosting.md)
- [0006 — Demo abuse and cost protection](0006-demo-abuse-protection.md)
