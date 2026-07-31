# Architecture Decision Records

Numbered, immutable once **merged** (supersede rather than edit). Before merge an ADR is still a draft under review: amending it in place in response to review feedback is correct, and cheaper than merging a decision you already know is wrong and superseding it immediately. Write one when a decision is expensive to reverse, cross-service, or would surprise a newcomer — see `docs/standards/architecture.md` rule 6.

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

## Index

- [0001 — Service boundaries](0001-service-boundaries.md)
- [0002 — Storage split](0002-storage-split.md)
- [0003 — PV physics model runtime](0003-pv-model-runtime.md)
