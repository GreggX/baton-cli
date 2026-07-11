// T011 — Monitor entity schemas per data-model.md.
// Zod schemas are the single source of truth: runtime validation, CLI --json contracts,
// and the future MCP surface all reuse these (Principle V).
import { z } from 'zod';

/** ISO datetime string ("2026-07-02T18:04:11Z" or with numeric offset). */
const isoDatetime = z.iso.datetime({ offset: true });

// ── Zone names ────────────────────────────────────────────────────────────────

export const zoneNameSchema = z.enum(['green', 'yellow', 'orange', 'red']);
export type ZoneName = z.infer<typeof zoneNameSchema>;

/** Zone name as seen before any reading exists (persisted lastZone, transition `from`). */
export const zoneOrUnknownSchema = z.union([zoneNameSchema, z.literal('unknown')]);
export type ZoneOrUnknown = z.infer<typeof zoneOrUnknownSchema>;

// ── SessionRef ────────────────────────────────────────────────────────────────

/** The monitored session, as core sees it (adapter resolves it). */
export const sessionRefSchema = z.object({
  /** non-empty; adapter-native session identifier */
  id: z.string().min(1),
  /** absolute path of the project the session belongs to */
  workspace: z.string(),
  /** as reported by session data; null -> window estimated */
  modelId: z.string().nullable(),
  /** drives staleness display (FR-011) */
  lastActivityAt: isoDatetime,
});
export type SessionRef = z.infer<typeof sessionRefSchema>;

// ── UsageReading ──────────────────────────────────────────────────────────────

/** Point-in-time measurement. Immutable. */
export const usageReadingSchema = z.object({
  sessionId: z.string(),
  /** from usage accounting, or estimated */
  tokensUsed: z.number().int().min(0),
  /** from the model->window map */
  contextWindow: z.number().int().gt(0),
  /** derived: min(100, tokensUsed / contextWindow * 100) */
  pct: z.number().min(0).max(100),
  /** "estimated" whenever any input was inferred (FR-013) */
  precision: z.enum(['exact', 'estimated']),
  /** when measured */
  timestamp: isoDatetime,
});
export type UsageReading = z.infer<typeof usageReadingSchema>;

/** Derive the pct field for a reading: min(100, tokensUsed / contextWindow * 100). */
export function computePct(tokensUsed: number, contextWindow: number): number {
  return Math.min(100, (tokensUsed / contextWindow) * 100);
}

// ── ReadingUnavailable ────────────────────────────────────────────────────────

/**
 * Absence of a producible reading — never a fake reading (FR-011).
 */
export const readingUnavailableSchema = z.object({
  sessionId: z.string(),
  reason: z.string(),
  lastGoodReading: usageReadingSchema.nullable(),
});
export type ReadingUnavailable = z.infer<typeof readingUnavailableSchema>;

/** Narrow a reading result to the unavailable state. */
export function isReadingUnavailable(
  result: UsageReading | ReadingUnavailable,
): result is ReadingUnavailable {
  return 'reason' in result;
}

// ── ZoneTransition ────────────────────────────────────────────────────────────

export const zoneTransitionSchema = z.object({
  sessionId: z.string(),
  /** zone before the update */
  from: zoneOrUnknownSchema,
  /** zone after the update (final zone only on multi-band jumps, FR-005) */
  to: zoneNameSchema,
  /** derived from zone order */
  direction: z.enum(['escalation', 'de-escalation']),
  /** the reading that caused it */
  reading: usageReadingSchema,
});
export type ZoneTransition = z.infer<typeof zoneTransitionSchema>;

// ── Trigger (discriminated union) ─────────────────────────────────────────────

/** Mandatory cause of every recommendation — no untriggered recommendations (FR-006). */
export const triggerSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('zone_transition'),
    transition: zoneTransitionSchema,
  }),
  z.object({
    kind: z.literal('rule_match'),
    ruleId: z.string(),
    candidateId: z.string(),
  }),
]);
export type Trigger = z.infer<typeof triggerSchema>;

// ── Recommendation ────────────────────────────────────────────────────────────

export const recommendationKindSchema = z.enum([
  'favor_retrieval',
  'compact',
  'new_session',
  'save_candidate',
]);
export type RecommendationKind = z.infer<typeof recommendationKindSchema>;

export const recommendationStateSchema = z.enum(['pending', 'accepted', 'dismissed']);
export type RecommendationState = z.infer<typeof recommendationStateSchema>;

export const recommendationSchema = z.object({
  /** deterministic: hash(sessionId, kind, trigger) */
  id: z.string(),
  kind: recommendationKindSchema,
  trigger: triggerSchema,
  /** human-readable advice incl. the trigger explanation */
  guidance: z.string(),
  state: recommendationStateSchema,
});
export type Recommendation = z.infer<typeof recommendationSchema>;

// ── MonitorState (persisted, .baton/state.json) ───────────────────────────────

/**
 * Tool bookkeeping only — ids, zone names, timestamps. MUST never contain session
 * content (keeps the automatic state write inside the FR-007/SC-004 exemption).
 */
export const monitorStateSchema = z.object({
  /** state is per-session; new session id => fresh state */
  sessionId: z.string(),
  /** for transition detection across process restarts */
  lastZone: zoneOrUnknownSchema,
  /** re-arm bookkeeping (FR-014) */
  dismissals: z.array(
    z.object({
      recommendationId: z.string(),
      zone: zoneNameSchema,
      dismissedAt: isoDatetime,
    }),
  ),
  /**
   * Per-candidate save-suggestion dismissals (FR-015): STICKY — unlike zone
   * advisory dismissals these never re-arm; a dismissed candidate is never
   * re-offered, in any zone. Optional: states persisted before US3 lack it.
   * Still bookkeeping only — candidate ids and timestamps, never content.
   */
  dismissedCandidates: z
    .array(
      z.object({
        candidateId: z.string(),
        dismissedAt: isoDatetime,
      }),
    )
    .optional(),
});
export type MonitorState = z.infer<typeof monitorStateSchema>;
