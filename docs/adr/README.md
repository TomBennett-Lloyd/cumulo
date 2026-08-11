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

When only a stated value has moved and the decision stands, an amendment has two halves, and one
of them is always written. **The dated entry is not optional**: append it to an `## Amendments`
section at the bottom of the ADR — old value → new value, the driving issue/PR, and the code
location that now owns the value. **What the inline half is depends on what the moved number is
doing in the document**, and the test is carrier versus premise:

- **A carrier** states the value and nothing else leans on it — a table cell, a parenthetical, a
  Consequence line. True it up inline where it appears; the entry records the move.
- **A premise** cannot move without moving the inference built on it: the option was chosen
  _because_ the number was what it was, so truing it up inline rewrites the document into a
  reasoning it never had — the retcon supersession exists to prevent. The entry alone records the
  move, and the reader is protected inline instead, by an **as-it-stood annotation** wherever the
  figure would otherwise read as current. ADR 0005's `## Context` is the exemplar form: it quotes
  ADR 0004's `$0` headline, marks the quotation — "quoted as 0004 stood when this was written" —
  states what that headline was amended to and when, and points at 0004's `## Amendments`. Where
  an entry has already declared a whole family of in-body figures historical wholesale — 0002's
  2026-08-10 (#264) entry closes by stating that every per-dashboard-load read figure in the body
  above states pre-#264 sizing — **that declaration is the inline half**, and no per-figure
  annotation is owed on top of it.

The test applies figure by figure, not document by document, and **ADR 0002's capacity table is
the worked premise-side case** — both halves live in the same table. #156 trued the
`cumulo-weather` row to on-demand inline, and the document still recorded the hybrid it chose.
#258 moved `series` too and left `| provisioned | 14 | 21 |` standing, because that row is what
the capacity-mode decision was sized against: trued up, no row in the table is provisioned, and
option G — hybrid, chosen — reads as option E, on-demand everywhere, which this ADR considered
and rejected. Its #258 and #264 entries are the record, and they state in the entry what the row
no longer describes. That is why the table is not reconciled cell by cell.

**A value that was wrong when written is amendable too**, not only one the code has moved under
the document: #200 re-based ADR 0005's cost frame off the us-east-1 rates it had been computed at
onto the eu-west-1 Region the platform actually deploys into, and made ADR 0004's absolute — no
resource in Cumulo bills for existing — precise, each recorded as an entry. The guardrail is
unchanged, and it is what sorts the two cases: an amendment never touches reasoning. If you find
yourself rewording _why_, that is a supersession in disguise — write the new ADR. A wrong number
is amended; wrong reasoning is superseded.

**An amendment entry names the known quoters and citers of what it amends** — the sites elsewhere
in the repo that repeat the value or lean on it. That list is a **floor, not a census**: it is
what the amender's sweep found, so it states the sweep that found it, pattern and date, and a
later reader can tell an unsearched place from a searched one. It is the shape
`docs/standards/architecture.md` rule 9 asks for beside an owned value — the restatement ledger —
pointed the other way. What each kind of quoter is owed differs:

- **Mutable quoters** — code, comments, READMEs, standards prose — are trued up in the same
  change (rule 11: prose that argues for a value is part of that value's change surface).
- **Quoting ADRs** are immutable, so they are not trued up: patch the quotation with the
  as-it-stood annotation above, and give that ADR its own dated entry.
- **The backwards case** — an ADR quoting mutable code — freezes nothing. The code keeps the
  value and keeps moving; the code owner's rule-9 restatement ledger lists the quoting ADR as one
  of its carriers, and the true-up is dispatched from there.

Who finds the copies: the amender, working off the owner's ledger — and whoever later finds a
copy the ledger missed banks it there, so the next amendment starts from a longer floor.

**The sweep an amendment owes is rule 10's**, inherited whole; read it before editing rather than
trusting a grep for the old literal. The half that ADR-shaped amendments miss is the **derived**
one — a fraction of a ceiling, a "roughly half", a duration computed at a run rate, the scope
line of a basis caveat (ADR 0005's entry stating the scope of its worst-case bound is one of
those) — which carries no copy of the number that moved. Rule 10 says how to shape a sweep that
reaches it.

## Index

- [0001 — Service boundaries](0001-service-boundaries.md)
- [0002 — Storage split](0002-storage-split.md)
- [0003 — PV physics model runtime](0003-pv-model-runtime.md)
- [0004 — Ingestion transport](0004-ingestion-transport.md)
- [0005 — Fleet API compute and hosting](0005-fleet-api-hosting.md)
- [0006 — Demo abuse and cost protection](0006-demo-abuse-protection.md)
- [0007 — Series deletion is TTL-only](0007-series-deletion-is-ttl-only.md)
