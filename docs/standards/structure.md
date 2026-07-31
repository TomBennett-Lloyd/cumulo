# Structure standards

**Trigger:** creating or splitting a file, extracting or naming a helper module, choosing between a function and a class, or copy-pasting code.

## Rules

1. **Units are context-free.** A function should be legible without its enclosing context: explicit inputs, an explicit return, nothing reached in from a scope the reader has to go find. When an inner function needs something from outside, prefer **another parameter** over relying on nesting to supply it — a parameter is visible in the signature, a captured variable is not.

2. **No closure factories.** `createX(deps)` returning an object of functions over captured variables is banned. Tracing a variable's provenance through a factory is expensive to review, and the shape hides that its inner functions could be standalone, unit-testable utilities. Two legitimate outcomes instead: the functions were independent, so make them top-level and pass what they need; or the methods genuinely share state, so use a **class**, where `this.` is the visible marker that state is shared (`architecture.md` rule 7 has the guard-rails on classes).

3. **Function style is lint-enforced, not a convention.** Read `eslint.config.mjs` for the exact scope rather than trusting a paraphrase here:
   - `func-style` — functions are arrow constants (`const f = () => …`), including React components.
   - `@typescript-eslint/no-use-before-define` — define before use. Ordering therefore follows dependencies by construction; the accepted consequence is that helpers read above the public API and a file's exported symbol usually sits at the bottom.
   - `@typescript-eslint/unbound-method` (from the `strictTypeChecked` preset, not a local entry) — a detached method loses its `this`. Inject the object, not the method.
   - `no-invalid-this` is deliberately absent: under arrow style plus rule 2, a `this` outside a class body is unreachable.

   Suppression comments are themselves lint errors — a rule fighting you is a design signal.

4. **Files stay small.** `max-lines` at 300 code lines (blanks and comments excluded) — lint-enforced, so this is a hard ceiling, not a target. When a file grows, the first cut is usually its types: move them into their own module rather than letting them bloat the implementation.

5. **One folder per adapter.** An adapter owns a directory — `packages/storage/src/adapters/<adapter>/` — and helpers used by only that adapter live inside it. Helpers shared by several adapters move up to the adapters root. The folder is what makes rule 4's splits obvious instead of arbitrary.

6. **A helper module is never named `utils.ts`.** Names carry context even when the folder already provides some: `retry-backoff.ts`, `site-item.ts`. Enforced by the `check:module-names` gate in `verify`, which rejects a bare `utils.*` file as well as a `utils/` directory (`architecture.md` rule 5 covers the directory-level ban and the reasoning).

7. **Repetition policy.** Duplication is allowed only when it is _incidental_: the two pieces have different intent in different contexts and could legitimately diverge. Similar-but-not-identical code with similar intent: extract **only the shared portion** and share that; do not force the dissimilar remainder together.

   The decision procedure, for authors and reviewers: ask **"if one copy changed, would the other be wrong until it changed the same way?"**
   - **Yes** — same intent. Extract the shared portion.
   - **No** — incidental. The duplication stands, and merging the two would couple things that should be free to diverge.

   When extracting from near-duplicates, never parameterize the dissimilar remainder into one function with mode flags. The flag _is_ the tell that two intents were forced together. A PR that dedupes, or that declines to dedupe visibly similar code, states the intent argument in its body.

## Why

Agents and human reviewers both read this code in fragments — a diff hunk, a grepped function, a file opened cold. Every rule here is about making a fragment mean something on its own: explicit parameters over captured scope, a visible `this.` where state really is shared, files short enough to hold in your head, and names that survive being read outside their directory. The repetition rule is the same idea pointed at the future: code merged on surface resemblance couples two things that were only briefly alike, and the mode flag added six months later is the bill arriving.
