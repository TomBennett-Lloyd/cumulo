import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

/*
 * Every declared control pairing clears its WCAG floor in both themes: each row
 * of `PAIRINGS` names a part of a control by stylesheet, selector and property,
 * names the backdrop it must read against, and is recomputed here from those
 * declarations and `tokens.css` (#181; #536 widens the table).
 *
 * It proves the declarations pair legibly, not that they take effect: jsdom
 * applies no stylesheet, so a painted control is the browser lane's to measure
 * (testing.md rule 10).
 */

/** WCAG 1.4.11: the floor for the visual information that identifies a control. */
const MEANINGFUL_BOUNDARY = 3;

/** WCAG 1.4.3: the floor for small text — a control's label, a link. */
const SMALL_TEXT = 4.5;

interface ThemeBlock {
  /** The theme's name, so a failure says which of the two fell short. */
  readonly theme: string;
  /** The selector `tokens.css` declares this theme's colours under. */
  readonly selector: string;
}

const THEME_BLOCKS: readonly ThemeBlock[] = [
  { theme: 'light', selector: ':root' },
  { theme: 'dark', selector: "[data-theme='dark']" },
];

/** The stylesheet with its comments blanked out, so prose *about* a colour proves nothing. */
const withoutComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, '');

interface Stylesheet {
  /** The path the sheet was read from, so a failure names the file. */
  readonly name: string;
  readonly text: string;
}

const stylesheet = (path: string): Stylesheet => ({
  name: path,
  text: withoutComments(readFileSync(new URL(path, import.meta.url), 'utf8')),
});

const APP_CSS = stylesheet('./app.css');
const UNIT_TOGGLE_CSS = stylesheet('./dashboard/unit-toggle.css');
const RANGE_PICKER_CSS = stylesheet('./dashboard/range-picker.css');
const ADD_SITE_CSS = stylesheet('./add-site/add-site.css');
const INFO_CSS = stylesheet('./info/info.css');
const HEADER_CSS = stylesheet('./header/header.css');
const PANEL_STATES_CSS = stylesheet('./dashboard/panel-states.css');
const MAP_CSS = stylesheet('./map/map.css');

/* Through `@cumulo/ui`'s declared `./tokens.css` export, the package's published
   surface, rather than a relative path across the package boundary
   (architecture.md rule 1). */
const tokensCss = withoutComments(
  readFileSync(createRequire(import.meta.url).resolve('@cumulo/ui/tokens.css'), 'utf8'),
);

/**
 * The declarations of the rule that *starts a line* with `selector`.
 *
 * The line anchor tells a control's own rule from a state rule that repaints it
 * (`.theme-toggle[aria-checked='true'] .theme-toggle-track`,
 * `.range-picker-trigger:hover`), and skips a grouped rule's last line
 * (`.add-site-cancel,\n.add-site-submit {`), which starts a line too. A missing
 * rule throws rather than returning an empty block a row could pass against
 * vacuously (error-handling.md rule 1).
 */
const declarationsFor = (css: Stylesheet, selector: string): string => {
  const opener = `\n${selector} {`;
  const ownsRule = (at: number): boolean => !css.text.slice(0, at).trimEnd().endsWith(',');
  let opensAt = css.text.indexOf(opener);

  while (opensAt !== -1 && !ownsRule(opensAt)) {
    opensAt = css.text.indexOf(opener, opensAt + 1);
  }

  if (opensAt === -1) {
    throw new Error(`${css.name} declares no top-level rule for '${selector}'`);
  }

  return css.text.slice(opensAt, css.text.indexOf('}', opensAt));
};

type ColourProperty = 'background' | 'border-color' | 'color';

/** A colour a stylesheet rule declares, by the rule's selector and the property. */
interface Declared {
  readonly css: Stylesheet;
  readonly selector: string;
  readonly property: ColourProperty;
}

/** A backdrop named by token, for a surface the control sits on rather than owns. */
interface Named {
  readonly token: string;
}

interface Pairing {
  readonly control: string;
  readonly part: Declared;
  readonly against: Declared | Named;
  readonly floor: number;
}

/**
 * The custom property `selector`'s rule spends on `property`, e.g. `--color-surface`.
 * The lookbehind keeps `color` from matching inside `border-color`.
 */
const tokenOf = (css: Stylesheet, selector: string, property: ColourProperty): string => {
  const token = new RegExp(`(?<![\\w-])${property}:\\s*var\\((--[a-z0-9-]+)\\)`).exec(
    declarationsFor(css, selector),
  )?.[1];

  if (token === undefined) {
    throw new Error(`${css.name}: '${selector}' sets its ${property} to no single design token`);
  }

  return token;
};

const tokenFor = (operand: Declared | Named): string =>
  'token' in operand ? operand.token : tokenOf(operand.css, operand.selector, operand.property);

const labelFor = (operand: Declared | Named): string =>
  'token' in operand ? operand.token : `${operand.selector} ${operand.property}`;

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
 * Every theme in which `partToken` falls short of `floor` against `againstToken`,
 * as `theme control part-vs-backdrop ratio`, so a failure names what to fix and
 * what it measured.
 */
