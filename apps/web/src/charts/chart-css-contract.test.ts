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
 * reading the wrong text — the defect recorded as #311. `charts.css` has no
 * at-rule today, and this reader is written so that the day one arrives is a
 * loud failure rather than a silent misread: nesting is tracked, and the lookup
 * below refuses anything it does not model.
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

/**
 * The declarations of the one unconditional rule whose selector list contains
 * `selector`.
 *
 * Every departure from "exactly one, at the top level" throws rather than
 * returning something an assertion could pass against vacuously
 * (error-handling.md rule 1). A missing rule is a violated invariant of this
 * test's own subject — the file is ours and these selectors are the contract. A
 * second rule for the same selector is the interesting case: an `@media`
 * override, or a duplicate further down the file, means the declarations below
 * are no longer the whole story, and reading only the first would report a
 * contract that a reader at some widths never gets.
 */
const declarationsFor = (selector: string): string => {
  const matches = rules.filter((rule) => rule.selectors.includes(selector));
  const [only] = matches;

  if (only === undefined) {
    throw new Error(`charts.css declares no rule for '${selector}'`);
  }

  if (matches.length > 1) {
    throw new Error(
      `charts.css declares ${String(matches.length)} rules for '${selector}'; this contract reads one`,
    );
  }

  if (only.atRules.length > 0) {
    throw new Error(
      `charts.css declares '${selector}' only inside ${only.atRules.join(' / ')}; this contract reads the unconditional rule`,
    );
  }

  return only.declarations;
};

const DASH = /stroke-dasharray\s*:/;
const STROKE_WIDTH = /stroke-width\s*:\s*(?<width>[^;]+);/;

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
});
