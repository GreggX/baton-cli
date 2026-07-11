// T033 — Recommendation engine (US2, FR-006/FR-014).
// Zone entries map to advisory kinds (yellow → favor_retrieval, orange → compact,
// red → new_session); guidance is the canonical zone copy prefixed by the trigger
// explanation, so every recommendation names its zone and thresholds (FR-006).
// Ids are deterministic — hash(sessionId, kind, trigger identity) — so the same
// advisory re-arms under the same id after a zone exit (FR-014), and the dismissal
// bookkeeping API keeps `.baton/state.json` the single anti-nag source of truth.
//
// Pure functions only: no clock, no randomness, no IO (sha256 is deterministic).
import { createHash } from 'node:crypto';
import type { ZoneThresholds } from '../config/schema.js';
import { crossedThresholds, detectTransition, transitionSubtitle } from './transitions.js';
import type {
  MonitorState,
  Recommendation,
  RecommendationKind,
  Trigger,
  UsageReading,
  ZoneName,
  ZoneTransition,
} from './types.js';
import { ZONE_GUIDANCE, classifyZone } from './zones.js';

/** Advisory kind issued on entering each non-green zone (green recovery is quiet). */
export const ZONE_RECOMMENDATION_KINDS: Readonly<
  Record<Exclude<ZoneName, 'green'>, RecommendationKind>
> = Object.freeze({
  yellow: 'favor_retrieval',
  orange: 'compact',
  red: 'new_session',
});

/** Deterministic id from identity parts: `r-` + first 12 hex of sha256. */
function hashId(parts: readonly string[]): string {
  const digest = createHash('sha256').update(JSON.stringify(parts)).digest('hex');
  return `r-${digest.slice(0, 12)}`;
}

/**
 * Deterministic recommendation id — hash(sessionId, kind, trigger identity).
 * Zone-transition triggers are identified by the zone ENTERED (not the reading or
 * the entered-from zone), so a re-armed advisory re-issues under the same id
 * (data-model: "may become pending again", FR-014).
 */
export function recommendationId(
  sessionId: string,
  kind: RecommendationKind,
  trigger: Trigger,
): string {
  return trigger.kind === 'zone_transition'
    ? hashId([sessionId, kind, trigger.kind, trigger.transition.to])
    : hashId([sessionId, kind, trigger.kind, trigger.ruleId, trigger.candidateId]);
}

/** Id of the zone advisory for a session, without needing a full trigger object. */
export function zoneRecommendationId(
  sessionId: string,
  zone: Exclude<ZoneName, 'green'>,
): string {
  return hashId([sessionId, ZONE_RECOMMENDATION_KINDS[zone], 'zone_transition', zone]);
}

/**
 * Build the pending advisory for a zone transition, or null for green (recovery
 * is a quiet stamp, not advice to act). Guidance embeds the trigger explanation
 * — the zone entered AND every threshold crossed (FR-006, SC-003):
 * escalation `Entered orange — crossed 40% & 60% · now 68%. <zone guidance>`;
 * de-escalation `Entered orange — compaction 78% → 68% · back under 75%. <zone guidance>`.
 */
export function recommendationForTransition(
  transition: ZoneTransition,
  thresholds: ZoneThresholds,
  fromPct: number | null = null,
): Recommendation | null {
  if (transition.to === 'green') return null;
  const kind = ZONE_RECOMMENDATION_KINDS[transition.to];
  const trigger: Trigger = { kind: 'zone_transition', transition };
  // The drop subtitle (`compaction 78% → 68%`, design copy) names no boundary,
  // so de-escalations append the thresholds crossed downward (FR-006).
  const crossedDown =
    transition.direction === 'de-escalation'
      ? crossedThresholds(transition.from, transition.to, thresholds)
      : [];
  const thresholdNote =
    crossedDown.length === 0
      ? ''
      : ` · back under ${crossedDown.map((value) => `${String(value)}%`).join(' & ')}`;
  return {
    id: recommendationId(transition.sessionId, kind, trigger),
    kind,
    trigger,
    guidance: `Entered ${transition.to} — ${transitionSubtitle(transition, thresholds, fromPct)}${thresholdNote}. ${ZONE_GUIDANCE[transition.to]}`,
    state: 'pending',
  };
}

