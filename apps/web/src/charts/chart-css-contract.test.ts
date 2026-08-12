import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/*
 * The parts of `charts.css` that carry a design obligation rather than a
 * preference, asserted mechanically. `map/map-css-contract.test.ts` is the
 * precedent and its docblock carries the argument for the whole shape of this
 * check; the short version is that jsdom applies no stylesheet, so a component
 * test asking a rendered `<line>` for its computed stroke would report the
 * initial value and pass against an empty file. Reading the stylesheet as text
 * proves the declarations exist, not that they take effect (testing.md rule 10).
 *
 * What that leaves to the browser lane is the thing this file is named for:
 * whether the plot's three verticals are actually *told apart* by a reader — the
 * solid hairline day boundary, the dashed hairline horizon rule and the solid
 * full-ink crosshair. Two of them were one line drawn twice before #284 D11, and
 * #335 added the third. The grid was never in that comparison: it is horizontal
 * only, so a reader separates it by orientation before ink or weight comes into
 * it. `apps/web/e2e/` owns
 * that criterion and no spec in it asserts it today, so this is what the fast
 * lane can honestly say about #284 D11 and #335, and it is deliberately a claim
 * about the declarations rather than about the pixels.
 *
 * The failure it exists to catch is a merge back to sameness: the horizon rule
 * folded into the grid's selector list again (which is where it lived until
 * D11), the crosshair quietly returned to the grid's ink and hairline weight, or
 * the day boundary picking up a dash and becoming a second horizon. Each is a
 * one-line edit that no other test in the repo would notice.
 */

const css = readFileSync(new URL('./charts.css', import.meta.url), 'utf8');

/** The stylesheet with comments removed, so prose about a dash proves nothing. */
const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');

interface CssRule {
  readonly selectors: readonly string[];
  /** Preludes of the enclosing at-rules, outermost first. Empty at top level. */
  readonly atRules: readonly string[];
  readonly declarations: string;
}

interface OpenBlock {
  readonly prelude: string;
  readonly contentStart: number;
}

/**
 * Style rules, each tagged with the at-rules it sits inside.
 *
 * Deliberately not the precedent's single regex. That parser matches
 * `([^{}]+)\{([^{}]*)\}` over the whole file, which cannot see nesting at all:
 * an `@media` block's prelude becomes a "selector" and its first inner rule's
 * body becomes that rule's declarations, so every assertion downstream is
 * reading the wrong text — the defect recorded as #311. It was written against a
 * `charts.css` that had no at-rule at all, on the argument that the day one
 * arrived should be a loud failure rather than a silent misread; that day is
 * 2026-08-12, when #448's loading trace brought a `prefers-reduced-motion`
 * override with it, and the nesting this parser already tracked is what let the
 * lookups below simply name which scope they mean instead of being rewritten.
 * What has not changed is the refusal: anything this reader does not model
 * throws.
 *
 * Scope, stated rather than assumed: it models comment-stripped CSS with
 * balanced braces and no braces inside strings or `url()`. A brace inside a
 * declaration value would misparse — nothing in this stylesheet has one, and the
 * check that would catch it is the same one that catches everything else here,
 * namely the named assertions below failing.
 */
const parseRules = (source: string): readonly CssRule[] => {
  const rules: CssRule[] = [];
  const open: OpenBlock[] = [];
  let preludeStart = 0;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];

    if (character === '{') {
      open.push({ prelude: source.slice(preludeStart, index).trim(), contentStart: index + 1 });
      preludeStart = index + 1;
      continue;
    }

    if (character === '}') {
      const block = open.pop();

      if (block === undefined) {
        throw new Error(`charts.css has an unbalanced '}' at offset ${String(index)}`);
      }

      const content = source.slice(block.contentStart, index);

      if (!block.prelude.startsWith('@')) {
        if (content.includes('{')) {
          throw new Error(
            `charts.css nests a block inside the style rule '${block.prelude}'; this reader does not model CSS nesting`,
          );
        }

        rules.push({
          selectors: block.prelude.split(',').map((selector) => selector.trim()),
          atRules: open.map((enclosing) => enclosing.prelude),
          declarations: content,
        });
      }

      preludeStart = index + 1;
    }
  }

  if (open.length > 0) {
    throw new Error(`charts.css leaves ${String(open.length)} block(s) unclosed`);
  }

  return rules;
};

