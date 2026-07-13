// Feature 002 T016 — per-connection CheckCursor bookkeeping (data-model.md
// "CheckCursor", research R4).
//
// Cursors are per-connection ephemera: they live in the Connection's in-memory
// Map (sessionId → CheckCursor), are NEVER persisted, and die with the
// connection — persisting them would leak one client's read position into
// another's. Lifecycle per the data model:
//
//   - created on a connection's first catch-up for a session: the full usage
//     history is replayed once to establish position + current zone, but NOTHING
//     from that history is delivered — the first call is a snapshot, not history;
//   - advanced on every subsequent call: only entries at or after the cursor
//     replay, and the delta's transitions are delivered;
//   - the cursor never advances past an incomplete (torn) entry — the replay
//     function guarantees it (self-monitoring mid-write edge case).
//
// Pure bookkeeping over the pure replay (T004): no clock, no randomness, no IO —
// catch-up stays deterministic (same history + same cursor ⇒ identical report)
// and strictly read-only (declines and read tools write NOTHING).
import type { ZoneThresholds } from '../core/config/schema.js';
import { replayUsageHistory } from '../core/monitor/replay.js';
import type { ZoneTransition } from '../core/monitor/types.js';
import type { CheckCursor } from './server.js';

/** What one catch-up call learned while advancing its cursor. */
export interface CheckCursorAdvance {
  /** true when this call CREATED the cursor — snapshot semantics, no history */
  snapshot: boolean;
  /** transitions to deliver for this call (always empty on the snapshot call) */
  transitions: ZoneTransition[];
  /**
   * The most recent boundary change this call's replay observed — on the
   * snapshot call it names how the session entered its CURRENT zone (the
   * standing advisory's trigger); on a delta call it is the last delivered
   * transition. Null when the replay saw no zone change (nothing new).
   */
  lastTransition: ZoneTransition | null;
}

/**
 * Get-or-create the session's cursor, replay the usage history from it, and
 * advance it (in place in the connection's Map). First call: replay from the
 * beginning to establish where "now" is, deliver nothing (create-on-first-call
 * snapshot semantics). Later calls: deliver the delta since the cursor.
 */
export function advanceCheckCursor(
  cursors: Map<string, CheckCursor>,
  sessionId: string,
  usageHistory: readonly unknown[],
  thresholds: ZoneThresholds,
): CheckCursorAdvance {
  const existing = cursors.get(sessionId);
  const snapshot = existing === undefined;
  const fromCursor =
    existing === undefined
      ? { position: 0, lastZone: 'unknown' as const }
      : { position: existing.position, lastZone: existing.lastZone };

  const { transitions, toCursor } = replayUsageHistory(usageHistory, thresholds, fromCursor);
  cursors.set(sessionId, {
    sessionId,
    position: toCursor.position,
    lastZone: toCursor.lastZone,
  });

  return {
    snapshot,
    transitions: snapshot ? [] : transitions,
    lastTransition: transitions.at(-1) ?? null,
  };
}
