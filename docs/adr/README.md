# Architecture Decision Records

Numbered, immutable once **merged** (supersede rather than edit). Before merge an ADR is still a draft under review: amending it in place in response to review feedback is correct, and cheaper than merging a decision you already know is wrong and superseding it immediately. Write one when a decision is expensive to reverse, cross-service, or would surprise a newcomer — see `docs/standards/architecture.md` rule 6.

Format: copy `0000-template.md` → `NNNN-short-title.md`, then add a row to the index below.

The index is not decorative: `pnpm verify` runs `scripts/check-adr-index.sh`, which fails if a
`NNNN-*.md` file here has no index row, or if a row links a file that does not exist under that
number. Rows must keep the `- [NNNN — Title](NNNN-slug.md)` shape the gate parses.

## Index

- [0001 — Service boundaries](0001-service-boundaries.md)
- [0002 — Storage split](0002-storage-split.md)
- [0003 — PV physics model runtime](0003-pv-model-runtime.md)
