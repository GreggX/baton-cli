// Feature 002 T004 — pure catch-up replay (data-model.md "Replay", research R4).
//
// `replayUsageHistory(usageHistory, thresholds, fromCursor) → { transitions, toCursor }`
//
// The transcript already contains the full usage history, so zone transitions are
// DERIVABLE, not stateful: each consecutive reading classifies through feature 001's
// zone function, a zone change emits exactly one ZoneTransition carrying the reading
// that caused it (multi-band jumps therefore collapse to one transition per jump,
// FR-009), and entries within one zone emit nothing. Precision (estimated/exact)
// plays no role in classification, so flapping alone can never fabricate a transition.
//
// Deterministic and pure: no clock, no randomness, no IO — same history + same
// cursor ⇒ identical report (constitution Principle "deterministic/explainable").
//
// Torn-tail tolerance (self-monitoring mid-write edge case): the input is typed
// `readonly unknown[]` and every entry is validated against the UsageReading schema.
// An incomplete/unreadable entry claims no zone and emits nothing, and the cursor
// never advances past it — once the entry completes, the next replay resumes there
// with no gap and no duplicate.
import type { ZoneThresholds } from '../config/schema.js';
import { detectTransition } from './transitions.js';
import type { UsageReading, ZoneOrUnknown, ZoneTransition } from './types.js';
import { usageReadingSchema } from './types.js';

/**
 * Where a replay resumes (pure-function view of data-model.md CheckCursor).
 *
 * `position` counts the history entries already consumed — it is the index of the
 * first entry not yet reported (0 = nothing reported yet). `lastZone` is the zone
 * at that position; replay resumes from it.
 */
export interface ReplayCursor {
  /** index of the first history entry not yet reported (≥ 0) */
  position: number;
  /** zone at that position; "unknown" before any classification */
  lastZone: ZoneOrUnknown;
}

/** The replay's answer: transitions since the cursor, and where the next replay resumes. */
export interface ReplayResult {
  /** one ZoneTransition per zone change, each carrying the reading that caused it */
  transitions: ZoneTransition[];
  /** advance the caller's cursor to this; never past an incomplete entry */
  toCursor: ReplayCursor;
}

/**
 * Replay the per-entry usage series from the cursor position forward.
 *
 * Well-typed callers pass `UsageReading[]` (the adapter's usage history); entries
 * are still validated so a torn/partial final entry — observed while the agent is
 * mid-append — is skipped, never crashes, and never advances the cursor past itself.
 */
export function replayUsageHistory(
  usageHistory: readonly unknown[],
  thresholds: ZoneThresholds,
  fromCursor: ReplayCursor,
): ReplayResult {
  const start = Math.max(0, fromCursor.position);
  const transitions: ZoneTransition[] = [];
  let lastZone: ZoneOrUnknown = fromCursor.lastZone;
  // The cursor only ever advances to one past the last COMPLETE entry consumed,
  // so a torn tail is re-examined by the next replay once it completes.
  let position = fromCursor.position;

  for (let index = start; index < usageHistory.length; index += 1) {
    const parsed = usageReadingSchema.safeParse(usageHistory[index]);
    if (!parsed.success) continue; // incomplete/unreadable: no zone claim, no advance
    const reading: UsageReading = parsed.data;
    const transition = detectTransition(lastZone, reading, thresholds);
    if (transition !== null) {
      transitions.push(transition);
      lastZone = transition.to;
    }
    position = index + 1;
  }

  return { transitions, toCursor: { position, lastZone } };
}
