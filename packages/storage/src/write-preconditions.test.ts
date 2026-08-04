import { describe, expect, it } from 'vitest';

import { requireUniqueKeys } from './write-preconditions';

/**
 * The precondition on its own, away from any adapter: what it accepts, what it
 * refuses, and what the refusal says. The adapters' own tests pin the other half
 * — that the refusal reaches the caller as a plain `Error` rather than as a
 * `StorageError` blaming the table.
 */

describe('requireUniqueKeys', () => {
  it('accepts a write whose keys are all distinct', () => {
    expect(() => {
      requireUniqueKeys('putForecasts', ['site-a|T#1', 'site-a|T#2', 'site-b|T#1']);
    }).not.toThrow();
  });

  it('accepts a write with nothing in it', () => {
    expect(() => {
      requireUniqueKeys('putForecasts', []);
    }).not.toThrow();
  });

  it('names the operation and the key two items share', () => {
    expect(() => {
      requireUniqueKeys('putGenerationReadings', ['site-a|T#1', 'site-a|T#1']);
    }).toThrow(
      'putGenerationReadings: two items share the key site-a|T#1 — the caller must de-duplicate before writing',
    );
  });

  it('names the first collision, not the last, when several keys repeat', () => {
    // The message is a pointer for whoever has to go and look: the earliest
    // collision is the one nearest the input they can still recognise.
    expect(() => {
      requireUniqueKeys('putForecastWeather', [
        '53.35,-6.26|T#1',
        '53.35,-6.26|T#2',
        '53.35,-6.26|T#2',
        '53.35,-6.26|T#1',
      ]);
    }).toThrow(/two items share the key 53\.35,-6\.26\|T#2 /);
  });
});
