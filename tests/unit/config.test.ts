// T007 — Threshold config: defaults 40/60/75, ordering refinement 0 < yellow < orange < red <= 100,
// named error per violated key/rule, fallback-to-defaults behavior (FR-003).
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/core/config/loader.js';
import { DEFAULT_THRESHOLDS, validateThresholds } from '../../src/core/config/schema.js';

const DEFAULTS = { yellow: 40, orange: 60, red: 75 };

describe('threshold defaults', () => {
  it('defaults are 40/60/75 (constitution Operational Constraints)', () => {
    expect(DEFAULT_THRESHOLDS).toEqual(DEFAULTS);
  });

  it('missing input yields defaults with no errors', () => {
    const result = validateThresholds(undefined);
    expect(result.thresholds).toEqual(DEFAULTS);
    expect(result.errors).toEqual([]);
  });

  it('empty object yields defaults with no errors', () => {
    const result = validateThresholds({});
    expect(result.thresholds).toEqual(DEFAULTS);
    expect(result.errors).toEqual([]);
  });

  it('partial input fills remaining keys from defaults', () => {
    const result = validateThresholds({ yellow: 30 });
    expect(result.thresholds).toEqual({ yellow: 30, orange: 60, red: 75 });
    expect(result.errors).toEqual([]);
  });
});

describe('ordering refinement 0 < yellow < orange < red <= 100 (FR-003)', () => {
  it('accepts valid custom thresholds', () => {
    const result = validateThresholds({ yellow: 50, orange: 70, red: 90 });
    expect(result.thresholds).toEqual({ yellow: 50, orange: 70, red: 90 });
    expect(result.errors).toEqual([]);
  });

  it('accepts red exactly 100', () => {
    const result = validateThresholds({ yellow: 40, orange: 60, red: 100 });
    expect(result.errors).toEqual([]);
    expect(result.thresholds.red).toBe(100);
  });

  it('rejects yellow <= 0 with named key and rule, falling back to defaults', () => {
    const result = validateThresholds({ yellow: 0, orange: 60, red: 75 });
    expect(result.errors).toEqual([
      { key: 'thresholds.yellow', value: 0, rule: 'must be greater than 0' },
    ]);
    expect(result.thresholds).toEqual(DEFAULTS);
  });

  it('rejects orange <= yellow, naming the offending key and the rule with the yellow value', () => {
    const result = validateThresholds({ yellow: 40, orange: 30, red: 75 });
    expect(result.errors).toEqual([
      { key: 'thresholds.orange', value: 30, rule: 'must be greater than thresholds.yellow (40)' },
    ]);
    expect(result.thresholds).toEqual(DEFAULTS);
  });

  it('rejects equal boundaries (strict ordering)', () => {
    const result = validateThresholds({ yellow: 60, orange: 60, red: 75 });
    expect(result.errors).toEqual([
      { key: 'thresholds.orange', value: 60, rule: 'must be greater than thresholds.yellow (60)' },
    ]);
    expect(result.thresholds).toEqual(DEFAULTS);
  });

  it('rejects red <= orange, naming the offending key and the rule with the orange value', () => {
    const result = validateThresholds({ yellow: 40, orange: 60, red: 50 });
    expect(result.errors).toEqual([
      { key: 'thresholds.red', value: 50, rule: 'must be greater than thresholds.orange (60)' },
    ]);
    expect(result.thresholds).toEqual(DEFAULTS);
  });

  it('rejects red > 100', () => {
    const result = validateThresholds({ yellow: 40, orange: 60, red: 101 });
    expect(result.errors).toEqual([
      { key: 'thresholds.red', value: 101, rule: 'must be at most 100' },
    ]);
    expect(result.thresholds).toEqual(DEFAULTS);
  });

  it('reports one named error per violated key', () => {
    const result = validateThresholds({ yellow: 80, orange: 60, red: 50 });
    expect(result.errors).toEqual([
      { key: 'thresholds.orange', value: 60, rule: 'must be greater than thresholds.yellow (80)' },
      { key: 'thresholds.red', value: 50, rule: 'must be greater than thresholds.orange (60)' },
    ]);
    expect(result.thresholds).toEqual(DEFAULTS);
  });

  it('rejects non-numeric values with a named type rule', () => {
    const result = validateThresholds({ yellow: '40', orange: 60, red: 75 });
    expect(result.errors).toEqual([
      { key: 'thresholds.yellow', value: '40', rule: 'must be a number' },
    ]);
    expect(result.thresholds).toEqual(DEFAULTS);
  });

  it('rejects a non-object thresholds value', () => {
    const result = validateThresholds('high');
    expect(result.errors).toEqual([{ key: 'thresholds', value: 'high', rule: 'must be an object' }]);
    expect(result.thresholds).toEqual(DEFAULTS);
  });
});

describe('config loader (baton.config.json)', () => {
  const tempDirs: string[] = [];

  function makeWorkspace(config?: unknown): string {
    const dir = mkdtempSync(join(tmpdir(), 'baton-config-test-'));
    tempDirs.push(dir);
    if (config !== undefined) {
      writeFileSync(
        join(dir, 'baton.config.json'),
        typeof config === 'string' ? config : JSON.stringify(config),
      );
    }
    return dir;
  }

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('absent file yields defaults with source "defaults" and no errors', () => {
    const result = loadConfig(makeWorkspace());
    expect(result).toEqual({ thresholds: DEFAULTS, source: 'defaults', errors: [] });
  });

  it('valid file yields file thresholds with source "file"', () => {
    const result = loadConfig(makeWorkspace({ thresholds: { yellow: 20, orange: 50, red: 80 } }));
    expect(result).toEqual({
      thresholds: { yellow: 20, orange: 50, red: 80 },
      source: 'file',
      errors: [],
    });
  });

  it('file without a thresholds key yields defaults with source "defaults"', () => {
    const result = loadConfig(makeWorkspace({}));
    expect(result).toEqual({ thresholds: DEFAULTS, source: 'defaults', errors: [] });
  });

  it('invalid thresholds fall back to defaults, keep running, and name each violation', () => {
    const result = loadConfig(makeWorkspace({ thresholds: { yellow: 65, orange: 60, red: 75 } }));
    expect(result.thresholds).toEqual(DEFAULTS);
    expect(result.source).toBe('defaults');
    expect(result.errors).toEqual([
      { key: 'thresholds.orange', value: 60, rule: 'must be greater than thresholds.yellow (65)' },
    ]);
  });

  it('malformed JSON falls back to defaults with a named parse error', () => {
    const result = loadConfig(makeWorkspace('{ not json'));
    expect(result.thresholds).toEqual(DEFAULTS);
    expect(result.source).toBe('defaults');
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.key).toBe('baton.config.json');
    expect(result.errors[0]?.rule).toBe('must be valid JSON');
  });

  it('non-object JSON root falls back to defaults with a named error', () => {
    const result = loadConfig(makeWorkspace('42'));
    expect(result.thresholds).toEqual(DEFAULTS);
    expect(result.source).toBe('defaults');
    expect(result.errors).toEqual([
      { key: 'baton.config.json', value: 42, rule: 'must be a JSON object' },
    ]);
  });
});