const rules = parseRules(withoutComments);

/** The rules for `selector` that sit inside at least one at-rule. */
const conditionalRulesFor = (selector: string): readonly CssRule[] =>
  rules.filter((rule) => rule.selectors.includes(selector) && rule.atRules.length > 0);

/**
 * The declarations of the one rule for `selector` whose enclosing scope is
 * `scope` — the empty array for the unconditional rule, or the prelude of the
 * at-rule the override lives in.
 *
 * Every departure from "exactly one rule in that scope" throws rather than
 * returning something an assertion could pass against vacuously
 * (error-handling.md rule 1). A missing rule is a violated invariant of this
 * test's own subject — the file is ours and these selectors are the contract —
 * and a duplicate means the declarations read here are no longer the whole
 * story for that scope.
 *
 * **The scope is a parameter because it stopped being knowable from the
 * selector.** Until #448 this lookup took no scope and threw on *any* second
 * rule, which was the same guard stated as an impossibility: with no at-rule in
 * the file, "exactly one rule" and "the unconditional rule" were the same
 * sentence. The loading trace is deliberately a pair — a rule and a
 * reduced-motion override of it — so a lookup that refused every second rule
 * could not read either half of it. What the old shape was protecting is not
 * lost, only moved somewhere it can be named: the case below asserts that the
 * selectors read unconditionally really are unconditional, which is the claim
 * the throw used to make in passing, and it makes it about a stated list rather
 * than about whichever selector an assertion happened to ask for.
 */
const declarationsIn = (scope: readonly string[], selector: string): string => {
  const matches = rules.filter(
    (rule) =>
      rule.selectors.includes(selector) &&
      rule.atRules.length === scope.length &&
      rule.atRules.every((prelude, index) => prelude === scope[index]),
  );
  const [only] = matches;
  const where = scope.length === 0 ? 'at the top level' : `inside ${scope.join(' / ')}`;

  if (only === undefined) {
    throw new Error(`charts.css declares no rule for '${selector}' ${where}`);
  }

  if (matches.length > 1) {
    throw new Error(
      `charts.css declares ${String(matches.length)} rules for '${selector}' ${where}; this contract reads one`,
    );
  }

  return only.declarations;
};

/** The declarations every reader gets, whatever their preferences. */
const declarationsFor = (selector: string): string => declarationsIn([], selector);

const DASH = /stroke-dasharray\s*:/;
const STROKE_WIDTH = /stroke-width\s*:\s*(?<width>[^;]+);/;

/** #448's placeholder curve, and the file's one deliberately-overridden selector. */
const LOADING_TRACE = '.forecast-chart-loading-trace';

/** The scope the reduced-motion override lives in, as `parseRules` reports its prelude. */
const REDUCED_MOTION = ['@media (prefers-reduced-motion: reduce)'];

/**
 * The selectors every other assertion in this file reads as the whole of what a
 * reader gets.
 *
 * Listed rather than derived, because the claim is about these rules and a list
 * derived from the file would agree with the file by construction. Membership is
 * therefore hand-kept, by a stated rule: every selector an assertion below reads
 * through `declarationsFor` — or through `strokeWidthOf`, which resolves through
 * it — less `LOADING_TRACE`, whose override is deliberate and is the positive
 * control for the case that reads this list. What re-checks the list against that
 * rule is `command grep -nE "declarationsFor\(|strokeWidthOf\(" ` over this file,
 * run 2026-08-12 — which is how `.forecast-chart-median` was found read below and
 * missing here, leaving the weight comparison it appears in true of some readers
 * and not others with nothing failing.
 */
const UNCONDITIONAL_SELECTORS = [
  '.forecast-chart-grid',
  '.forecast-chart-horizon',
  '.forecast-chart-day-boundary',
  '.forecast-chart-crosshair',
  '.forecast-chart-median',
  '.forecast-chart-figure',
  '.forecast-chart-error',
];

/**
 * The stroke width a rule declares. A vertical mark with none is a violated
 * invariant of this contract rather than a case to compare vacuously — every one
 * of the three sets its own weight, and the whole point below is that they do
 * not all set the same one.
 */
