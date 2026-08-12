import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

/*
 * The theme switch's off state has to be visible, and that is arithmetic rather
 * than taste — so it is asserted rather than looked at.
 *
 * #455 shipped the switch with an off-state track on `--color-border` and a
 * thumb on `--color-surface`, and a browser pass measured both pairings a long
 * way under the bar, in both themes: a control whose only job is to show its
 * state was a faint smudge in one of the two states it exists to tell apart.
 * (No figures written down for that here — the positive control below still
 * measures that exact pairing, and prints what it gets whenever it is asked.)
 *
 * Nothing in the suite noticed, because nothing in the suite owned the property
 * — no stylelint rule reads a pair of tokens, and the component tests ask what
 * the switch *announces* (`role="switch"`, `aria-checked`), never what it looks
 * like. This file is that missing owner, for the pairing that was wrong.
 *
 * ## What it proves, and what it cannot
 *
 * It reads `app.css` for the tokens the off state names and `tokens.css` for
 * what those tokens resolve to, then computes WCAG 2.x contrast over both
 * theme blocks. So it proves the *declarations* pair legibly — not that they
 * take effect. jsdom applies no stylesheet, so a rendered `getComputedStyle`
 * here would report initial values and pass against an empty file; measuring a
 * painted switch needs a real browser, which is the other lane's work
 * (testing.md rule 10) and which no spec in `e2e/` does today.
 *
 * That split is why this lives in `apps/web` rather than beside
 * `packages/ui/src/tokens/tokens.test.ts`, which is the other plausible home and
 * the wrong one. The defect was never a token value — `--color-border` is a
 * perfectly good hairline colour and still is. It was the *pairing*: which token
 * this control spends on which part. That pairing is written in `app.css`, an
 * app file, and a packages/ui test may not read one (architecture.md rule 1). A
 * token-pair assertion over there would have to name the pairing it is guarding
 * without being able to see it, and would stay green the day someone points the
 * track back at `--color-border`.
 *
 * ## Scope
 *
 * The off state only. The on state's track is `--color-accent`, whose measured
 * figures against both opaque surfaces are owned and argued in `tokens.css`'s
 * header, and it was never the defect. One pairing, two themes — a general
 * contrast harness over every token pair in the app is a different piece of work
 * and would need a different justification.
 */

/** WCAG 1.4.11: the floor for the boundaries of a control that carries meaning. */
const MEANINGFUL_BOUNDARY = 3;

interface ThemeBlock {
  /** The theme's name, so a failure says which of the two fell short. */
  readonly theme: string;
  /** The selector `tokens.css` declares this theme's colours under. */
  readonly selector: string;
}

/** Both blocks, because a switch legible in one theme and not the other is still broken. */
const THEME_BLOCKS: readonly ThemeBlock[] = [
  { theme: 'light', selector: ':root' },
  { theme: 'dark', selector: "[data-theme='dark']" },
];

/**
 * The stylesheet with its comments blanked out, so prose *about* a colour proves
 * nothing.
 *
 * Load-bearing rather than tidy: both files argue about `--color-border` and
 * `--color-surface` at length in the very comments that sit above the rules
 * below, and a reader that kept them would measure a sentence.
 */
const withoutComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, '');

const appCss = withoutComments(readFileSync(new URL('./app.css', import.meta.url), 'utf8'));

/*
 * Resolved through `@cumulo/ui`'s declared `./tokens.css` export rather than by
 * a relative path up and across the package boundary — the dependency is
 * app → package either way, but only one of the two forms is a published
 * surface (architecture.md rule 1).
 */
const tokensCss = withoutComments(
  readFileSync(createRequire(import.meta.url).resolve('@cumulo/ui/tokens.css'), 'utf8'),
);

/**
 * The declarations of the rule that *starts a line* with `selector`.
 *
 * The line anchor is what tells `.theme-toggle-track`'s own rule from the
 * descendant selector that repaints it when the switch is on: the on-state rule
 * writes the same class with a parent in front of it, so an unanchored search
 * would find whichever came first in the file and could silently measure the
 * other state.
 *
 * A missing rule is a violated invariant of this test's own subject rather than
 * an expected failure — the file is ours and these selectors are the contract —
 * so it throws instead of returning an empty block that would let the assertion
 * pass vacuously (error-handling.md rule 1).
 */
