import { describe, expect, it } from 'vitest';
import { resolveInitialTheme } from './theme';

describe('resolveInitialTheme', () => {
  it('keeps a stored light choice even when the system prefers dark', () => {
    expect(resolveInitialTheme('light', true)).toBe('light');
  });

  it('keeps a stored dark choice when the system prefers light', () => {
    expect(resolveInitialTheme('dark', false)).toBe('dark');
  });

  it('honours a stored dark choice that agrees with the system', () => {
    expect(resolveInitialTheme('dark', true)).toBe('dark');
  });

  it('honours a stored light choice that agrees with the system', () => {
    expect(resolveInitialTheme('light', false)).toBe('light');
  });

  it('follows a dark system preference when nothing is stored', () => {
    expect(resolveInitialTheme(null, true)).toBe('dark');
  });

  it('falls back to light when nothing is stored and the system prefers light', () => {
    expect(resolveInitialTheme(null, false)).toBe('light');
  });

  it('ignores a stored value it does not recognise', () => {
    // Storage is shared with older builds and with anything else on the origin,
    // so an unknown value is a routine input, not a corrupted-state emergency.
    expect(resolveInitialTheme('midnight', true)).toBe('dark');
    expect(resolveInitialTheme('', false)).toBe('light');
  });
});
