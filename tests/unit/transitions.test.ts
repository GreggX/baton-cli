// T030 — Transition detection (US2, FR-005): boundary crossings both directions,
// multi-band collapse to the final zone only, unknown→zone, restart continuity from
// a persisted lastZone, and the explainable crossing copy (design-notes 2a/2b:
// "crossed 40% & 60% · now 68%", "compaction 78% → 30%").
import { describe, expect, it } from 'vitest';
import { DEFAULT_THRESHOLDS } from '../../src/core/config/schema.js';
import {
  crossedThresholds,
  crossingSummary,
  detectTransition,
  lastTransitionFromHistory,
  transitionSubtitle,
} from '../../src/core/monitor/transitions.js';
import type { UsageReading } from '../../src/core/monitor/types.js';

function reading(pct: number, timestamp = '2026-07-02T18:00:00.000Z'): UsageReading {
  return {
    sessionId: 's-transitions',
    tokensUsed: Math.round(pct * 2000),
    contextWindow: 200_000,
    pct,
    precision: 'exact',
    timestamp,
  };
}

describe('detectTransition with default thresholds (40/60/75)', () => {
  it('returns null while the zone is unchanged', () => {
    expect(detectTransition('green', reading(25), DEFAULT_THRESHOLDS)).toBeNull();
    expect(detectTransition('green', reading(39.9), DEFAULT_THRESHOLDS)).toBeNull();
    expect(detectTransition('yellow', reading(59.9), DEFAULT_THRESHOLDS)).toBeNull();
    expect(detectTransition('red', reading(100), DEFAULT_THRESHOLDS)).toBeNull();
  });

  it('escalation when a boundary is crossed upward', () => {
    const transition = detectTransition('green', reading(40), DEFAULT_THRESHOLDS);
    expect(transition).not.toBeNull();
    expect(transition?.from).toBe('green');
    expect(transition?.to).toBe('yellow');
    expect(transition?.direction).toBe('escalation');
    expect(transition?.sessionId).toBe('s-transitions');
    expect(transition?.reading.pct).toBe(40);
  });

  it('de-escalation when usage drops across a boundary', () => {
    const transition = detectTransition('orange', reading(30), DEFAULT_THRESHOLDS);
    expect(transition?.from).toBe('orange');
    expect(transition?.to).toBe('green');
    expect(transition?.direction).toBe('de-escalation');
  });

  it('multi-band jump collapses to ONE transition naming the FINAL zone only (FR-005)', () => {
    const transition = detectTransition('green', reading(68), DEFAULT_THRESHOLDS);
    expect(transition?.from).toBe('green'); // no intermediate yellow transition exists
    expect(transition?.to).toBe('orange');
    expect(transition?.direction).toBe('escalation');
  });

  it('unknown → zone produces a transition from "unknown" (first classification)', () => {
    const transition = detectTransition('unknown', reading(45.2), DEFAULT_THRESHOLDS);
    expect(transition?.from).toBe('unknown');
    expect(transition?.to).toBe('yellow');
    expect(transition?.direction).toBe('escalation');
  });

  it('restart continuity: a persisted lastZone equal to the reading zone stays silent', () => {
    expect(detectTransition('orange', reading(68), DEFAULT_THRESHOLDS)).toBeNull();
  });

  it('restart continuity: a persisted lastZone still detects the next crossing', () => {
    const transition = detectTransition('orange', reading(80), DEFAULT_THRESHOLDS);
    expect(transition?.from).toBe('orange');
    expect(transition?.to).toBe('red');
    expect(transition?.direction).toBe('escalation');
  });

  it('respects custom thresholds', () => {
    const custom = { yellow: 10, orange: 20, red: 30 };
    const transition = detectTransition('green', reading(15), custom);
    expect(transition?.to).toBe('yellow');
    expect(detectTransition('yellow', reading(15), custom)).toBeNull();
  });
});