// ── Dismissal bookkeeping (FR-014, persisted via MonitorState) ────────────────

/** Record a dismissal (replacing any earlier record for the same id). */
export function dismiss(
  state: MonitorState,
  recommendationIdValue: string,
  zone: ZoneName,
  dismissedAt: string,
): MonitorState {
  const others = state.dismissals.filter(
    (dismissal) => dismissal.recommendationId !== recommendationIdValue,
  );
  return {
    ...state,
    dismissals: [...others, { recommendationId: recommendationIdValue, zone, dismissedAt }],
  };
}

/**
 * A dismissal only holds while the session stays in the zone it was dismissed in;
 * leaving the zone (either direction) re-arms the advisory (FR-014).
 */
export function isDismissed(
  state: MonitorState,
  recommendationIdValue: string,
  currentZone: ZoneName,
): boolean {
  return state.dismissals.some(
    (dismissal) =>
      dismissal.recommendationId === recommendationIdValue && dismissal.zone === currentZone,
  );
}

/** Prune dismissals whose zone was exited — they are re-armed (FR-014). */
export function rearmDismissals(state: MonitorState, currentZone: ZoneName): MonitorState {
  const kept = state.dismissals.filter((dismissal) => dismissal.zone === currentZone);
  return kept.length === state.dismissals.length ? state : { ...state, dismissals: kept };
}

// ── One-step monitor advance (shared by watch NDJSON and the Ink pane) ────────

export interface MonitorAdvance {
  /** next persisted state: lastZone updated, exited-zone dismissals re-armed */
  state: MonitorState;
  zone: ZoneName;
  /** the boundary change caused by this reading, if any (one per crossing) */
  transition: ZoneTransition | null;
  /** pending advisory for the entered zone; null when none or dismissed (FR-014) */
  recommendation: Recommendation | null;
}

export interface AdvanceMonitorOptions {
  state: MonitorState;
  reading: UsageReading;
  thresholds: ZoneThresholds;
  /** previous reading's pct for the crossing/compaction copy; null when unknown */
  fromPct?: number | null;
}

/**
 * Advance the monitor by one reading: classify, detect the transition against the
 * (persisted) lastZone, re-arm dismissals for exited zones, and derive the pending
 * advisory. Pure — persistence is the caller's single `.baton/state.json` write.
 */
export function advanceMonitor(options: AdvanceMonitorOptions): MonitorAdvance {
  const { state, reading, thresholds } = options;
  const fromPct = options.fromPct ?? null;
  const zone = classifyZone(reading.pct, thresholds);
  const transition = detectTransition(state.lastZone, reading, thresholds);

  // A dismissal survives only while the session verifiably stayed in its zone:
  // it must match both the previous (persisted) zone and the current one —
  // anything else means the zone was exited, which re-arms it (FR-014).
  // Candidate dismissals (save suggestions, FR-015) are STICKY: they never
  // re-arm, so they pass through zone changes untouched.
  const nextState: MonitorState = {
    sessionId: state.sessionId,
    lastZone: zone,
    dismissals: state.dismissals.filter(
      (dismissal) => dismissal.zone === state.lastZone && dismissal.zone === zone,
    ),
    dismissedCandidates: state.dismissedCandidates,
  };

  let recommendation =
    transition === null ? null : recommendationForTransition(transition, thresholds, fromPct);
  if (recommendation !== null && isDismissed(nextState, recommendation.id, zone)) {
    recommendation = null; // dismissed in this zone: stays quiet, no repeat (FR-014)
  }

  return { state: nextState, zone, transition, recommendation };
}
