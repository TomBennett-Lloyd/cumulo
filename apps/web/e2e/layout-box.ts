import type { Locator } from '@playwright/test';
import { expect } from '@playwright/test';

/*
 * The lane's measuring instruments, in one owned module.
 *
 * Every spec in this directory that compares geometry has to turn a locator into
 * a rectangle first, and until now each one grew its own way of doing it: the
 * same `NonNullable<Awaited<ReturnType<Locator['boundingBox']>>>` type was
 * declared three times over (`composition.spec.ts`, `attribution-band.spec.ts`,
 * and again as `PlotBox` in `chart-surfaces.spec.ts`), over three different
 * readiness policies whose differences were real but undiscoverable — a reader
 * had to open all three files to learn that a choice existed at all. Consolidating
 * them here is what makes the choice visible, and this docblock is where a spec
 * author makes it (#404).
 *
 * Nothing here touches a `Page`. Every function takes a `BoxSource` — the single
 * method it actually needs — so the module's own spec can drive it with
 * hand-built sources, and so no caller has to hand a helper more of the page than
 * the helper reads (`structure.md` rule 1).
 *
 * ## Which one to call
 *
 * Four box readers, in increasing order of what they wait for:
 *
 * - `maybeBoxOf` — one raw read, `null` passed straight through. For readers that
 *   map that `null`, then and there, onto a sentinel chosen to lose the
 *   comparison it feeds — and only those (see its own docblock).
 * - `boxOf` — one read, loud throw when there is no box. For layout that is long
 *   settled by the time it is measured, where `null` means "this element has no
 *   layout at all" rather than "not yet".
 * - `layoutBoxOf` — polls until a box **exists**, and returns the sample the poll
 *   saw. For measurements taken just after navigation or a resize, where "has a
 *   box yet" is genuinely in flight (#274).
 * - `settledBoxOf` — polls until two consecutive reads **agree**, and returns the
 *   agreeing sample. For callers that aim a pointer at the box, where a stale
 *   coordinate cannot be corrected by a later frame.
 *
 * And one export that is not a box reader at all:
 *
 * - `polledSample` — poll *any* nullable reading until it is non-null, and hand
 *   back the sample the poll saw rather than a fresh read. It is the mechanic the
 *   two polling readers above are built from, and it is exported because a
 *   reading that is not a box needs the same guarantee for the same reason:
 *   `header.spec.ts` polls a three-rectangle geometry taken in one
 *   `page.evaluate` through it, precisely so the numbers it asserts on are the
 *   ones the poll settled on. Reach for it when the reading is composite, or
 *   comes from somewhere other than `Locator.boundingBox`; for a plain box,
 *   `layoutBoxOf` is that call already made.
 *
 * ## Why `layoutBoxOf` and `settledBoxOf` are two functions and not one flag
 *
 * `structure.md` rule 7's question, asked and answered rather than gestured at,
 * because these two are the pair a reader is most likely to think are duplicates:
 * **if one changed, would the other be wrong until it changed the same way?**
 *
 * **No.** They wait on different states for different reasons, and each is free to
 * move without the other. `layoutBoxOf` establishes *existence*, because its
 * callers compare geometry and a comparison can simply be re-taken; if the lane
 * ever learned that a box's first appearance needs an extra condition, nothing
 * about pointer aiming would change. `settledBoxOf` establishes *stability*,
 * because `page.mouse.move` is an event rather than a state and a coordinate
 * computed from a moving box is wrong permanently; if the settle test grew a third
 * agreeing read, no geometry comparison would want it — it would just make every
 * such spec a poll interval slower for nothing. So the duplication between them is
 * incidental and the two stay named.
 *
 * That verdict is also what rules out the shape this would otherwise collapse
 * into: one reader with a `settled: boolean`. The flag is the tell that two
 * intents were forced together (rule 7's closing line), and it would move the
 * choice above out of this docblock and into an argument at each call site, which
 * is precisely where a spec author cannot see the reasoning. What the two *do*
 * share — the capture-the-sample poll mechanic — is extracted, as `polledSample`,
 * and that is the shared portion rule 7 asks for.
 */

/**
 * A laid-out box in client space — what `Locator.boundingBox` yields once it has
 * one.
 *
 * Derived from the locator's own return type rather than hand-written, so this
 * cannot drift from what Playwright actually hands back (`typing.md` rule 3's
 * principle, applied to a library boundary instead of a schema).
 */
export type LayoutBox = NonNullable<Awaited<ReturnType<Locator['boundingBox']>>>;

