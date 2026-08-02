import { describe, expect, it } from 'vitest';

import { lambdaContextDeadline } from './request-deadline';

/**
 * Every case here injects both its clock and its context, so the suite is free
 * of real timers: a deadline test that waited for time to pass would be slow
 * and flaky at once, and would prove nothing the injected clock does not.
 */

/** Reads out `readings` in order and then repeats the last one, forever. */
const readingsInOrder = (readings: readonly number[]): (() => number) => {
  const remaining = [...readings];
  let last = 0;
  return () => {
    last = remaining.shift() ?? last;
    return last;
  };
};

/**
 * A stand-in for Lambda's invocation context: an object with the one method the
 * boundary reads. A class rather than an object literal because that is the
 * shape the type guard has to cope with in production — a live method on an
 * object nobody in this repo constructed.
 */
class FakeInvocationContext {
  private readonly nextReading: () => number;

  constructor(readings: readonly number[]) {
    this.nextReading = readingsInOrder(readings);
  }

  getRemainingTimeInMillis(): number {
    return this.nextReading();
  }
}

const BUDGET_MS = 15_000;

/** A clock that must never be read: the delegating path asks the context, not the clock. */
const forbiddenClock = (): number => {
  throw new Error('the delegating deadline read a clock it should not have');
};

describe('lambdaContextDeadline with a real invocation context', () => {
  it('answers with the context’s own remaining time rather than with the budget', () => {
    // 1,234 is a number this module cannot compute from anything it was given —
    // it can only have come from the context, which is the claim being made.
    const deadline = lambdaContextDeadline(
      new FakeInvocationContext([1_234]),
      BUDGET_MS,
      forbiddenClock,
    );

    expect(deadline.remainingMs()).toBe(1_234);
  });

  it('asks again on every call, so a handler sees the time actually running out', () => {
    // The reason `remainingMs` is a function and not a number: a handler about
    // to start its third storage command needs the time left *now*.
    const deadline = lambdaContextDeadline(
      new FakeInvocationContext([9_000, 2_500, -40]),
      BUDGET_MS,
      forbiddenClock,
    );

    expect([deadline.remainingMs(), deadline.remainingMs(), deadline.remainingMs()]).toEqual([
      9_000, 2_500, -40,
    ]);
  });
});

describe('lambdaContextDeadline with no usable context', () => {
  it('counts the budget down against the injected clock', () => {
    // Constructed at 1,000, then asked at 1,000, 4,000 and 17,000.
    const deadline = lambdaContextDeadline(
      undefined,
      BUDGET_MS,
      readingsInOrder([1_000, 1_000, 4_000, 17_000]),
    );

    expect(deadline.remainingMs()).toBe(BUDGET_MS);
    expect(deadline.remainingMs()).toBe(12_000);
    // Overdraft is reported rather than clamped: "none left" and "a second over"
    // are different facts, and the predicate that consumes them compares.
    expect(deadline.remainingMs()).toBe(-1_000);
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a string', 'not a context'],
    ['an empty object', {}],
    ['an object whose getRemainingTimeInMillis is a number', { getRemainingTimeInMillis: 5_000 }],
  ])('falls back to the countdown rather than trusting %s', (_label, context: unknown) => {
    // The last row is the case a bare `typeof context === 'object'` check would
    // let through, and calling that property would be a TypeError at the
    // boundary — a 500 on a request that was healthy.
    const deadline = lambdaContextDeadline(context, BUDGET_MS, readingsInOrder([500]));

    expect(deadline.remainingMs()).toBe(BUDGET_MS);
  });

  it('reads the clock once at construction, so the countdown starts when the request did', () => {
    // Constructed at 100; every later reading is 2,100. A deadline that re-read
    // its start time on each call would answer the full budget forever.
    const deadline = lambdaContextDeadline(undefined, BUDGET_MS, readingsInOrder([100, 2_100]));

    expect(deadline.remainingMs()).toBe(13_000);
    expect(deadline.remainingMs()).toBe(13_000);
  });
});
