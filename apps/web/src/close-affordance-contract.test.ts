import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/*
 * A close affordance is an icon, and the word "Close" is its accessible name —
 * enforced mechanically instead of by review attention.
 *
 * `design.md` rule 2 settles it: a label whose only job is naming a control for
 * assistive technology becomes an accessible name, not visible text, and the
 * word "close" is one of the two named instances of that move. So the word is
 * not banned — it is *relocated*. `aria-label="Close"` is the required form, and
 * every `getByRole('button', { name: 'Close' })` in the suites keeps resolving
 * because the name is still there; what must never come back is the word
 * standing in the rendered output as a child of the button.
 *
 * This reads sources as text, in the pattern of
 * `dashboard/state-copy-contract.test.ts`. So it proves *where a word is
 * written*, not what a reader sees: a component test renders one component and
 * can only check the affordances it was told about, which is the wrong shape for
 * catching the third icon-less close button somebody authors next quarter.
 * Nothing here asserts that either button renders — `map/SitePopoverCard.test.tsx`
 * and `header/AboutDialog.test.tsx` do that, by accessible name, and they are
 * what breaks if the name is dropped along with the text.
 *
 * ## Why the sweep idiom is copied rather than shared (`structure.md` rule 7)
 *
 * The fs walk, the comment blanking and the `file:line` report read like the
 * ones in `state-copy-contract.test.ts`, and they are deliberately not extracted
 * into a shared helper. The two contracts hold *opposite* policies on the thing
 * the helpers exist to decide. That file's retired phrases are banned "not even
 * in a comment", so half its sweeps read the source verbatim; this one bans a
 * word from the visible layer while requiring it in the accessibility tree and
 * welcoming it in prose — every docblock in `SitePopoverCard.tsx` that explains
 * what pressing Close does is correct and must stay legal. A shared reader would
 * have to be parameterised by which policy the caller holds, and rule 7 names
 * that mode flag as the tell that two intents were forced together. If one copy
 * changed, the other would not be wrong until it changed the same way — so the
 * duplication is incidental and stands.
 *
 * This file is a `.ts` rather than a `.tsx`, so `isGoverned`'s first arm excludes
 * it before the `.test.` arm is ever reached — which is what lets it hold the
 * retired shapes as positive controls without tripping itself. (It is also a
 * `*.test.*`, so it would be excluded either way; the `.tsx` narrowing is the
 * mechanism actually doing it, and the one to keep in mind if this file is ever
 * split.)
 */

/** `apps/web/src` — the trailing slash makes this a base for `new URL(relative, …)`. */
const SOURCE_ROOT = new URL('./', import.meta.url);

/**
 * The site card's close button as it stood before the icon landed, kept as the
 * exact-line sweep's positive control.
 *
 * Held with its original indentation, because the pattern's whole subject is a
 * line whose only content is the word: a control's text child on its own line is
 * how every formatter in this repo writes one, so that is the shape the sweep
 * has to see.
 */
const RETIRED_POPOVER_CLOSE_TEXT = '          Close';

/**
 * The same affordance written inline, kept as the second sweep's positive
 * control.
 *
 * The exact-line pattern above cannot see this one — Prettier only splits a
 * button's child onto its own line once the element is too wide to fit — so a
 * short enough button would have slipped a visible "Close" past a
 * single-pattern gate. Two patterns, because there are two ways to write the
 * same defect.
 */
const RETIRED_INLINE_CLOSE = '<button type="button" onClick={onClose}>Close</button>';

/** Sources the rule governs: app components, excluding tests, fixtures and the preview harness. */
const isGoverned = (path: string): boolean =>
  path.endsWith('.tsx') &&
  !path.includes('.test.') &&
  !path.includes('-test-fixture') &&
  !path.startsWith('preview/');

const governedFiles: readonly string[] = readdirSync(SOURCE_ROOT, {
  encoding: 'utf8',
  recursive: true,
}).filter(isGoverned);

const readSource = (file: string): string => readFileSync(new URL(file, SOURCE_ROOT), 'utf8');

/**
 * The source with comments blanked out, so prose *about* the word proves nothing.
 *
 * Load-bearing here rather than merely tidy: the docblocks describing what
 * pressing Close does are the very thing this rule leaves alone, and a sweep
 * that read them would report the explanation as the violation.
 *
 * Block comments are overwritten in place rather than deleted, and comment-only
 * lines are emptied rather than dropped, so every surviving line keeps its
 * original number and a failure can name `file:line` truthfully.
 */
const withoutComments = (source: string): string =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .split('\n')
    .map((line) => (/^\s*(?:\/\/|\*)/.test(line) ? '' : line))
    .join('\n');

interface SourceLine {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

/** Every line of every listed file matching `pattern`, once its comments are blank. */
const linesMatching = (files: readonly string[], pattern: RegExp): readonly SourceLine[] =>
  files.flatMap((file) =>
    withoutComments(readSource(file))
      .split('\n')
      .map((text, index) => ({ file, line: index + 1, text }))
      .filter((entry) => pattern.test(entry.text)),
  );

/** The offending lines as `file:line: text`, so a failure diff is the list of places to fix. */
const report = (hits: readonly SourceLine[]): string =>
  hits.map((hit) => `${hit.file}:${String(hit.line)}: ${hit.text.trim()}`).join('\n');

/** What every failure below tells the author to do instead. */
const RELOCATE = [
  'A close affordance is an icon; the word belongs to the accessibility tree, not the visible layer.',
  'Draw the X and give the button aria-label="Close" (design.md rule 2 / P2, issues 340 and 346).',
].join(' ');

describe('the word Close is an accessible name, never visible text', () => {
  /*
   * Both assertions below are negative sweeps, which pass just as happily when
   * the walk is empty. This one fails first if that ever happens.
   */
  it('sweeps the app it claims to sweep', () => {
    expect(governedFiles).toContain('map/SitePopoverCard.tsx');
    expect(governedFiles).toContain('header/AboutDialog.tsx');
    expect(governedFiles.length).toBeGreaterThan(20);
  });

  it('renders no button whose text child is the word on its own line', () => {
    const visibleCloseLine = /^\s*Close\s*$/;

    expect(visibleCloseLine.test(RETIRED_POPOVER_CLOSE_TEXT)).toBe(true);

    expect(report(linesMatching(governedFiles, visibleCloseLine)), RELOCATE).toBe('');
  });

  it('renders no element with the word inline between its tags', () => {
    // Whitespace-tolerant on both sides: `>Close<` and `> Close <` are the same
    // rendered word, and JSX collapses the padding away.
    const visibleCloseInline = />\s*Close\s*</;

    expect(visibleCloseInline.test(RETIRED_INLINE_CLOSE)).toBe(true);

    expect(report(linesMatching(governedFiles, visibleCloseInline)), RELOCATE).toBe('');
  });
});