const strokeWidthOf = (selector: string): string => {
  const width = STROKE_WIDTH.exec(declarationsFor(selector))?.groups?.width;

  if (width === undefined) {
    throw new Error(`charts.css declares no stroke-width for '${selector}'`);
  }

  return width.trim();
};

// The suite name carries no issue number: the lint gate reads `#284` in a string
// literal as a hex colour, and the reference belongs in the docblock anyway.
describe('charts.css tells the plot’s three verticals apart', () => {
  it('marks the measurement seam with a dashed rule', () => {
    expect(declarationsFor('.forecast-chart-horizon')).toMatch(DASH);
  });

  it('leaves the grid solid, which is what lets the dash mean the seam', () => {
    // Positive control on the same pattern, so the emptiness below is a fact
    // about the grid rather than about a regex that matches nothing.
    expect(declarationsFor('.forecast-chart-horizon')).toMatch(DASH);
    expect(declarationsFor('.forecast-chart-grid')).not.toMatch(DASH);
  });

  it('draws the hover crosshair in full ink at the chart data weight', () => {
    const crosshair = declarationsFor('.forecast-chart-crosshair');

    expect(crosshair).toContain('stroke: var(--color-text);');
    expect(crosshair).toContain('stroke-width: 2;');
  });

  it('keeps the crosshair off the grid ink it used to share', () => {
    expect(declarationsFor('.forecast-chart-grid')).toContain('var(--color-chart-grid)');
    expect(declarationsFor('.forecast-chart-crosshair')).not.toContain('var(--color-chart-grid)');
  });

  /*
   * #335's third vertical. The day boundary shares the horizon's ink and weight,
   * so the dash is the entire difference between them — and it shares the
   * crosshair's solidity, so the weight is the entire difference there. Neither
   * distinction has a second channel to fall back on, which is why both are
   * asserted rather than assumed from the declarations being written down once.
   */
  it('leaves the day boundary solid, which is what keeps the dash the seam’s own mark', () => {
    // Positive control on the same pattern: the emptiness below is a fact about
    // the boundary rather than about a regex that matches nothing.
    expect(declarationsFor('.forecast-chart-horizon')).toMatch(DASH);
    expect(declarationsFor('.forecast-chart-day-boundary')).not.toMatch(DASH);
  });

  it('keeps both hairline verticals off the crosshair’s weight', () => {
    const crosshair = strokeWidthOf('.forecast-chart-crosshair');

    expect(strokeWidthOf('.forecast-chart-day-boundary')).not.toBe(crosshair);
    expect(strokeWidthOf('.forecast-chart-horizon')).not.toBe(crosshair);
    // The pair really is a pair: same weight as each other, told apart by dash
    // alone, which is what the assertion above is protecting.
    expect(strokeWidthOf('.forecast-chart-day-boundary')).toBe(
      strokeWidthOf('.forecast-chart-horizon'),
    );
  });

  /*
   * The guard `declarationsFor` used to make by throwing on any second rule,
   * stated as a case now that the file has a selector it is right to override.
   * Every assertion in this file reads one rule and reports it as the contract; a
   * conditional override of any selector in `UNCONDITIONAL_SELECTORS` would make
   * each of them a partial truth, true of some readers and not others, with
   * nothing failing.
   */
  it('leaves the listed rules unconditional, which is what lets one rule be the contract', () => {
    expect(
      UNCONDITIONAL_SELECTORS.flatMap((selector) =>
        conditionalRulesFor(selector).map(
          (rule) => `${selector} inside ${rule.atRules.join(' / ')}`,
        ),
      ),
    ).toEqual([]);

    // The positive control for that emptiness, on the same filter: the loading
    // trace really is overridden, so the emptiness above is a fact about the
    // listed selectors rather than about a filter that never matches anything.
    expect(conditionalRulesFor(LOADING_TRACE)).toHaveLength(1);
  });
});

/*
 * #448's loading state, which is a drawing rather than a sentence and therefore
 * has a stylesheet's worth of obligation in it rather than a component's.
 *
 * Two things carry one: that the placeholder is drawn in the fleet line's own
 * treatment — it stands where that line is about to be, so a different hue or
 * weight would read as a series rather than as a rehearsal of one — and that a
 * reader who has asked for no motion is given the curve without the sweep.
 * Neither is visible to jsdom, which applies no stylesheet, and the second is
 * not visible to the browser lane either without emulating a system preference,
 * so this is where both are honestly assertable (testing.md rule 10).
 *
 * The timing is deliberately not asserted. "Unhurried, subtle over showy" is the
 * owner's bar and a number pinned here would be a number nobody could argue
 * with — the review is where taste is judged, and `charts.css` says so beside
 * the rule.
 */
