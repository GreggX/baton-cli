// Feature 002 T003 — catch-up replay unit tests (write first, must fail).
//
// Contract (data-model.md "Replay" derivation rules, research R4):
//   replayUsageHistory(usageHistory, thresholds, fromCursor) → { transitions, toCursor }
//
// Invariants under test:
//   - deterministic: same history + same cursor ⇒ identical report
//   - multi-band jumps collapse to ONE transition per jump, naming the final zone
//   - no transition is ever fabricated from estimated/exact flapping alone
//   - unknown/incomplete states claim no zone
//   - cursor advance semantics: incremental replays ≡ one batch replay
//   - a torn/partial final entry is tolerated: skipped, never crashes, and the
//     cursor never advances past it (self-monitoring mid-write edge case)
import { describe, expect, it } from 'vitest';
import { DEFAULT_THRESHOLDS } from '../../src/core/config/schema.js';
import type { ReplayCursor } from '../../src/core/monitor/replay.js';
import { replayUsageHistory } from '../../src/core/monitor/replay.js';
import type { UsageReading } from '../../src/core/monitor/types.js';

const thresholds = DEFAULT_THRESHOLDS; // yellow 40 / orange 60 / red 75

let turn = 0;

/** Deterministic reading at a given pct of a 200k window (timestamps ascend per call). */
function reading(pct: number, precision: 'exact' | 'estimated' = 'exact'): UsageReading {
  turn += 1;
  const contextWindow = 200_000;
  return {
    sessionId: 's-replay',
    tokensUsed: Math.round((pct / 100) * contextWindow),
    contextWindow,
    pct,
    precision,
    timestamp: `2026-07-02T18:${String(Math.floor(turn / 60)).padStart(2, '0')}:${String(turn % 60).padStart(2, '0')}.000Z`,
  };
}

const cursor = (position: number, lastZone: ReplayCursor['lastZone']): ReplayCursor => ({
  position,
  lastZone,
});

describe('replayUsageHistory — determinism', () => {
  it('same history + same cursor ⇒ identical report (deep equal, twice)', () => {
    const history = [reading(35), reading(45), reading(68), reading(80)];
    const from = cursor(0, 'green');
    const first = replayUsageHistory(history, thresholds, from);
    const second = replayUsageHistory(history, thresholds, from);
    expect(second).toEqual(first);
    // the input cursor is never mutated
    expect(from).toEqual(cursor(0, 'green'));
  });

  it('emits one transition per boundary change, carrying the causing reading', () => {
    const history = [reading(35), reading(45)];
    const { transitions } = replayUsageHistory(history, thresholds, cursor(0, 'green'));
    expect(transitions).toHaveLength(1);
    expect(transitions[0]).toMatchObject({
      from: 'green',
      to: 'yellow',
      direction: 'escalation',
      reading: history[1],
    });
  });

  it('entries within one zone emit nothing', () => {
    const history = [reading(20), reading(25), reading(39)];
    const { transitions } = replayUsageHistory(history, thresholds, cursor(0, 'green'));
    expect(transitions).toEqual([]);
  });
});

describe('replayUsageHistory — multi-band collapse (FR-009)', () => {
  it('a single jump across several bands collapses to ONE transition naming the final zone', () => {
    // 35% → 38% → 39.5% → 68%: the final reading crosses 40% AND 60% at once.
    const history = [reading(35), reading(38), reading(39.5), reading(68)];
    const { transitions } = replayUsageHistory(history, thresholds, cursor(0, 'green'));
    expect(transitions).toHaveLength(1);
    expect(transitions[0]).toMatchObject({ from: 'green', to: 'orange', direction: 'escalation' });
  });

  it('one transition per jump: two separate jumps stay two transitions', () => {
    // green → orange (one jump over two bands), then orange → red (second jump).
    const history = [reading(30), reading(68), reading(80)];
    const { transitions } = replayUsageHistory(history, thresholds, cursor(0, 'green'));
    expect(transitions).toHaveLength(2);
    expect(transitions[0]).toMatchObject({ from: 'green', to: 'orange' });
    expect(transitions[1]).toMatchObject({ from: 'orange', to: 'red' });
  });

  it('a green → red jump in one reading is a single transition to red', () => {
    const history = [reading(30), reading(80)];
    const { transitions } = replayUsageHistory(history, thresholds, cursor(0, 'green'));
    expect(transitions).toHaveLength(1);
    expect(transitions[0]).toMatchObject({ from: 'green', to: 'red', direction: 'escalation' });
  });

  it('de-escalation (compaction) is reported with its direction', () => {
    const history = [reading(80), reading(30)];
    const { transitions } = replayUsageHistory(history, thresholds, cursor(0, 'red'));
    expect(transitions).toHaveLength(1);
    expect(transitions[0]).toMatchObject({ from: 'red', to: 'green', direction: 'de-escalation' });
  });
});

describe('replayUsageHistory — no fabrication from estimated/exact flapping alone', () => {
  it('precision flapping inside one zone emits no transitions', () => {
    const history = [
      reading(35, 'exact'),
      reading(35.2, 'estimated'),
      reading(34.8, 'exact'),
      reading(35.1, 'estimated'),
    ];
    const { transitions, toCursor } = replayUsageHistory(history, thresholds, cursor(0, 'green'));
    expect(transitions).toEqual([]);
    expect(toCursor.lastZone).toBe('green');
  });

  it('an identical pct re-read with different precision emits nothing', () => {
    const history = [reading(45, 'exact'), reading(45, 'estimated'), reading(45, 'exact')];
    const { transitions } = replayUsageHistory(history, thresholds, cursor(0, 'yellow'));
    expect(transitions).toEqual([]);
  });
});