const shortfalls = (
  label: string,
  partToken: string,
  againstToken: string,
  floor: number,
): readonly string[] =>
  THEME_BLOCKS.flatMap((block) => {
    const ratio = contrastRatio(colourOf(partToken, block), colourOf(againstToken, block));

    return ratio < floor ? [`${block.theme}: ${label} — ${ratio.toFixed(2)}:1`] : [];
  });

const describePairing = (row: Pairing): string =>
  `${row.control}: ${labelFor(row.part)} vs ${labelFor(row.against)}`;

/*
 * `.map-control-reset` and `.map-control-add` are absent: their backdrop is
 * `--color-surface-veil`, a `color-mix()` `colourOf` cannot resolve, whose
 * figures `tokens.css`'s header owns.
 */
const PAIRINGS: readonly Pairing[] = [
  {
    control: 'theme toggle',
    part: { css: APP_CSS, selector: '.theme-toggle-track', property: 'background' },
    against: { token: '--color-surface' },
    floor: MEANINGFUL_BOUNDARY,
  },
  {
    control: 'theme toggle',
    part: { css: APP_CSS, selector: '.theme-toggle-thumb', property: 'background' },
    against: { css: APP_CSS, selector: '.theme-toggle-track', property: 'background' },
    floor: MEANINGFUL_BOUNDARY,
  },
  {
    control: 'unit toggle',
    part: { css: UNIT_TOGGLE_CSS, selector: '.unit-toggle', property: 'border-color' },
    against: { token: '--color-surface' },
    floor: MEANINGFUL_BOUNDARY,
  },
  {
    control: 'range chip',
    part: { css: RANGE_PICKER_CSS, selector: '.range-picker-button', property: 'border-color' },
    against: { token: '--color-surface' },
    floor: MEANINGFUL_BOUNDARY,
  },
  {
    control: 'add-site input',
    part: { css: ADD_SITE_CSS, selector: '.add-site-input', property: 'border-color' },
    against: { token: '--color-surface' },
    floor: MEANINGFUL_BOUNDARY,
  },
  {
    control: 'add-site input',
    part: { css: ADD_SITE_CSS, selector: '.add-site-input', property: 'border-color' },
    against: { css: ADD_SITE_CSS, selector: '.add-site-input', property: 'background' },
    floor: MEANINGFUL_BOUNDARY,
  },
  {
    control: 'range trigger',
    part: { css: RANGE_PICKER_CSS, selector: '.range-picker-trigger', property: 'color' },
    against: { css: RANGE_PICKER_CSS, selector: '.range-picker-trigger', property: 'background' },
    floor: MEANINGFUL_BOUNDARY,
  },
  {
    control: 'info tip',
    part: { css: INFO_CSS, selector: '.info-tip-button', property: 'color' },
    against: { css: INFO_CSS, selector: '.info-tip-button', property: 'background' },
    floor: MEANINGFUL_BOUNDARY,
  },
  {
    control: 'about-dialog link',
    part: { css: HEADER_CSS, selector: '.about-dialog a', property: 'color' },
    against: { css: HEADER_CSS, selector: '.about-dialog', property: 'background' },
    floor: SMALL_TEXT,
  },
  {
    control: 'add-site submit',
    part: { css: ADD_SITE_CSS, selector: '.add-site-submit', property: 'color' },
    against: { css: ADD_SITE_CSS, selector: '.add-site-submit', property: 'background' },
    floor: SMALL_TEXT,
  },
  {
    control: 'panel retry',
    part: { css: PANEL_STATES_CSS, selector: '.panel-retry', property: 'color' },
    against: { css: PANEL_STATES_CSS, selector: '.panel-retry', property: 'background' },
    floor: SMALL_TEXT,
  },
  {
    control: 'cluster marker',
    part: { css: MAP_CSS, selector: '.map-cluster-marker', property: 'color' },
    against: { css: MAP_CSS, selector: '.map-cluster-marker', property: 'background' },
    floor: SMALL_TEXT,
  },
];

describe('every declared control pairing clears its floor', () => {
  it('still measures the replaced theme-toggle off-state pairing as falling short, in both themes', () => {
    /*
     * The positive control, on the pairing #455 replaced: without it, "nothing
     * falls short" would pass just as happily once the measurement stopped
     * measuring anything. Both operands are named rather than read from a rule,
     * so it keeps measuring this pairing after a legitimate change moves one.
     */
    const replaced = [
      ...shortfalls('track vs surface', '--color-border', '--color-surface', MEANINGFUL_BOUNDARY),
      ...shortfalls('thumb vs track', '--color-surface', '--color-border', MEANINGFUL_BOUNDARY),
    ];

    expect(replaced.length).toBe(2 * THEME_BLOCKS.length);
  });

  it('still measures border ink as text on the surface as falling short of the small-text floor, in both themes', () => {
    expect(
      shortfalls('border vs surface', '--color-border', '--color-surface', SMALL_TEXT),
    ).toHaveLength(THEME_BLOCKS.length);
  });

  it.each(PAIRINGS.map((row): [string, Pairing] => [describePairing(row), row]))(
    '%s',
    (label, row) => {
      expect(
        shortfalls(label, tokenFor(row.part), tokenFor(row.against), row.floor),
        `This part of the control needs ${String(row.floor)}:1 against its backdrop (WCAG 1.4.11 for a boundary, 1.4.3 for text).`,
      ).toEqual([]);
    },
  );
});