const declarationsFor = (selector: string): string => {
  const opensAt = appCss.indexOf(`\n${selector} {`);

  if (opensAt === -1) {
    throw new Error(`app.css declares no top-level rule for '${selector}'`);
  }

  return appCss.slice(opensAt, appCss.indexOf('}', opensAt));
};

/** The custom property a rule fills its background with, e.g. `--color-surface`. */
const backgroundTokenOf = (selector: string): string => {
  const token = /background:\s*var\((--[a-z0-9-]+)\)/.exec(declarationsFor(selector))?.[1];

  if (token === undefined) {
    throw new Error(`'${selector}' fills its background with no single design token`);
  }

  return token;
};

/** What `property` resolves to in one theme's block of `tokens.css`. */
const colourOf = (property: string, block: ThemeBlock): string => {
  const opensAt = tokensCss.indexOf(`${block.selector} {`);

  if (opensAt === -1) {
    throw new Error(`tokens.css declares no '${block.selector}' block`);
  }

  const declarations = tokensCss.slice(opensAt, tokensCss.indexOf('}', opensAt));
  const colour = new RegExp(`${property}:\\s*(#[0-9a-f]{6})`).exec(declarations)?.[1];

  if (colour === undefined) {
    throw new Error(`tokens.css gives '${property}' no plain colour in the ${block.theme} block`);
  }

  return colour;
};

/** One channel of an `#rrggbb` colour, linearised — WCAG 2.x, sRGB. */
const linearChannel = (colour: string, at: number): number => {
  const srgb = Number.parseInt(colour.slice(at, at + 2), 16) / 255;

  return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
};

const relativeLuminance = (colour: string): number =>
  0.2126 * linearChannel(colour, 1) +
  0.7152 * linearChannel(colour, 3) +
  0.0722 * linearChannel(colour, 5);

const contrastRatio = (one: string, other: string): number => {
  const [a, b] = [relativeLuminance(one), relativeLuminance(other)];

  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
};

/**
 * Every off-state pairing that fails the bar, in both themes, as
 * `theme pairing ratio` — so a failure names the state to fix and what it
 * measured, rather than reporting that `false` was not `true`.
 *
 * Both obligations of WCAG 1.4.11 are here: the track against the surface it
 * sits on (is there a control?) and the thumb against the track (which way is it
 * thrown?). They resolve to the same inequality while the thumb wears
 * `--color-surface`, and are written separately because that is a property of
 * today's pairing rather than of the rule.
 */
const shortfalls = (trackToken: string, thumbToken: string): readonly string[] =>
  THEME_BLOCKS.flatMap((block) => {
    const track = colourOf(trackToken, block);

    return [
      {
        pairing: 'track vs the surface it sits on',
        ratio: contrastRatio(track, colourOf('--color-surface', block)),
      },
      {
        pairing: 'thumb vs track',
        ratio: contrastRatio(colourOf(thumbToken, block), track),
      },
    ]
      .filter((measured) => measured.ratio < MEANINGFUL_BOUNDARY)
      .map((measured) => `${block.theme}: ${measured.pairing} — ${measured.ratio.toFixed(2)}:1`);
  });

describe('the theme switch shows its off state', () => {
  it('pairs an off-state track, thumb and surface that all clear the bar, in both themes', () => {
    const track = backgroundTokenOf('.theme-toggle-track');
    const thumb = backgroundTokenOf('.theme-toggle-thumb');

    /*
     * The pairing #455 replaced, kept as the positive control: it must still
     * fall short on every pairing the assertion below measures — two per theme.
     * Without it a green run would prove only that the arithmetic ran, since
     * "nothing falls short" passes just as happily when the measurement has
     * quietly stopped measuring anything.
     *
     * Both of its operands are named here rather than taken from the rules
     * above, so that the control keeps measuring the pairing it is named for
     * even after a legitimate change moves one of them.
     */
    expect(shortfalls('--color-border', '--color-surface').length).toBe(2 * THEME_BLOCKS.length);

    expect(
      shortfalls(track, thumb),
      `WCAG 1.4.11 — a control that carries meaning needs ${String(MEANINGFUL_BOUNDARY)}:1 at its boundaries, and this one is meaning only.`,
    ).toEqual([]);
  });
});
