/**
 * The checks a write path runs on its caller, placed where they blame the right
 * party.
 *
 * Placement is the whole content of this module. `StorageAdapterBase.sending`
 * turns everything inside it into a `StorageError` — "storage operation X failed
 * on table Y" — which is the truth about a call DynamoDB refused and a lie about
 * a caller that handed us impossible input. A precondition that runs inside that
 * wrap pages an operator to look at a table for a bug that lives in the code
 * calling us (#166). So these throw plain `Error`s, before the wrap and before
 * any command is built: a violated invariant, propagated as one
 * (`docs/standards/error-handling.md` rules 1 and 2).
 *
 * Package-internal — deliberately absent from `index.ts`. These are checks this
 * package runs on its own callers, not a validation surface for anyone else to
 * call.
 */

/**
 * Refuses a write whose items would collide on the key they are stored under.
 *
 * **The policy is refusal, never a last-wins de-duplication.** Three reasons,
 * and they point the same way:
 *
 * - DynamoDB rejects the whole request anyway (`ValidationException` on a batch
 *   or transaction carrying one key twice) — but only *within* one 25-item
 *   batch: a key repeated across two of `drainBatches`' chunks is sent as two
 *   separate calls, both succeed, and the later silently wins. In that case
 *   this precondition is the only thing catching the duplicate, which is why
 *   it cannot be deleted as redundant with DynamoDB's own check;
 * - keeping the last item would swallow a caller bug — two forecasts for one
 *   site-hour means an upstream loop ran twice or a merge went wrong, and
 *   quietly writing one of them is the swallowed failure rule 2 forbids;
 * - the read path is allowed to disagree, and does: `listFetchedArchiveDays`
 *   de-duplicates its day list, because "have these days been fetched?" is a set
 *   question. A write is not a set question — it is a claim about each item.
 *
 * `operation` names the public method so the message points at the call the
 * caller made, and the first colliding key is named because that is the one a
 * reader can go and look for.
 */
export const requireUniqueKeys = (operation: string, keys: readonly string[]): void => {
  const seen = new Set<string>();
  for (const key of keys) {
    if (seen.has(key)) {
      throw new Error(
        `${operation}: two items share the key ${key} — the caller must de-duplicate before writing`,
      );
    }
    seen.add(key);
  }
};
