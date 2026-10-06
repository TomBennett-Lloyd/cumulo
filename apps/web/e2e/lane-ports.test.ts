import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  BASE_PATH_PREVIEW_BASE_PORT,
  BASE_PATH_PREVIEW_PORT,
  DEV_SERVER_BASE_PORT,
  DEV_SERVER_PORT,
  LANE_BLOCK_OFFSET,
  LANE_COUNT,
  PREVIEW_BASE_PORT,
  PREVIEW_PORT,
  laneIdentity,
  lanePort,
} from './lane-ports';

/*
 * `lane-ports.ts` is what stops two worktrees' browser sessions contending for
 * one port, so the properties asserted here are the ones the concurrency claim
 * rests on: the same tree always lands on the same port, a worktree never lands
 * on the base port CI binds, no two servers' blocks land on each other, and the
 * numbers stay inside a range the kernel will not hand to somebody else.
 *
 * This is a `.test.ts` in `e2e/` and therefore vitest's, not the browser lane's
 * (`testing.md` rule 10's naming split). It lives beside the module rather than
 * under `src/` because the module is Node-side config code that `src/` must
 * never import, and it is pure arithmetic over strings plus one `statSync`
 * walk — nothing here wants a browser, and paying for a production build to
 * assert a hash would be absurd.
 */

/**
 * Distinct enough to be a real sample, and shaped like what this repo actually
 * produces: `.claude/worktrees/<issue>-<slug>` under the main checkout.
 */
const worktreePaths = [
  '/Users/tom/Documents/Repos/cumulo/.claude/worktrees/459-e2e-ports',
  '/Users/tom/Documents/Repos/cumulo/.claude/worktrees/455-chart-tap',
  '/Users/tom/Documents/Repos/cumulo/.claude/worktrees/296-fleet-forecast',
  '/Users/tom/Documents/Repos/cumulo/.claude/worktrees/284-chart-width',
  '/Users/tom/Documents/Repos/cumulo/.claude/worktrees/336-orchestrator',
  '/Users/tom/Documents/Repos/cumulo/.claude/worktrees/468-lane-shape',
  '/home/runner/work/cumulo/cumulo/.claude/worktrees/459-e2e-ports',
  '/Users/someone-else/code/cumulo-fork',
];

/** A throwaway directory, unique per call, that no test cleans up after. */
const scratchDir = (): string => mkdtempSync(join(tmpdir(), 'lane-ports-'));

/**
 * Every base port the derivation is applied to — one per server this repo
 * starts. The block properties below iterate it rather than naming two of the
 * three, so a base port added to `lane-ports.ts` is admitted to all of them by
 * being added here once.
 */
const serverBasePorts = [PREVIEW_BASE_PORT, DEV_SERVER_BASE_PORT, BASE_PATH_PREVIEW_BASE_PORT];

describe('lanePort', () => {
  it('binds the base port unchanged when the checkout is not a worktree', () => {
    expect(lanePort(PREVIEW_BASE_PORT, null)).toBe(4173);
    expect(lanePort(DEV_SERVER_BASE_PORT, null)).toBe(5173);
    expect(lanePort(BASE_PATH_PREVIEW_BASE_PORT, null)).toBe(6173);
  });

  it('derives the same port every time from the same identity', () => {
    const identity = worktreePaths[0] ?? '';

    const first = lanePort(PREVIEW_BASE_PORT, identity);
    const second = lanePort(PREVIEW_BASE_PORT, identity);

    expect(second).toBe(first);
  });

  /*
   * Pinned values, not a recomputation of the formula. A test that derived its
   * expectation the same way the code does would pass through any change to the
   * digest or the lane count — and "the port a given worktree binds does not
   * move between runs" is exactly the property a session relies on when it
   * kills a stray server it believes is its own.
   */
  it('derives a port that does not move between releases', () => {
    expect(lanePort(PREVIEW_BASE_PORT, '/repos/cumulo/.claude/worktrees/a')).toBe(24_649);
    expect(lanePort(DEV_SERVER_BASE_PORT, '/repos/cumulo/.claude/worktrees/a')).toBe(25_649);
    expect(lanePort(BASE_PATH_PREVIEW_BASE_PORT, '/repos/cumulo/.claude/worktrees/a')).toBe(26_649);
    expect(lanePort(PREVIEW_BASE_PORT, '/repos/cumulo/.claude/worktrees/b')).toBe(24_295);
  });

  it('lands every identity inside its base port’s lane block', () => {
    for (const base of serverBasePorts) {
      for (const path of worktreePaths) {
        const port = lanePort(base, path);

        expect(port).toBeGreaterThanOrEqual(base + LANE_BLOCK_OFFSET);
        expect(port).toBeLessThan(base + LANE_BLOCK_OFFSET + LANE_COUNT);
      }
    }
  });

  /*
   * Both ends matter and for different reasons: below 1024 needs root to bind,
   * and 32768 is the bottom of Linux's default ephemeral range (macOS starts at
   * 49152), so a lane port at or above it could be handed to an unrelated
   * outbound socket while a session is between servers.
   */
  it('keeps every lane port out of the privileged and ephemeral ranges', () => {
    for (const base of serverBasePorts) {
      const highest = base + LANE_BLOCK_OFFSET + LANE_COUNT - 1;

      expect(base + LANE_BLOCK_OFFSET).toBeGreaterThan(1024);
      expect(highest).toBeLessThan(32_768);
    }
  });

  /*
   * The pigeonhole says two identities *can* share a lane; what must not happen
   * is a collision among the trees this repo really opens at once. If a future
   * naming convention breaks this, the fix is a wider `LANE_COUNT`, not a
   * quieter test.
   */
  it('gives a realistic set of concurrent worktrees distinct ports', () => {
    const ports = worktreePaths.map((path) => lanePort(PREVIEW_BASE_PORT, path));

    expect(new Set(ports).size).toBe(worktreePaths.length);
  });

  it('never lets a worktree land on the base port a plain checkout binds', () => {
    for (const base of serverBasePorts) {
      for (const path of worktreePaths) {
        expect(lanePort(base, path)).not.toBe(base);
      }
    }
  });

  /*
   * The property that lets one worktree run a dev server, its e2e lane and that
   * lane's second preview at the same time — the last two concurrently within a
   * single run. Asserted over whole blocks rather than over the sample above,
   * because it is arithmetic about the bases and not about any identity: no
   * identity can collide across servers if the ranges cannot.
   */
  it('keeps every server’s lane block clear of every other’s', () => {
    const blocks = serverBasePorts.map((base) => ({
      base,
      lowest: base + LANE_BLOCK_OFFSET,
      highest: base + LANE_BLOCK_OFFSET + LANE_COUNT - 1,
    }));

    for (const [index, block] of blocks.entries()) {
      for (const other of blocks.slice(index + 1)) {
        expect(
          block.highest < other.lowest || other.highest < block.lowest,
          `The lane blocks for base ports ${String(block.base)} and ${String(other.base)} overlap.`,
        ).toBe(true);
      }
    }
  });
});