/**
 * The one capability this module needs of the thing it measures.
 *
 * Derived from `Locator` rather than restated, on the same principle as
 * `LayoutBox` above: these helpers cannot drift from Playwright's signature
 * because they do not own it. A real `Locator` satisfies it as-is, so callers
 * pass locators and never think about this type.
 *
 * Narrowing to the single method is also the seam `layout-box.spec.ts` needs — a
 * real `Locator` cannot be asked to flicker, to arrive late, or to hold still on
 * demand, and what these helpers do in each of those cases is the whole behaviour
 * under test.
 */
export type BoxSource = Pick<Locator, 'boundingBox'>;

/**
 * One raw box read, with `null` passed straight through.
 *
 * The reader for **sentinel-mapping** callers, and the condition is that and
 * nothing about polls: a caller may take the raw read when its very next move is
 * to turn `null` into a value that loses the comparison it is about to feed —
 * `false`, `Infinity`, a description string that is not the passing one, a `null`
 * geometry. That mapping is the whole licence, because it is what stops a missing
 * box arriving at a comparison as `undefined` or `NaN` and passing quietly
 * (`error-handling.md` rule 1). The two polling readers below are themselves such
 * callers; so is every reader in the specs.
 *
 * Whether the sentinel is then compared *inside* a poll is the caller's decision
 * and none of this function's business. Under a poll it means "not yet", and the
 * poll's own timeout is what turns a permanent absence into a failure; outside
 * one it means "never" and fails the assertion where it stands. `header.spec.ts`
 * reads its `menuRowEndGap` both ways in the same file, and both are honest for
 * the same reason — the sentinel was chosen to lose either comparison.
 *
 * What disqualifies a caller is carrying the `null` any further than that: handed
 * onward, or stored, it becomes a different defect's message several frames away
 * from the read that produced it. `boxOf` is the reader when a missing box means
 * "no layout at all", `layoutBoxOf` when it means "not laid out yet", and each is
 * a line longer than this one precisely because it says which.
 *
 * Not `async`: there is nothing to await, and `require-await` is right to say so.
 */
export const maybeBoxOf = (source: BoxSource): Promise<LayoutBox | null> => source.boundingBox();

/**
 * Poll a reading until it is non-null, and hand back **the sample the poll saw**.
 *
 * The mechanic both polling readers below are built from, and the reason it is a
 * function rather than a paragraph repeated twice.
 *
 * `expect.poll` reports whether its condition held rather than the value it held,
 * so the obvious way to return a polled reading is to take it again afterwards —
 * and that re-opens at the far end whatever race the poll was closing at this
 * one. A reading is a state, and a state worth observing is a state worth
 * keeping: between the two reads the page is free to change back, and it is the
 * second read that would own the assertion. Three consecutive CI failures over
 * one byte-identical tree measured the window a contended runner opens — rotating
 * victims across two tests and two elements, with the polling helper and its
 * message constant in all three, against 30/30 green locally (#367). That
 * invariance is what convicted the shared helper rather than either test.
 * Capturing what the poll saw closes the window by construction: there is no
 * second read left to disagree with the first.
 *
 * The sample lands in a one-property holder rather than a plain `let`, and that
 * is the compiler's requirement rather than a preference. TS never follows an
 * assignment made inside the poll's closure, so a `let` initialised to `null` is
 * still narrowed to `null` at the guard below, which reduces the guard to a
 * comparison the checker can discharge — `no-unnecessary-condition` is right to
 * call that decoration. A property of an object whose type is not a union is not
 * narrowed by its initialiser, so `latest.sample` keeps its honest `T | null` and
 * the guard stays a check the compiler admits.
 *
 * What that guard reports is an invariant, not a race: it can fire only if
 * `expect.poll` resolved on a `null` sample, which its contract rules out. So it
 * names a violated invariant rather than a failed measurement
 * (`error-handling.md` rule 1), and quotes the caller's own poll message so the
 * report still points at the element that was being measured.
 *
 * `message` is a parameter rather than something reached in from the enclosing
 * test (`structure.md` rule 1); it is what makes both failures name the element
 * rather than the helper.
 */
export const polledSample = async <T>(
  read: () => Promise<T | null>,
  message: string,
): Promise<T> => {
  const latest: { sample: T | null } = { sample: null };

  await expect
    .poll(
      async () => {
        latest.sample = await read();

        return latest.sample;
      },
      { message },
    )
    .not.toBeNull();

  if (latest.sample === null) {
    throw new Error(`A poll resolved without the sample it settled on. Poll: ${message}`);
  }

  return latest.sample;
};

