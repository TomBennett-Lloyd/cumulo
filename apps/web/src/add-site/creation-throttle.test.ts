import { describe, expect, it } from 'vitest';

import {
  CreationThrottle,
  DEFAULT_CREATION_LIMIT,
  DEFAULT_CREATION_WINDOW_MS,
  type CreationDecision,
} from './creation-throttle';

/** A mutable instant the tests move by hand — the throttle never sleeps. */
interface MutableClock {
  ms: number;
}

/**
 * The reader half of {@link MutableClock}, taking the clock as a parameter
 * rather than closing over one from the enclosing test (`structure.md` rule 1).
 */
const clockReader =
  (clock: MutableClock): (() => number) =>
  () =>
    clock.ms;

const START_MS = Date.UTC(2026, 6, 31, 9, 0, 0);
const SECOND_MS = 1000;

/**
 * Spends the whole default allowance one second apart, returning the decision
 * each creation was given. The clock is left on the second after the last one.
 *
 * Every test below starts from a full window, and each one then asks a
 * different question of it — so the shared setup is extracted and nothing else
 * is (`structure.md` rule 7).
 */
const fillTheWindow = (
  throttle: CreationThrottle,
  clock: MutableClock,
): readonly CreationDecision[] =>
  Array.from({ length: DEFAULT_CREATION_LIMIT }, () => {
    const decision = throttle.check();
    throttle.record();
    clock.ms += SECOND_MS;
    return decision;
  });

describe('CreationThrottle', () => {
  it('allows the whole default allowance inside one window', () => {
    const clock: MutableClock = { ms: START_MS };
    const throttle = new CreationThrottle({ now: clockReader(clock) });

    const decisions = fillTheWindow(throttle, clock);

    expect(decisions).toEqual([{ kind: 'allowed' }, { kind: 'allowed' }, { kind: 'allowed' }]);
  });

  it('refuses the creation past the limit and says how long to wait', () => {
    const clock: MutableClock = { ms: START_MS };
    const throttle = new CreationThrottle({ now: clockReader(clock) });

    fillTheWindow(throttle, clock);

    // The clock now sits 3s past the first creation, so that creation ages out
    // 57s from here — the wait is until the *oldest* expires, not a full window.
    expect(throttle.check()).toEqual({ kind: 'refused', retryAfterSeconds: 57 });
  });

  it('never quotes a wait of zero seconds', () => {
    const clock: MutableClock = { ms: START_MS };
    const throttle = new CreationThrottle({ now: clockReader(clock) });

    fillTheWindow(throttle, clock);
    // Half a second before the oldest creation ages out.
    clock.ms = START_MS + DEFAULT_CREATION_WINDOW_MS - 500;

    // Rounded up, not down: "wait 0s" would read as "go ahead" while the check
    // still refuses.
    expect(throttle.check()).toEqual({ kind: 'refused', retryAfterSeconds: 1 });
  });

  it('allows another creation once the oldest one slides out of the window', () => {
    const clock: MutableClock = { ms: START_MS };
    const throttle = new CreationThrottle({ now: clockReader(clock) });

    fillTheWindow(throttle, clock);
    clock.ms = START_MS + DEFAULT_CREATION_WINDOW_MS;

    expect(throttle.check()).toEqual({ kind: 'allowed' });
  });

  it('frees one slot at a time — the window slides, it does not reset in blocks', () => {
    const clock: MutableClock = { ms: START_MS };
    const throttle = new CreationThrottle({ now: clockReader(clock) });

    fillTheWindow(throttle, clock);
    // The first creation has just aged out; the second and third have not.
    clock.ms = START_MS + DEFAULT_CREATION_WINDOW_MS;
    throttle.record();

    // Taking the freed slot puts the visitor straight back at the limit,
    // waiting on the second creation (recorded 1s after the first).
    expect(throttle.check()).toEqual({ kind: 'refused', retryAfterSeconds: 1 });
  });

  it('does not spend the allowance just by being asked', () => {
    const clock: MutableClock = { ms: START_MS };
    const throttle = new CreationThrottle({ now: clockReader(clock) });

    // A form that re-renders asks repeatedly; asking must not push the visitor
    // further back than recording would.
    expect(throttle.check()).toEqual({ kind: 'allowed' });
    expect(throttle.check()).toEqual({ kind: 'allowed' });
    expect(throttle.check()).toEqual({ kind: 'allowed' });
    throttle.record();
    clock.ms = START_MS + DEFAULT_CREATION_WINDOW_MS - SECOND_MS;

    // Only the one recorded creation counts, so two of the three slots are free.
    expect(throttle.check()).toEqual({ kind: 'allowed' });
  });

  /*
   * `testing.md` rule 7: every test above injects a clock, which is a knob —
   * so one test runs the throttle exactly as the app constructs it, with no
   * options at all. It reads the real `Date.now` and still finishes in
   * microseconds, because refusing is a decision rather than a wait.
   */
  it('paces creation at three a minute with no options supplied at all', () => {
    const throttle = new CreationThrottle();

    expect(throttle.check()).toEqual({ kind: 'allowed' });
    throttle.record();
    expect(throttle.check()).toEqual({ kind: 'allowed' });
    throttle.record();
    expect(throttle.check()).toEqual({ kind: 'allowed' });
    throttle.record();

    // All three landed within a millisecond or two of each other, so the wait
    // rounds up to the full default window.
    expect(throttle.check()).toEqual({ kind: 'refused', retryAfterSeconds: 60 });
  });

  it('refuses to be built in a configuration that could never permit anything', () => {
    expect(() => new CreationThrottle({ limit: 0 })).toThrow(/at least 1/);
    expect(() => new CreationThrottle({ windowMs: 0 })).toThrow(/positive window/);
  });
});