describe('laneIdentity', () => {
  it('reads a `.git` directory as the primary checkout', () => {
    const root = scratchDir();
    mkdirSync(join(root, '.git'));

    expect(laneIdentity(root)).toBeNull();
  });

  it('reads a `.git` gitfile as a linked worktree, and answers with its root', () => {
    const root = scratchDir();
    writeFileSync(join(root, '.git'), 'gitdir: /elsewhere/.git/worktrees/scratch\n');

    expect(laneIdentity(root)).toBe(root);
  });

  it('walks up to the nearest enclosing checkout', () => {
    const root = scratchDir();
    writeFileSync(join(root, '.git'), 'gitdir: /elsewhere/.git/worktrees/scratch\n');
    const nested = join(root, 'apps', 'web', 'e2e');
    mkdirSync(nested, { recursive: true });

    expect(laneIdentity(nested)).toBe(root);
  });

  /*
   * The inner checkout wins, which is what makes a worktree nested under the
   * main checkout — where this repo puts every one of them — derive a lane
   * rather than inherit the parent's `null`.
   */
  it('stops at the innermost checkout rather than the outermost', () => {
    const outer = scratchDir();
    mkdirSync(join(outer, '.git'));
    const inner = join(outer, '.claude', 'worktrees', 'scratch');
    mkdirSync(inner, { recursive: true });
    writeFileSync(join(inner, '.git'), 'gitdir: /elsewhere\n');

    expect(laneIdentity(inner)).toBe(inner);
  });

  it('answers with the primary checkout’s behaviour when there is no checkout at all', () => {
    expect(laneIdentity(scratchDir())).toBeNull();
  });
});

/*
 * The one case that runs against whatever tree is executing it, and so asserts
 * the same thing in both places it matters: on CI (a plain clone, where the
 * answer must be the historical default) and in a worktree (where it must be a
 * lane). Written as a disjunction because those are genuinely different
 * environments, not because either answer is unknown.
 */
describe('the ports this checkout binds', () => {
  it('are either the plain defaults or a lane, and never a third thing', () => {
    const inLaneBlock = (port: number, base: number): boolean =>
      port >= base + LANE_BLOCK_OFFSET && port < base + LANE_BLOCK_OFFSET + LANE_COUNT;

    const bound: readonly [number, number][] = [
      [PREVIEW_PORT, PREVIEW_BASE_PORT],
      [DEV_SERVER_PORT, DEV_SERVER_BASE_PORT],
      [BASE_PATH_PREVIEW_PORT, BASE_PATH_PREVIEW_BASE_PORT],
    ];

    const isDefault = PREVIEW_PORT === PREVIEW_BASE_PORT;

    for (const [port, base] of bound) {
      expect(port === base || inLaneBlock(port, base)).toBe(true);

      // All three move together or not at all: one default and one lane would
      // mean the identity was resolved more than once and disagreed with
      // itself.
      expect(port === base).toBe(isDefault);
    }
  });
});