/**
 * One element's box, or a loud failure naming the element that had none.
 *
 * Read once rather than polled, and the difference from `layoutBoxOf` is intent
 * rather than rigour. Use this where layout is long settled by the time the read
 * happens — `attribution-band.spec.ts` measures only after `revealSiteMarker` has
 * zoomed the fleet apart, several camera moves and marker remounts later — so a
 * `null` there means an element with no layout at all rather than one that has
 * not been given layout yet. That is a different failure, and it says so
 * (`error-handling.md` rule 1).
 *
 * Reaching for this where layout is still in flight is the mistake #274 was: a
 * first-`null` throw makes every caller a race against layout, one that loses on
 * CI while passing on every local run. `layoutBoxOf` is the reader for that case.
 */
export const boxOf = async (source: BoxSource, name: string): Promise<LayoutBox> => {
  const box = await maybeBoxOf(source);

  if (box === null) {
    throw new Error(`${name} is on the page but has no layout box.`);
  }

  return box;
};

/**
 * One element's box, once the browser has laid it out.
 *
 * Polled rather than read once, and that is a correctness fix rather than a
 * tolerance. The window is real and specific: `.map-canvas` is worn by both the
 * pending shell and the live map — that is `MapSurface`'s whole point, the same
 * box either side of the swap — so a `toBeVisible` before the measurement can be
 * satisfied by the *placeholder*, and the box read that follows can land in the
 * instant the placeholder has gone and maplibre's container has not yet been laid
 * out. A faster machine simply never loses that instant (#274 — "The map canvas
 * is on the page but has no layout box", 862ms, so it raced rather than hung).
 *
 * So the readiness handling is the poll and nothing else: no `waitForTimeout`, no
 * retry budget, no tolerance on the measurements callers then make. The state
 * being waited on is "this element has a box", which is exactly the precondition
 * of measuring one, and the poll's own timeout is what reports an element that
 * genuinely never gets one.
 *
 * Captured, but deliberately not *settled* — no second matching reading, no
 * stability window. These callers compare geometry rather than aiming pointer
 * events at the box, across gaps far larger than any jitter, so "a box existed,
 * and this is it" is the entire precondition being established. Waiting for a box
 * to stop moving would be scope bought against no measurement flake anyone has
 * seen — and where a caller genuinely does need that, `settledBoxOf` below is the
 * one to call instead.
 */
export const layoutBoxOf = (source: BoxSource, name: string): Promise<LayoutBox> =>
  polledSample(() => maybeBoxOf(source), `${name} never acquired a layout box.`);

/**
 * Whether two readings describe the same rectangle.
 *
 * All four fields, so "the same rectangle" means what it says. The signature
 * `settledBoxOf` replaced compared a `x,y,width` string and left height out with
 * no stated reason; an element still growing vertically under a settling column
 * is exactly the state a pointer should not be aimed during, so the omission is
 * not carried forward.
 */
const sameBox = (one: LayoutBox, other: LayoutBox): boolean =>
  one.x === other.x &&
  one.y === other.y &&
  one.width === other.width &&
  one.height === other.height;

/**
 * One element's box, once two consecutive reads agree about it.
 *
 * The measurement that cannot simply be re-taken, and the only reason to pay for
 * a stability window. Most assertions in this lane poll until a reading is right,
 * but `page.mouse.move` is an *event* rather than a state: a coordinate computed
 * from a box read while the map above was still taking its band puts the pointer
 * where the element no longer is, and no later frame corrects it. The case then
 * fails on a tooltip that was never summoned, blaming the hover layer for a
 * mis-aimed cursor.
 *
 * The agreeing sample is what comes back — the second of the two reads that
 * matched, not a third read taken after the poll resolved. `polledSample`'s
 * docblock owns that argument; what is worth saying here is that it bites harder
 * for this reader than for `layoutBoxOf`, because the whole point of the wait is
 * that the returned rectangle is the one the pointer will be aimed at. A helper
 * that settles and then re-reads has given back a coordinate nothing verified,
 * which is the state the poll was bought to rule out.
 *
 * "Agree" is two readings and not three. Two is what distinguishes a box mid-move
 * from a box at rest across one poll interval, which is the whole claim; a third
 * would cost every caller another interval to raise a confidence nobody has
 * needed. If a surface ever proves that wrong, this is the one function to change.
 */
export const settledBoxOf = (source: BoxSource, name: string): Promise<LayoutBox> => {
  const previous: { box: LayoutBox | null } = { box: null };

  return polledSample(async () => {
    const current = await maybeBoxOf(source);
    const agreed = current !== null && previous.box !== null && sameBox(current, previous.box);

    previous.box = current;

    return agreed ? current : null;
  }, `${name} never held still long enough to aim a pointer at it.`);
};
