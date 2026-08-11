import { expect, test } from '@playwright/test';

import type { BoxSource, LayoutBox } from './layout-box';
import { boxOf, layoutBoxOf, settledBoxOf } from './layout-box';

/*
 * The lane's own measuring instruments, asserted deterministically.
 *
 * This directory's charter is the assembled app — nothing here assembles
 * anything, and no case below touches a `page`. It lives here anyway because
 * `layout-box.ts` lives here and the unit lane's include boundary deliberately
 * stops at this directory (`apps/web/vite.config.ts` — "Vitest owns `src/` and
 * nothing else"). Any other home for these cases would mean moving the helpers
 * away from the specs that are their only callers.
 *
 * What makes them deterministic is `BoxSource`: a real `Locator` cannot be asked
 * to flicker, to arrive late, or to hold still on demand, so each case hands the
 * helper a source that answers a written-down script. The races these helpers
 * exist to close were each found as a CI flake — one run in some number of runs,
 * on a contended runner — and a case that can only reproduce one by luck is not a
 * regression test. These reproduce them by construction, which is what
 * `testing.md` rule 4 asks.
 *
 * The `webServer` still builds and boots for this file, because the config boots
 * it once per run rather than per spec. That costs this file nothing it can avoid
 * and buys it nothing either.
 *
 * One export deliberately has no case here: `polledSample`'s "resolved without
 * the sample it settled on" guard. It reports a violated invariant rather than a
 * race — it can fire only if `expect.poll` resolved on a `null` sample, which its
 * contract rules out — so the only way to reach it from outside is to drive the
 * helper with a broken `expect`, and the resulting case would assert Playwright's
 * behaviour rather than this module's (`testing.md` rule 1). Its own docblock in
 * `layout-box.ts` says as much at the guard itself.
 */

/**
 * A `BoxSource` that answers a written-down script of readings and then holds its
 * last one for good.
 *
 * A class rather than a function returning an object literal, because the reads
 * genuinely share mutable state — where the script has got to — and `this.` is
 * the marker that makes that visible where a captured counter would hide it
 * (`structure.md` rule 2, which names this exact fork). Flat, with no base and no
 * subclasses (`architecture.md` rule 7).
 *
 * Holding the last reading is load-bearing rather than a convenience. It is what
 * lets a script end in `null` and so ask the sharpest question these helpers
 * face: what does the helper hand back if it reads *again* after it was
 * satisfied? A script that ran out and started repeating a box would answer that
 * question the same way whether or not the helper re-read.
 */
class ScriptedBoxSource implements BoxSource {
  private held: LayoutBox | null;

  private readonly remaining: (LayoutBox | null)[];

  constructor(script: readonly [LayoutBox | null, ...(LayoutBox | null)[]]) {
    const [first, ...rest] = script;

    this.held = first;
    this.remaining = rest;
  }

  /** Not `async`: there is nothing to await, and `require-await` is right to say so. */
  boundingBox(): Promise<LayoutBox | null> {
    const answer = this.held;
    const next = this.remaining.shift();

    if (next !== undefined) {
      this.held = next;
    }

    return Promise.resolve(answer);
  }
}

/*
 * A source that has a box exactly once is #367's race made repeatable: the poll
 * settles on reading one, and a helper that then re-read got `null` and threw.
 * Three CI runs produced that by luck; the trailing `null` produces it by
 * construction.
 */
test('layoutBoxOf returns the box its poll observed rather than re-reading it', async () => {
  const settled: LayoutBox = { x: 0, y: 0, width: 640, height: 480 };
  const flickering = new ScriptedBoxSource([settled, null]);

  expect(await layoutBoxOf(flickering, 'The flickering element')).toEqual(settled);
});

/*
 * And the other half of the same helper's contract, which nothing asserted until
 * now: that it *waits*. #274 was a first-`null` throw racing layout — the
 * placeholder gone, maplibre's container not yet laid out — and the case above
 * cannot see the difference, because its source has a box on read one. A source
 * that has none for two reads is what tells a poll apart from a single read.
 *
 * "issue 274" rather than "#274" in the title, which is the same form
 * `composition.spec.ts` uses for issue 344: the frontend gate's hex-colour
 * selector reads `#274` in a *string literal* as a three-digit colour, and it is
 * right to — a title is not the place to teach it an exception. Comments are
 * outside the selector, so prose like the paragraph above keeps the short form.
 */
test('waits out a source that has no box yet (issue 274)', async () => {
  const late: LayoutBox = { x: 12, y: 34, width: 200, height: 100 };
  const arriving = new ScriptedBoxSource([null, null, late]);

  expect(await layoutBoxOf(arriving, 'The late element')).toEqual(late);
});

/*
 * `settledBoxOf`'s whole promise, in one script: a box that moves once and then
 * holds, followed by a reading that would betray a third read.
 *
 * The first two reads disagree, so the settle is not satisfied by a box still in
 * motion. The second and third agree, so the poll resolves — and what the helper
 * returns has to be that agreeing sample. The `null` sitting behind it in the
 * script is the assertion's teeth: the helper this one replaced re-read after its
 * poll resolved, and against this source that read would return `null` and throw.
 * A caller aiming a pointer would otherwise be handed a coordinate nothing
 * verified, which is the state the wait was bought to rule out.
 */
test('settledBoxOf returns the sample its two agreeing reads saw, not a later one', async () => {
  const moving: LayoutBox = { x: 0, y: 120, width: 300, height: 300 };
  const held: LayoutBox = { x: 0, y: 80, width: 300, height: 300 };
  const column = new ScriptedBoxSource([moving, held, held, null]);

  expect(await settledBoxOf(column, 'The plot')).toEqual(held);
});

/*
 * And that "agree" means all four fields, which the case above cannot see: its
 * two disagreeing reads differ in `y`, so a settle test that had dropped any
 * *other* field would still pass it. The signature `settledBoxOf` replaced
 * compared `x,y,width` and left height out, and this branch put height back
 * deliberately — so height is the field with no other case standing behind it.
 *
 * The script is a column still growing under an element that has stopped moving
 * sideways: reads one and two are the same rectangle at two heights, and nothing
 * else about them differs. A helper that ignores height calls those two agreed
 * and hands back the *growing* box, which is exactly the mid-growth coordinate a
 * pointer must not be aimed at; the two reads that genuinely agree come later and
 * are somewhere else. Asserting the returned box rather than merely that one came
 * back is what separates the two outcomes — both versions resolve, and only the
 * value says which read they resolved on.
 */
test('settledBoxOf does not call a box that is still growing taller settled', async () => {
  const growing: LayoutBox = { x: 0, y: 40, width: 300, height: 100 };
  const grown: LayoutBox = { x: 0, y: 40, width: 300, height: 160 };
  const settled: LayoutBox = { x: 0, y: 24, width: 300, height: 160 };
  const column = new ScriptedBoxSource([growing, grown, settled, settled, null]);

  expect(await settledBoxOf(column, 'The plot')).toEqual(settled);
});

/*
 * `boxOf`'s whole difference from `layoutBoxOf`, which is its message. A source
 * that never has a box is the state both readers face and answer differently:
 * this one gives up on read one and says which element it was, where
 * `layoutBoxOf` would poll to its own timeout. Asserting the text rather than
 * just the rejection is the point — an unnamed throw is the failure #274 was
 * hard to diagnose from.
 */
test('boxOf names the element it found no layout box on', async () => {
  const bandless = new ScriptedBoxSource([null]);

  await expect(boxOf(bandless, 'The credits band')).rejects.toThrow(
    'The credits band is on the page but has no layout box.',
  );
});
