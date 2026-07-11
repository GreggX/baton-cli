// T008 — Zone classification: boundary values against defaults, custom thresholds,
// and the canonical guidance table (design-notes.md "Zone guidance copy", verbatim).
import { describe, expect, it } from 'vitest';
import { DEFAULT_THRESHOLDS } from '../../src/core/config/schema.js';
import { ZONE_GUIDANCE, classifyZone } from '../../src/core/monitor/zones.js';

describe('classifyZone with default thresholds (40/60/75)', () => {
  it.each([
    [0, 'green'],
    [25, 'green'],
    [39.9, 'green'],
    [40, 'yellow'],
    [45.2, 'yellow'],
    [59.9, 'yellow'],
    [60, 'orange'],
    [68, 'orange'],
    [74.9, 'orange'],
    [75, 'red'],
    [80, 'red'],
    [100, 'red'],
  ] as const)('%s%% -> %s', (pct, zone) => {
    expect(classifyZone(pct, DEFAULT_THRESHOLDS)).toBe(zone);
  });
});

describe('classifyZone with custom thresholds', () => {
  const custom = { yellow: 10, orange: 20, red: 30 };

  it.each([
    [0, 'green'],
    [9.9, 'green'],
    [10, 'yellow'],
    [19.9, 'yellow'],
    [20, 'orange'],
    [29.9, 'orange'],
    [30, 'red'],
    [100, 'red'],
  ] as const)('%s%% -> %s', (pct, zone) => {
    expect(classifyZone(pct, custom)).toBe(zone);
  });
});

describe('canonical zone guidance table (design-notes.md, verbatim)', () => {
  it('green (recovery/de-escalation)', () => {
    expect(ZONE_GUIDANCE.green).toBe('Runway restored — keep prompting freely.');
  });

  it('yellow', () => {
    expect(ZONE_GUIDANCE.yellow).toBe('Favor targeted retrieval over pasting whole documents.');
  });

  it('orange', () => {
    expect(ZONE_GUIDANCE.orange).toBe('Review artifact candidates, then compact the conversation.');
  });

  it('red', () => {
    expect(ZONE_GUIDANCE.red).toBe('Start a fresh session from a handoff summary.');
  });
});