describe('charts.css draws the wait instead of spelling it', () => {
  it('traces the placeholder in the fleet line’s own slot and weight', () => {
    const trace = declarationsFor(LOADING_TRACE);

    expect(trace).toContain('stroke: var(--color-chart-1);');
    expect(strokeWidthOf(LOADING_TRACE)).toBe(strokeWidthOf('.forecast-chart-median'));
  });

  it('normalises the dash to the path, so the sweep is a fraction and not a length', () => {
    // `pathLength="1"` on the element (`ForecastChart.tsx`) is the other half of
    // this pair: a dash of 1 is the whole path only because the path was
    // normalised to 1, and the two are useless apart.
    expect(declarationsFor(LOADING_TRACE)).toMatch(/stroke-dasharray\s*:\s*1\s*;/);
    expect(declarationsFor(LOADING_TRACE)).toMatch(/animation\s*:/);
  });

  it('gives a reader who asked for no motion the curve without the sweep', () => {
    const reduced = declarationsIn(REDUCED_MOTION, LOADING_TRACE);

    expect(reduced).toContain('animation: none;');
    /*
     * Drawn and quiet, both stated rather than inherited.
     *
     * The offset is redundant against today's unconditional rule — that rule
     * declares none, so the initial 0 already draws the whole curve — and it is
     * here because the redundancy is the fragile half: the first person to
     * declare a starting `stroke-dashoffset` up there would leave every
     * reduced-motion reader looking at a blank plot, and nothing else in this
     * repo would notice.
     *
     * The opacity is not redundant at all. The unconditional rule sets none
     * either, leaving the initial 1, and every faint frame the animated trace
     * has comes out of its keyframes — so an override that removed the
     * animation and stopped there would hand exactly the reader who asked for
     * less the loudest version of this mark.
     */
    expect(reduced).toMatch(/stroke-dashoffset\s*:\s*0\s*;/);
    expect(reduced).toMatch(/opacity\s*:\s*0\.\d+\s*;/);
  });
});

/*
 * #452's failure state, and the one claim about it that is mechanical rather
 * than visual: it cannot move the page.
 *
 * The owner's ask was that the error show *in the graph area*, and the batch's
 * standing requirement — #448's, applied to the other end of the same read — is
 * that a state arriving or leaving changes nothing about where anything sits.
 * The mechanism for that is structural rather than measured: an absolutely
 * positioned child contributes nothing to its parent's height, so an overlay
 * pinned to `inset: 0` inside a `position: relative` figure occupies the box the
 * chart already has and no other. Three declarations across two rules are the
 * whole of it, and each is useless without the others: drop the figure's
 * `position` and the overlay resolves against some ancestor that is not the
 * chart; drop `absolute` and it joins the flow and pushes the twin down; drop
 * `inset` and it collapses to its content in a corner.
 *
 * jsdom cannot see any of this — it applies no stylesheet and lays nothing out —
 * and neither can the browser lane, because `DemoFleetDataSource` never fails so
 * the state is unreachable in the shipped app (`testing.md` rule 10 asks for
 * that to be said rather than left implied). Reading the declarations is
 * therefore the only guard this state has, which is why it is a named case
 * rather than a line in a comment.
 */
describe('charts.css keeps the failure inside the chart’s own box', () => {
  it('takes the error overlay out of flow, so it cannot change the figure’s height', () => {
    const error = declarationsFor('.forecast-chart-error');

    expect(error).toContain('position: absolute;');
    expect(error).toContain('inset: 0;');
  });

  it('positions the figure, which is what the overlay resolves against', () => {
    // The other half of the pair above. Without it `inset: 0` is measured from
    // whatever ancestor happens to be positioned — the controls row, or the
    // initial containing block — and the overlay lands somewhere that is not the
    // chart, with nothing else in the repo noticing.
    expect(declarationsFor('.forecast-chart-figure')).toContain('position: relative;');
  });
});