describe('crossedThresholds names every boundary crossed', () => {
  it('multi-band escalations name every threshold crossed, ascending', () => {
    expect(crossedThresholds('green', 'orange', DEFAULT_THRESHOLDS)).toEqual([40, 60]);
    expect(crossedThresholds('green', 'red', DEFAULT_THRESHOLDS)).toEqual([40, 60, 75]);
    expect(crossedThresholds('yellow', 'orange', DEFAULT_THRESHOLDS)).toEqual([60]);
    expect(crossedThresholds('orange', 'red', DEFAULT_THRESHOLDS)).toEqual([75]);
  });

  it('treats unknown as below green', () => {
    expect(crossedThresholds('unknown', 'orange', DEFAULT_THRESHOLDS)).toEqual([40, 60]);
    expect(crossedThresholds('unknown', 'green', DEFAULT_THRESHOLDS)).toEqual([]);
  });

  it('lists the thresholds crossed downward on de-escalation', () => {
    expect(crossedThresholds('red', 'yellow', DEFAULT_THRESHOLDS)).toEqual([60, 75]);
    expect(crossedThresholds('orange', 'green', DEFAULT_THRESHOLDS)).toEqual([40, 60]);
  });
});

describe('transition copy (design-notes verbatim formats)', () => {
  it('multi-band escalation subtitle names every threshold crossed', () => {
    const transition = detectTransition('green', reading(68), DEFAULT_THRESHOLDS);
    if (transition === null) throw new Error('expected transition');
    expect(transitionSubtitle(transition, DEFAULT_THRESHOLDS, 35)).toBe(
      'crossed 40% & 60% · now 68%',
    );
  });

  it('single-boundary escalation subtitle', () => {
    const transition = detectTransition('green', reading(45.2), DEFAULT_THRESHOLDS);
    if (transition === null) throw new Error('expected transition');
    expect(transitionSubtitle(transition, DEFAULT_THRESHOLDS, 35)).toBe('crossed 40% · now 45%');
  });

  it('de-escalation subtitle uses the compaction drop format', () => {
    const transition = detectTransition('orange', reading(30), DEFAULT_THRESHOLDS);
    if (transition === null) throw new Error('expected transition');
    expect(transitionSubtitle(transition, DEFAULT_THRESHOLDS, 78)).toBe('compaction 78% → 30%');
    expect(crossingSummary(transition, DEFAULT_THRESHOLDS, 78)).toBe('compaction 78% → 30%');
  });

  it('event-log style summary names the crossed thresholds only', () => {
    const transition = detectTransition('green', reading(43), DEFAULT_THRESHOLDS);
    if (transition === null) throw new Error('expected transition');
    expect(crossingSummary(transition, DEFAULT_THRESHOLDS, 35)).toBe('crossed 40%');
  });

  it('first classification from unknown into green has no crossings', () => {
    const transition = detectTransition('unknown', reading(25), DEFAULT_THRESHOLDS);
    if (transition === null) throw new Error('expected transition');
    expect(crossingSummary(transition, DEFAULT_THRESHOLDS, null)).toBe('first reading');
  });
});

describe('lastTransitionFromHistory (status lastTransition derivation)', () => {
  it('derives the most recent boundary change from per-turn history', () => {
    const history = [
      reading(30, '2026-07-02T18:00:00.000Z'),
      reading(45.2, '2026-07-02T18:05:00.000Z'),
    ];
    const transition = lastTransitionFromHistory(history, DEFAULT_THRESHOLDS);
    expect(transition?.from).toBe('green');
    expect(transition?.to).toBe('yellow');
    expect(transition?.direction).toBe('escalation');
    expect(transition?.reading.pct).toBe(45.2);
  });

  it('returns the LAST transition when several occurred', () => {
    const history = [
      reading(30, '2026-07-02T18:00:00.000Z'),
      reading(68, '2026-07-02T18:05:00.000Z'),
      reading(50, '2026-07-02T18:10:00.000Z'),
    ];
    const transition = lastTransitionFromHistory(history, DEFAULT_THRESHOLDS);
    expect(transition?.from).toBe('orange');
    expect(transition?.to).toBe('yellow');
    expect(transition?.direction).toBe('de-escalation');
    expect(transition?.reading.pct).toBe(50);
  });

  it('null when the history never crosses a boundary', () => {
    const history = [
      reading(25, '2026-07-02T18:00:00.000Z'),
      reading(30, '2026-07-02T18:05:00.000Z'),
      reading(35, '2026-07-02T18:10:00.000Z'),
    ];
    expect(lastTransitionFromHistory(history, DEFAULT_THRESHOLDS)).toBeNull();
  });

  it('null for empty or single-sample history', () => {
    expect(lastTransitionFromHistory([], DEFAULT_THRESHOLDS)).toBeNull();
    expect(lastTransitionFromHistory([reading(80)], DEFAULT_THRESHOLDS)).toBeNull();
  });
});
