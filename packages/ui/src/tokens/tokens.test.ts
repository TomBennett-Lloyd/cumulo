import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { tokens } from './tokens';

const css = readFileSync(new URL('./tokens.css', import.meta.url), 'utf8');

const LIGHT_SELECTOR = ':root';
const DARK_SELECTOR = "[data-theme='dark']";

/**
 * The declaration block for a top-level selector. A missing selector is a
 * violated invariant of this package, not an expected failure — the tokens
 * file is ours and both blocks are mandatory (error-handling.md rule 1).
 */
function declarationBlock(selector: string): string {
  const selectorAt = css.indexOf(`${selector} {`);
  if (selectorAt === -1) {
    throw new Error(`tokens.css declares no '${selector}' block`);
  }
  const opensAt = css.indexOf('{', selectorAt);
  const closesAt = css.indexOf('}', opensAt);
  if (closesAt === -1) {
    throw new Error(`tokens.css never closes the '${selector}' block`);
  }
  return css.slice(opensAt + 1, closesAt);
}

/** Custom property names declared in a block, e.g. `--color-bg`. */
function declaredProperties(selector: string): Set<string> {
  const block = declarationBlock(selector);
  return new Set(block.match(/^\s*(--[a-z0-9-]+)\s*:/gm)?.map((line) => line.trim().slice(0, -1)));
}

/** Custom property names the TypeScript surface promises exist. */
function referencedProperties(): Set<string> {
  const referenced = new Set<string>();
  for (const group of Object.values(tokens)) {
    for (const value of Object.values(group)) {
      const name = /^var\((--[a-z0-9-]+)\)$/.exec(value)?.[1];
      expect(name, `token value '${value}' is not a plain var(--…) reference`).toBeDefined();
      if (name !== undefined) referenced.add(name);
    }
  }
  return referenced;
}

const colourProperties = (properties: Set<string>): string[] =>
  [...properties].filter((name) => name.startsWith('--color-')).sort();

describe('tokens.ts against tokens.css', () => {
  it('references only custom properties declared in the light block', () => {
    const declared = declaredProperties(LIGHT_SELECTOR);
    const undeclared = [...referencedProperties()].filter((name) => !declared.has(name)).sort();

    expect(undeclared).toEqual([]);
  });

  it('gives every declared custom property a typed handle', () => {
    const referenced = referencedProperties();
    const unexposed = [...declaredProperties(LIGHT_SELECTOR)]
      .filter((name) => !referenced.has(name))
      .sort();

    expect(unexposed).toEqual([]);
  });
});

describe('light and dark colour blocks', () => {
  it('overrides every light colour token in dark mode, and adds none of its own', () => {
    const light = colourProperties(declaredProperties(LIGHT_SELECTOR));
    const dark = colourProperties(declaredProperties(DARK_SELECTOR));

    expect(dark).toEqual(light);
  });

  it('leaves spacing, type and radius tokens mode-invariant', () => {
    const darkNonColour = [...declaredProperties(DARK_SELECTOR)].filter(
      (name) => !name.startsWith('--color-'),
    );

    expect(darkNonColour).toEqual([]);
  });
});
