// T032 — Zone transition detection (US2, FR-005).
// Compares the persisted/previous zone with the zone of the current reading:
// multi-band jumps collapse to exactly ONE transition naming the FINAL zone, the
// first classification comes from "unknown", and a persisted lastZone gives
// restart continuity (no duplicate notification when nothing changed).
//
// Everything here is a pure function of its inputs — no clock, no randomness,
// no IO — and every derived string names the thresholds involved so the
// notification stays explainable (FR-006, design-notes 2a/2b copy verbatim:
// escalation `crossed 40% & 60% · now 68%`, drop `compaction 78% → 30%`).
import type { ZoneThresholds } from '../config/schema.js';
import type { UsageReading, ZoneOrUnknown, ZoneTransition } from './types.js';
import { ZONE_ORDER, classifyZone } from './zones.js';

/** Zone escalation rank; `unknown` sits below green so first readings escalate. */
export function zoneRank(zone: ZoneOrUnknown): number {
  return zone === 'unknown' ? -1 : ZONE_ORDER.indexOf(zone);
}

/** Lower percentage boundary of a zone (green implicit [0, yellow); unknown → 0). */
function lowerBoundPct(zone: ZoneOrUnknown, thresholds: ZoneThresholds): number {
  switch (zone) {
    case 'yellow':
      return thresholds.yellow;
    case 'orange':
      return thresholds.orange;
    case 'red':
      return thresholds.red;
    default: // green | unknown
      return 0;
  }
}

/**
 * Detect a zone transition between the previous zone (live previous reading or
 * persisted lastZone) and the current reading. Returns null while the zone is
 * unchanged; multi-band jumps yield one transition to the final zone (FR-005).
 */
export function detectTransition(
  lastZone: ZoneOrUnknown,
  reading: UsageReading,
  thresholds: ZoneThresholds,
): ZoneTransition | null {
  const to = classifyZone(reading.pct, thresholds);
  if (to === lastZone) return null;
  return {
    sessionId: reading.sessionId,
    from: lastZone,
    to,
    direction: zoneRank(to) > zoneRank(lastZone) ? 'escalation' : 'de-escalation',
    reading,
  };
}

/**
 * Every configured threshold whose boundary lies between the two zones —
 * ascending, so a multi-band banner can name each crossing (FR-005/FR-006).
 * Works in both directions; `unknown` is treated as below green.
 */
export function crossedThresholds(
  from: ZoneOrUnknown,
  to: ZoneOrUnknown,
  thresholds: ZoneThresholds,
): number[] {
  const fromBound = lowerBoundPct(from, thresholds);
  const toBound = lowerBoundPct(to, thresholds);
  const low = Math.min(fromBound, toBound);
  const high = Math.max(fromBound, toBound);
  return [thresholds.yellow, thresholds.orange, thresholds.red].filter(
    (value) => value > low && value <= high,
  );
}

/**
 * Compact crossing explanation (event-log tail, design `◆ YELLOW @ 43% · crossed 40%`):
 * - escalation: `crossed 40% & 60%` (every threshold crossed)
 * - de-escalation: `compaction 78% → 30%` (needs the previous pct)
 * - first classification (unknown → green, nothing crossed): `first reading`
 */
export function crossingSummary(
  transition: ZoneTransition,
  thresholds: ZoneThresholds,
  fromPct: number | null,
): string {
  const nowPct = Math.round(transition.reading.pct);
  if (transition.direction === 'de-escalation') {
    return fromPct === null
      ? `now ${String(nowPct)}%`
      : `compaction ${String(Math.round(fromPct))}% → ${String(nowPct)}%`;
  }
  const crossed = crossedThresholds(transition.from, transition.to, thresholds);
  if (crossed.length === 0) return 'first reading';
  return `crossed ${crossed.map((value) => `${String(value)}%`).join(' & ')}`;
}

/**
 * Banner subtitle (design 2a/2b verbatim): escalations append the new reading
 * (`crossed 40% & 60% · now 68%`); drops keep the compaction format as-is.
 */
export function transitionSubtitle(
  transition: ZoneTransition,
  thresholds: ZoneThresholds,
  fromPct: number | null,
): string {
  const summary = crossingSummary(transition, thresholds, fromPct);
  if (transition.direction === 'de-escalation') return summary;
  return `${summary} · now ${String(Math.round(transition.reading.pct))}%`;
}

/**
 * Most recent boundary change derivable from per-turn usage history (oldest →
 * newest) — feeds the `status` lastTransition field deterministically from
 * session data alone. Null when the history never crosses a boundary.
 */
export function lastTransitionFromHistory(
  history: readonly UsageReading[],
  thresholds: ZoneThresholds,
): ZoneTransition | null {
  let last: ZoneTransition | null = null;
  for (let index = 1; index < history.length; index += 1) {
    const previous = history[index - 1];
    const current = history[index];
    if (previous === undefined || current === undefined) continue;
    const transition = detectTransition(
      classifyZone(previous.pct, thresholds),
      current,
      thresholds,
    );
    if (transition !== null) last = transition;
  }
  return last;
}
