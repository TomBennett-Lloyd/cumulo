import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { EMPTY_FLEET_MESSAGE } from './state-copy';

/*
 * The convention that `state-copy.ts` owns apps/web's state copy, enforced
 * mechanically instead of by review attention.
 *
 * This reads sources as text, in the pattern of `map/map-css-contract.test.ts`.
 * So it proves *where a phrase is written*, not what the reader sees: a
 * component test renders one component and can only pin the strings it was
 * told to look for, which is exactly the wrong shape for catching the fifth
 * "Loading X…" somebody authors beside its JSX next quarter. Nothing here
 * asserts that any of this copy renders — the component suites do that, by
 * name, and they are what breaks if the wording drifts.
 *
 * The rejected alternative, honestly: an ESLint `no-restricted-syntax` ban on
 * `JSXText` (the repo already uses that rule for the token gate, so it was the
 * obvious reach). It was assessed and rejected — it cannot tell state copy from
 * headings, control names, and `<dt>` labels, none of which this convention
 * owns, so it would need an allowlist of every legitimate string in the app.
 * That allowlist rots the first week nobody updates it, and a rotting allowlist
 * is worse than no rule because it still reports green. Guarding the specific
 * phrase classes the convention *does* own is the part that is enforceable, so
 * that is what this file does.
 *
 * This file is a `*.test.*`, so the sweep below excludes it — which is what
 * lets it hold banned phrases as positive controls without tripping itself.
 */

/** `apps/web/src` — the trailing slash makes this a base for `new URL(relative, …)`. */
const SOURCE_ROOT = new URL('../', import.meta.url);

/** The one module allowed to hold this copy; every sweep below is "everywhere but here". */
const STATE_COPY = 'dashboard/state-copy.ts';

/**
 * A phrase from before the rewrite, kept here as assertion 3's positive control.
 *
 * `state-copy.ts` deliberately does not quote it — its header describes the
 * removal without naming the word, because a comment explaining the ban would
 * be the one thing keeping the ban from ever going quiet.
 */
const RETIRED_EMPTY_FLEET_LINE = 'No active sites yet';

/**
 * The instruction the map's add-site control replaced, kept as assertion 4's
 * positive control.
 *
 * It was written twice — the empty fleet's invitation and `ADD_SITE_HINT`
 * beside the fleet chart — which is the whole reason this sweep exists rather
 * than a rewrite of the two known copies. A bare click on the basemap does not
 * place a site any more (#265), so any surface still promising one is teaching
 * the reader an interaction the app no longer has.
 *
 * `state-copy.ts` deliberately does not quote it either, for the same reason as
 * the line above.
 */
const RETIRED_ADD_SITE_INSTRUCTION = 'Click anywhere on the map to add a site';

/** Sources the convention governs: app code, excluding tests, fixtures and the preview harness. */
const isGoverned = (path: string): boolean =>
  /\.tsx?$/.test(path) &&
  !path.includes('.test.') &&
  !path.includes('-test-fixture') &&
  !path.startsWith('preview/');

const governedFiles: readonly string[] = readdirSync(SOURCE_ROOT, {
  encoding: 'utf8',
  recursive: true,
}).filter(isGoverned);

/** Everything the copy has to stay out of: the governed sources minus its own module. */
const otherFiles: readonly string[] = governedFiles.filter((file) => file !== STATE_COPY);

const readSource = (file: string): string => readFileSync(new URL(file, SOURCE_ROOT), 'utf8');

/**
 * The source with comments blanked out, so prose *about* a phrase proves nothing.
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

/** Identity, for the sweep that deliberately reads comments too (assertion 3). */
const verbatim = (source: string): string => source;

interface SourceLine {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

/**
 * Every line of every listed file matching `pattern`, after `prepare`.
 *
 * `prepare` is a parameter rather than a captured mode flag so each call site
 * states, in the signature, whether it is reading code or reading everything.
 */
const linesMatching = (
  files: readonly string[],
  pattern: RegExp,
  prepare: (source: string) => string,
): readonly SourceLine[] =>
  files.flatMap((file) =>
    prepare(readSource(file))
      .split('\n')
      .map((text, index) => ({ file, line: index + 1, text }))
      .filter((entry) => pattern.test(entry.text)),
  );

/** The offending lines as `file:line: text`, so a failure diff is the list of places to fix. */
const report = (hits: readonly SourceLine[]): string =>
  hits.map((hit) => `${hit.file}:${String(hit.line)}: ${hit.text.trim()}`).join('\n');

describe('state copy has one owner', () => {
  /*
   * Three of the four assertions below are negative sweeps, which pass just as
   * happily when the walk is empty. This one fails first if that ever happens.
   */
  it('sweeps the app it claims to sweep', () => {
    expect(governedFiles).toContain(STATE_COPY);
    expect(governedFiles).toContain('dashboard/LazyMapRegion.tsx');
    expect(governedFiles).toContain('AppErrorBoundary.tsx');
    expect(governedFiles.length).toBeGreaterThan(20);
  });

  it('keeps pending labels out of the components that render them', () => {
    const stateCopyEllipses = withoutComments(readSource(STATE_COPY))
      .split('\n')
      .filter((line) => line.includes('…'));

    expect(stateCopyEllipses.length).toBeGreaterThanOrEqual(3);

    expect(
      report(linesMatching(otherFiles, /…/, withoutComments)),
      'Every pending label ends in an ellipsis and belongs in dashboard/state-copy.ts',
    ).toBe('');
  });

  it('keeps failure sentences out of the components that render them', () => {
    // `data unavailable` joined the list in #452, when the chart's total-failure
    // sentence arrived: it is the one failure line with no verb in it, so none
    // of the three patterns above would have caught a copy of it authored beside
    // the JSX that renders it.
    const failurePrefix = /Could not load|unavailable: |could not be loaded|data unavailable/;

    expect(failurePrefix.test(withoutComments(readSource(STATE_COPY)))).toBe(true);

    expect(
      report(linesMatching(otherFiles, failurePrefix, withoutComments)),
      'Failure copy belongs in dashboard/state-copy.ts, which names the surface the reader is on',
    ).toBe('');
  });

  it('never calls them active sites again, not even in a comment', () => {
    const retiredPhrase = /active site/i;

    expect(retiredPhrase.test(RETIRED_EMPTY_FLEET_LINE)).toBe(true);

    expect(
      report(linesMatching(governedFiles, retiredPhrase, verbatim)),
      'There is no inactive site to contrast with, so the word asserts a distinction the data model does not make (issue 104)',
    ).toBe('');
  });

  it('never tells the reader a bare map click adds a site, not even in a comment', () => {
    // Deliberately looser than the retired sentence: what must not come back is
    // the *instruction*, in whatever words a future panel reaches for, so the
    // pattern matches the promise rather than one spelling of it.
    const retiredInstruction = /click\w*\s+(?:anywhere\s+)?(?:on\s+)?the\s+map\s+to\s+add/i;

    expect(retiredInstruction.test(RETIRED_ADD_SITE_INSTRUCTION)).toBe(true);

    expect(
      report(linesMatching(governedFiles, retiredInstruction, verbatim)),
      'A basemap click only places a site while the map’s add-site control is armed (issue 265)',
    ).toBe('');
  });

  it('gives the empty fleet exactly one sentence', () => {
    expect(EMPTY_FLEET_MESSAGE).toContain('No sites');

    expect(
      report(linesMatching(otherFiles, /No sites/, withoutComments)),
      'The empty fleet is answered once, by EMPTY_FLEET_MESSAGE',
    ).toBe('');
  });
});
