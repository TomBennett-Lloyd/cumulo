import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/*
 * Which ports this checkout's servers bind — the one owner, read by
 * `vite.config.ts` (the dev and preview servers) and by
 * `e2e/playwright.config.ts` (the server command, the readiness probe and
 * `baseURL`).
 *
 * The problem it solves: every worktree serves *its own* build, so two browser
 * sessions from two worktrees are independent work — but while every one of
 * them bound 4173, they contended for a port and had to be run one at a time.
 * That queue was the only thing serialising them, and #459 records a lane
 * waiting on an unrelated lane's browser work for exactly that reason.
 * Hand-picking a port per session (4199 was the recurring ad-hoc choice) fixes
 * one session and nothing after it, because the next author has no way to know
 * which numbers are spoken for.
 *
 * So the port is *derived* from which tree is being served, and nobody picks
 * one. Same tree, same ports, every run — a session can be described by its
 * worktree alone, and a stray server found on a lane port is identifiable
 * rather than anonymous.
 */

/**
 * How many lanes the derivation spreads worktrees across.
 *
 * 512 is a probability, not a guarantee: distinct worktrees can hash to one
 * lane, and at four concurrent trees the chance that some pair collides is
 * around 1%. That residual is affordable only because of what a collision does
 * — every server here binds with `--strictPort`, so the second one fails
 * loudly on startup instead of hopping to the next free port (vite's default)
 * or adopting the neighbour's server. The failure mode is a red run with an
 * `EADDRINUSE`, never a measurement taken against another tree's build. A
 * registry file would remove the residual and add state to keep clean across
 * killed sessions; a pure function of the path has neither.
 */
export const LANE_COUNT = 512;

/**
 * How far a lane block sits above the base port it derives from.
 *
 * The blocks are deliberately nowhere near 4173/5173: a server answering on a
 * base port is the primary checkout's and a server on a lane port is some
 * worktree's, with no arithmetic needed to tell which. 20,000 also keeps every
 * lane port below 32768 — the bottom of Linux's default ephemeral range, and
 * far below macOS's 49152 — so the kernel can never hand a lane's number out
 * to an unrelated outbound socket while a session is between servers.
 */
export const LANE_BLOCK_OFFSET = 20_000;

/**
 * Vite's own preview default, kept exactly for the primary checkout so CI —
 * which checks out a plain clone, not a worktree — binds the same port it
 * always has.
 */
export const PREVIEW_BASE_PORT = 4173;

/**
 * Vite's own dev-server default, kept for the primary checkout for the same
 * reason, and additionally because `.claude/launch.json` names 5173 for the
 * `web` configuration it starts against the main checkout.
 */
export const DEV_SERVER_BASE_PORT = 5173;

/**
 * The lane a given identity falls in.
 *
 * SHA-256 rather than a hand-rolled FNV/djb2: the property wanted is that the
 * mapping never moves, and delegating that to a specified digest makes it a
 * fact about the algorithm rather than about arithmetic somebody has to keep
 * right. Only the first four bytes are read — the lane is nine bits, so the
 * rest is spare.
 */
const laneOf = (identity: string): number =>
  createHash('sha256').update(identity).digest().readUInt32BE(0) % LANE_COUNT;

/**
 * What a `.git` entry is: a directory in a primary checkout, a file (holding a
 * `gitdir:` pointer) in a linked worktree, or absent at this level of the walk.
 *
 * `throwIfNoEntry: false` rather than a `try`/`catch`: absence is the expected
 * outcome at every level above the checkout root, so it comes back as a value
 * (`error-handling.md` rule 1) — and a `catch` here would have swallowed the
 * failures that are *not* expected, an unreadable parent directory among them,
 * turning "I may not look" into "nothing is there" (rule 2).
 */
const gitEntryKind = (path: string): 'directory' | 'file' | 'absent' => {
  const stats = statSync(path, { throwIfNoEntry: false });

  if (stats === undefined) return 'absent';
  return stats.isDirectory() ? 'directory' : 'file';
};

/**
 * The identity of the checkout containing `fromDir` — its absolute root path
 * when that checkout is a linked worktree, and `null` when it is not.
 *
 * `null` is the primary checkout, and it is what keeps CI byte-for-byte
 * unchanged: `actions/checkout` produces a clone whose `.git` is a directory,
 * so the runner derives nothing and binds the base ports. The same holds for
 * this repo's parked main checkout, which is read-only for task work anyway.
 *
 * The primary/linked test is git's own on-disk distinction rather than a path
 * convention: a linked worktree's `.git` is a *file* holding a `gitdir:`
 * pointer, a primary checkout's is a directory. Keying off `.claude/worktrees/`
 * in the path would have been shorter and would silently stop working for a
 * worktree created anywhere else.
 *
 * A tree with no `.git` above it at all — an export, a tarball — also answers
 * `null`. There is no lane to derive there, and the base ports are the
 * behaviour that surprises nobody.
 */
export const laneIdentity = (fromDir: string): string | null => {
  let candidate = resolve(fromDir);

  for (;;) {
    switch (gitEntryKind(join(candidate, '.git'))) {
      case 'directory':
        return null;
      case 'file':
        return candidate;
      case 'absent':
        break;
    }

    const parent = dirname(candidate);
    if (parent === candidate) return null;
    candidate = parent;
  }
};

/**
 * The port `basePort`'s server binds for the checkout identified by
 * `identity` — the base itself for the primary checkout, or its lane's port.
 *
 * Pure, and separate from `laneIdentity` above, so the arithmetic can be
 * asserted against identities that are just strings rather than against
 * whatever worktrees happen to exist on the machine running the suite.
 */
export const lanePort = (basePort: number, identity: string | null): number =>
  identity === null ? basePort : basePort + LANE_BLOCK_OFFSET + laneOf(identity);

/**
 * This checkout, identified by where this very file sits.
 *
 * The module is inside the tree whose servers it is naming ports for, so its
 * own location is the identity — no caller has to supply one, and none can
 * supply the wrong one. Resolved once at load: the walk is a few `statSync`
 * calls, and a constant is what lets the two exports below be values rather
 * than functions every consumer must remember to call.
 */
const CHECKOUT_IDENTITY = laneIdentity(fileURLToPath(new URL('.', import.meta.url)));

/**
 * The port `vite preview` binds here: 4173 in a primary checkout, somewhere in
 * 24173–24684 in a worktree.
 */
export const PREVIEW_PORT = lanePort(PREVIEW_BASE_PORT, CHECKOUT_IDENTITY);

/**
 * The port `vite` (the dev server) binds here: 5173 in a primary checkout,
 * somewhere in 25173–25684 in a worktree.
 *
 * A whole block clear of the preview lanes, which matters inside a single
 * worktree: a dev server left running is not allowed to be the reason that
 * tree's e2e lane cannot start, or vice versa.
 */
export const DEV_SERVER_PORT = lanePort(DEV_SERVER_BASE_PORT, CHECKOUT_IDENTITY);
