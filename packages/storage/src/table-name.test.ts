import { describe, expect, it } from 'vitest';

import { storageTableName } from './table-name';

describe('storageTableName', () => {
  it('matches the physical names the Terraform storage stack creates', () => {
    expect(storageTableName('sites', 'dev')).toBe('cumulo-sites-dev');
    expect(storageTableName('series', 'dev')).toBe('cumulo-series-dev');
    expect(storageTableName('weather', 'dev')).toBe('cumulo-weather-dev');
    expect(storageTableName('metrics', 'dev')).toBe('cumulo-metrics-dev');
  });

  it('carries the environment through unchanged', () => {
    expect(storageTableName('series', 'prod')).toBe('cumulo-series-prod');
    expect(storageTableName('series', 'pr-123')).toBe('cumulo-series-pr-123');
  });

  it('refuses an environment the Terraform variable would also refuse', () => {
    expect(() => storageTableName('sites', 'Dev')).toThrow(/environment/);
    expect(() => storageTableName('sites', 'my_env')).toThrow(/environment/);
    expect(() => storageTableName('sites', '')).toThrow(/environment/);
    expect(() => storageTableName('sites', 'dev prod')).toThrow(/environment/);
  });
});
