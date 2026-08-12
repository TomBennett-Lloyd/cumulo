import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/*
 * The parts of `map.css` that carry a design obligation rather than a
 * preference, asserted mechanically.
 *
 * A component test cannot reach any of this: jsdom applies no stylesheet, so
 * `getComputedStyle` on a rendered marker reports the initial value of every
 * property below and would pass against an empty file. Reading the stylesheet
 * as text is the honest form of the check this lane can run; measuring a
 * *rendered* marker needs a real browser, which is the browser lane's kind of
 * work (testing.md rule 10). That lane now exists — `apps/web/e2e/` — but no
 * spec in it measures a marker's hit target or opacity today, so this text
 * check is still the only observer these declarations have.
 *
 * So this proves the declarations exist, not that they take effect — which is
 * exactly the failure it is here to catch: a hit target quietly shrunk back to
 * the size of the painted mark, or crowding answered by fading a marker out.
 */

const css = readFileSync(new URL('./map.css', import.meta.url), 'utf8');

/** The stylesheet with comments removed, so prose about `opacity` proves nothing. */
const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');

interface CssRule {
  readonly selectors: readonly string[];
  readonly declarations: string;
}

const rules: readonly CssRule[] = [...withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(
  (match) => ({
    selectors: (match[1] ?? '').split(',').map((selector) => selector.trim()),
    declarations: match[2] ?? '',
  }),
);

/**
 * The declarations of the rule whose selector list contains `selector`.
 *
 * A missing rule is a violated invariant of this test's own subject — the file
 * is ours and these selectors are the contract — so it throws rather than
 * returning an empty string that would let an assertion pass vacuously
 * (error-handling.md rule 1).
 */
const declarationsFor = (selector: string): string => {
  const rule = rules.find((candidate) => candidate.selectors.includes(selector));

  if (rule === undefined) {
    throw new Error(`map.css declares no rule for '${selector}'`);
  }

  return rule.declarations;
};

describe('map.css marker contract', () => {
  it.each(['.map-site-marker', '.map-cluster-marker'])(
    'gives %s a hit area of at least --space-6 in both directions',
    (selector) => {
      const declarations = declarationsFor(selector);

      expect(declarations).toContain('min-width: var(--space-6);');
      expect(declarations).toContain('min-height: var(--space-6);');
    },
  );

  it('paints a site mark smaller than the area that responds to it', () => {
    const mark = declarationsFor('.map-site-marker::before');

    expect(mark).toContain('width: var(--space-3);');
    expect(mark).toContain('height: var(--space-3);');
    expect(declarationsFor('.map-site-marker')).toContain('background: transparent;');
  });

  it('gives keyboard focus the selected treatment, in the very same rule', () => {
    const focusRule = rules.find((rule) =>
      rule.selectors.includes('.map-site-marker:focus-visible::before'),
    );

    expect(focusRule?.selectors).toContain('.map-site-marker-selected::before');
  });

  it('never suppresses the platform focus ring', () => {
    expect(withoutComments).not.toMatch(/outline\s*:/);
  });

  it('never fades a marker: crowding is answered by clustering', () => {
    expect(withoutComments).not.toMatch(/opacity\s*:/);
  });
});

describe('map.css attribution contract', () => {
  /*
   * The credits' ink is a licence obligation rather than a preference, and since
   * #428 it is one this file carries alone.
   *
   * The band sits on `--color-surface-veil` at a mix where muted ink is under AA
   * for small text in both modes — and muted is exactly what both credits fall
   * back to without the rules below: `attribution.css` gives the Open-Meteo
   * credit muted ink for the four opaque surfaces it also serves, and the tile
   * credit is matched to it. `docs/design/map-treatment.md`'s Attribution
   * section carries the measured ratios and `tokens.css`'s header owns them.
   *
   * Delete either rule and nothing fails anywhere else: the ink changes, the
   * markup does not, and the browser lane's `attribution-band.spec.ts` and
   * `composition.spec.ts` ask whether the credits are present, boxed where they
   * should be and clickable — never what colour they are. Until a lane spec
   * measures rendered contrast (testing.md rule 10), this is the only observer
   * the two declarations have, which is the same standing the marker rules above
   * have and the same reason they are asserted as text.
   */
  it.each([
    '.map-attribution-tiles',
    '.map-attribution-tiles a',
    '.map-attribution .cumulo-attribution',
    '.map-attribution .cumulo-attribution a',
  ])('gives %s base ink, the only ink that clears AA on the veil', (selector) => {
    expect(declarationsFor(selector)).toContain('color: var(--color-text);');
  });
});