describe('replayUsageHistory — unknown states claim no zone', () => {
  it('an empty history from an unknown cursor stays unknown and emits nothing', () => {
    const { transitions, toCursor } = replayUsageHistory([], thresholds, cursor(0, 'unknown'));
    expect(transitions).toEqual([]);
    expect(toCursor).toEqual(cursor(0, 'unknown'));
  });

  it('unreadable entries never classify into a zone', () => {
    const garbage: unknown[] = [null, 42, 'torn line', { sessionId: 's-replay' }];
    const { transitions, toCursor } = replayUsageHistory(garbage, thresholds, cursor(0, 'green'));
    expect(transitions).toEqual([]);
    expect(toCursor.lastZone).toBe('green'); // no zone claim fabricated from garbage
  });

  it('the first valid reading after an unknown cursor names unknown as its origin', () => {
    // Feature 001 semantics: the first classification comes from "unknown" —
    // `to` is always a real zone; "unknown" never appears as a destination.
    const history = [reading(45)];
    const { transitions } = replayUsageHistory(history, thresholds, cursor(0, 'unknown'));
    expect(transitions).toHaveLength(1);
    expect(transitions[0]).toMatchObject({ from: 'unknown', to: 'yellow', direction: 'escalation' });
  });
});

describe('replayUsageHistory — cursor advance semantics', () => {
  it('advances the cursor past every consumed entry and records the final zone', () => {
    const history = [reading(35), reading(45), reading(68)];
    const { toCursor } = replayUsageHistory(history, thresholds, cursor(0, 'green'));
    expect(toCursor).toEqual(cursor(3, 'orange'));
  });

  it('replays only entries at or after the cursor position', () => {
    const history = [reading(35), reading(45), reading(68)];
    // Entries 0–1 were already reported (zone yellow at position 2).
    const { transitions, toCursor } = replayUsageHistory(history, thresholds, cursor(2, 'yellow'));
    expect(transitions).toHaveLength(1);
    expect(transitions[0]).toMatchObject({ from: 'yellow', to: 'orange' });
    expect(toCursor).toEqual(cursor(3, 'orange'));
  });

  it('incremental replays are equivalent to one batch replay', () => {
    const older = [reading(35), reading(45)];
    const newer = [...older, reading(39), reading(68), reading(80)];
    const firstLeg = replayUsageHistory(older, thresholds, cursor(0, 'green'));
    const secondLeg = replayUsageHistory(newer, thresholds, firstLeg.toCursor);
    const batch = replayUsageHistory(newer, thresholds, cursor(0, 'green'));
    expect([...firstLeg.transitions, ...secondLeg.transitions]).toEqual(batch.transitions);
    expect(secondLeg.toCursor).toEqual(batch.toCursor);
  });

  it('an already-current cursor sees nothing and does not move', () => {
    const history = [reading(35), reading(45)];
    const { transitions, toCursor } = replayUsageHistory(history, thresholds, cursor(2, 'yellow'));
    expect(transitions).toEqual([]);
    expect(toCursor).toEqual(cursor(2, 'yellow'));
  });
});

describe('replayUsageHistory — torn/partial final entry (self-monitoring mid-write)', () => {
  const torn = { sessionId: 's-replay', tokensUsed: 12 }; // incomplete: mid-append snapshot

  it('is tolerated: skipped, never crashes, prefix still replayed', () => {
    const history: unknown[] = [reading(35), reading(45), torn];
    const { transitions } = replayUsageHistory(history, thresholds, cursor(0, 'green'));
    expect(transitions).toHaveLength(1);
    expect(transitions[0]).toMatchObject({ from: 'green', to: 'yellow' });
  });

  it('never advances the cursor past an incomplete final entry', () => {
    const history: unknown[] = [reading(35), reading(45), torn];
    const { toCursor } = replayUsageHistory(history, thresholds, cursor(0, 'green'));
    expect(toCursor.position).toBe(2); // points AT the torn entry, not past it
    expect(toCursor.lastZone).toBe('yellow');
  });

  it('re-reads the entry once it completes — no gap, no duplicate', () => {
    const partial: unknown[] = [reading(35), reading(45), torn];
    const leg1 = replayUsageHistory(partial, thresholds, cursor(0, 'green'));
    // The torn entry completes into a real reading on the next observation.
    const completed: unknown[] = [partial[0], partial[1], reading(68)];
    const leg2 = replayUsageHistory(completed, thresholds, leg1.toCursor);
    expect(leg2.transitions).toHaveLength(1);
    expect(leg2.transitions[0]).toMatchObject({ from: 'yellow', to: 'orange' });
    expect(leg2.toCursor).toEqual(cursor(3, 'orange'));
  });

  it('a torn entry alone produces an empty report and a parked cursor', () => {
    const { transitions, toCursor } = replayUsageHistory([torn], thresholds, cursor(0, 'green'));
    expect(transitions).toEqual([]);
    expect(toCursor).toEqual(cursor(0, 'green'));
  });
});
