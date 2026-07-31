import { describe, expect, it } from 'vitest';

import { attributionSchema, openMeteoAttribution } from './attribution';

const openMeteoCredit = {
  text: 'Weather data by Open-Meteo.com',
  url: 'https://open-meteo.com/',
};

describe('attributionSchema', () => {
  it('accepts a credit carrying both the wording and the link', () => {
    const result = attributionSchema.safeParse(openMeteoCredit);

    expect(result.success).toBe(true);
  });

  it('rejects an empty text — an invisible credit is not attribution', () => {
    expect(attributionSchema.safeParse({ ...openMeteoCredit, text: '' }).success).toBe(false);
  });

  it('rejects a url that is not a url, so the credit cannot ship unlinked', () => {
    expect(attributionSchema.safeParse({ ...openMeteoCredit, url: 'open-meteo' }).success).toBe(
      false,
    );
  });

  it.each(['text', 'url'])('rejects a credit missing %s', (field) => {
    const partial = Object.fromEntries(
      Object.entries(openMeteoCredit).filter(([name]) => name !== field),
    );

    expect(attributionSchema.safeParse(partial).success).toBe(false);
  });
});

describe('openMeteoAttribution', () => {
  it('parses against the schema it claims to satisfy', () => {
    expect(attributionSchema.safeParse(openMeteoAttribution).success).toBe(true);
  });

  // The wording and the link are the CC BY 4.0 obligation itself (a hard
  // constraint in CLAUDE.md), not a style choice — pinned here so a reword has
  // to be a deliberate change to a failing test rather than a quiet edit.
  it('carries the exact credit CC BY 4.0 obliges the project to display', () => {
    expect(openMeteoAttribution).toEqual(openMeteoCredit);
  });
});
