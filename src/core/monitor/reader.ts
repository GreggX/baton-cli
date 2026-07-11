// T024 — Reading pipeline service (US1).
// SessionSource → UsageReading | ReadingUnavailable, plus zone classification,
// data-age computation, and the deterministic burn/ETA derivations that feed the
// status line and watch pane (sparkline, burn, forecast — design 1a/1c).
//
// Determinism: everything here is a pure function of its inputs — the clock is
// INJECTED (`now`), never read (no Date.now()); no randomness; no IO beyond the
// SessionSource port. Estimated inputs stay labeled `estimated` end to end (FR-013);
// when no reading is producible the pipeline returns the explicit unknown state,
// never a fabricated zone (FR-011).
import { z } from 'zod';
import type { ZoneThresholds } from '../config/schema.js';
import type { SessionSource } from './session-source.js';
import { lastTransitionFromHistory } from './transitions.js';
import type { SessionRef, UsageReading, ZoneName, ZoneTransition } from './types.js';
import {
  isReadingUnavailable,
  readingUnavailableSchema,
  recommendationSchema,
  usageReadingSchema,
  zoneNameSchema,
  zoneOrUnknownSchema,
  zoneTransitionSchema,
} from './types.js';
import { ZONE_GUIDANCE, classifyZone } from './zones.js';

// ── Derivation constants (named so every derived figure is auditable) ─────────

/** Burn slope window: pct delta per turn is averaged over the last N readings. */
export const BURN_WINDOW_TURNS = 5;

/** Sparkline sample count (design canonical: last 12 samples). */
export const SPARKLINE_SAMPLES = 12;

// ── Pipeline result ───────────────────────────────────────────────────────────

/** A producible reading with everything the presentation layer derives from it. */
export interface StatusOk {
  state: 'ok';
  session: SessionRef;
  reading: UsageReading;
  zone: ZoneName;
  /** canonical zone guidance (ZONE_GUIDANCE) */
  guidance: string;
  /** seconds since the reading's timestamp, relative to the injected clock */
  dataAgeSeconds: number;
  /** per-turn usage history from the transcript, oldest → newest (≥1 entry) */
  history: UsageReading[];
  /** most recent boundary change derivable from the history; null when none (US2) */
  lastTransition: ZoneTransition | null;
}

/** The explicit unknown state — never a fake reading or zone (FR-011). */
export interface StatusUnknown {
  state: 'unknown';
  /** null when no session could be resolved at all */
  session: SessionRef | null;
  reason: string;
  lastGoodReading: UsageReading | null;
  /** age of the last good reading (or last session activity); null when unknowable */
  dataAgeSeconds: number | null;
}

export type Status = StatusOk | StatusUnknown;

export interface ReadStatusOptions {
  /** workspace whose session is monitored */
  workspace: string;
  /** explicit session id override */
  sessionId?: string | undefined;
  /** effective zone thresholds (config or defaults) */
  thresholds: ZoneThresholds;
  /** injected clock — core never reads the wall clock itself */
  now: Date;
}

/** Whole seconds elapsed from an ISO timestamp to the injected clock, clamped ≥ 0. */
export function ageSeconds(timestamp: string, now: Date): number {
  const elapsed = Math.floor((now.getTime() - Date.parse(timestamp)) / 1000);
  return Math.max(0, elapsed);
}

/**
 * Produce the current status for a workspace's session through the SessionSource
 * port: resolve → read → classify → derive data age and per-turn history.
 */
export async function readStatus(
  source: SessionSource,
  options: ReadStatusOptions,
): Promise<Status> {
  const session = await source.resolveSession({
    workspace: options.workspace,
    sessionId: options.sessionId,
  });
  if (session === null) {
    return {
      state: 'unknown',
      session: null,
      reason: `no session found for workspace ${options.workspace}`,
      lastGoodReading: null,
      dataAgeSeconds: null,
    };
  }

  const result = await source.currentReading(session);
  if (isReadingUnavailable(result)) {
    const referenceTimestamp = result.lastGoodReading?.timestamp ?? session.lastActivityAt;
    return {
      state: 'unknown',
      session,
      reason: result.reason,
      lastGoodReading: result.lastGoodReading,
      dataAgeSeconds: ageSeconds(referenceTimestamp, options.now),
    };
  }

  const zone = classifyZone(result.pct, options.thresholds);
  const history =
    source.usageHistory !== undefined ? await source.usageHistory(session) : [];
  // With no per-turn accounting (estimation fallback) the current reading is the
  // only sample — still deterministic, still labeled estimated.
  const effectiveHistory = history.length > 0 ? history : [result];
  return {
    state: 'ok',
    session,
    reading: result,
    zone,
    guidance: ZONE_GUIDANCE[zone],
    dataAgeSeconds: ageSeconds(result.timestamp, options.now),
    history: effectiveHistory,
    lastTransition: lastTransitionFromHistory(effectiveHistory, options.thresholds),
  };
}

// ── Deterministic burn / ETA derivations (design 1a ETA, 1c BURN + FORECAST) ──

/**
 * Average pct delta per turn over the last BURN_WINDOW_TURNS readings.
 * Null when fewer than two samples exist (no slope derivable).
 */
export function burnPerTurn(history: readonly UsageReading[]): number | null {
  const window = history.slice(-BURN_WINDOW_TURNS);
  const first = window.at(0);
  const last = window.at(-1);
  if (window.length < 2 || first === undefined || last === undefined) return null;
  return (last.pct - first.pct) / (window.length - 1);
}

/**
 * Turns until the red threshold at the current burn slope.
 * Null when the burn is unknown or not positive (usage stable or shrinking).
 */
export function turnsToRed(
  pct: number,
  burn: number | null,
  redThreshold: number,
): number | null {
  if (burn === null || burn <= 0) return null;
  if (pct >= redThreshold) return 0;
  return Math.ceil((redThreshold - pct) / burn);
}

/**
 * Average seconds per turn over the burn window, from transcript timestamps.
 * Null when fewer than two samples exist or the span is not positive.
 */
export function secondsPerTurn(history: readonly UsageReading[]): number | null {
  const window = history.slice(-BURN_WINDOW_TURNS);
  const first = window.at(0);
  const last = window.at(-1);
  if (window.length < 2 || first === undefined || last === undefined) return null;
  const spanSeconds = (Date.parse(last.timestamp) - Date.parse(first.timestamp)) / 1000;
  if (!(spanSeconds > 0)) return null;
  return spanSeconds / (window.length - 1);
}

/** The pct series feeding the sparkline / history columns (last N samples). */
export function sparklineSamples(
  history: readonly UsageReading[],
  samples: number = SPARKLINE_SAMPLES,
): number[] {
  return history.slice(-samples).map((reading) => reading.pct);
}

// ── JSON output contracts (`status --json`, `watch` NDJSON) — Principle V ─────

/** `baton context status --json`, ok state. `lastTransition` is wired by US2 (T035). */
export const statusOkReportSchema = z.object({
  state: z.literal('ok'),
  reading: usageReadingSchema,
  zone: zoneNameSchema,
  guidance: z.string().min(1),
  dataAgeSeconds: z.number().int().min(0),
  lastTransition: z
    .object({
      from: zoneOrUnknownSchema,
      to: zoneNameSchema,
      direction: z.enum(['escalation', 'de-escalation']),
    })
    .optional(),
});
export type StatusOkReport = z.infer<typeof statusOkReportSchema>;

/**
 * `baton context status --json`, unknown state (FR-011). STRICT: any extra key —
 * a zone, a reading — fails validation, proving nothing is ever fabricated.
 */
export const statusUnknownReportSchema = z.strictObject({
  state: z.literal('unknown'),
  reason: z.string().min(1),
  lastGoodReading: usageReadingSchema.nullable(),
  dataAgeSeconds: z.number().int().min(0).nullable(),
});
export type StatusUnknownReport = z.infer<typeof statusUnknownReportSchema>;

export const statusReportSchema = z.discriminatedUnion('state', [
  statusOkReportSchema,
  statusUnknownReportSchema,
]);
export type StatusReport = z.infer<typeof statusReportSchema>;

/** Shape a pipeline Status into the `status --json` contract document. */
export function toStatusReport(status: Status): StatusReport {
  if (status.state === 'ok') {
    const report: StatusOkReport = {
      state: 'ok',
      reading: status.reading,
      zone: status.zone,
      guidance: status.guidance,
      dataAgeSeconds: status.dataAgeSeconds,
    };
    if (status.lastTransition !== null) {
      report.lastTransition = {
        from: status.lastTransition.from,
        to: status.lastTransition.to,
        direction: status.lastTransition.direction,
      };
    }
    return report;
  }
  return {
    state: 'unknown',
    reason: status.reason,
    lastGoodReading: status.lastGoodReading,
    dataAgeSeconds: status.dataAgeSeconds,
  };
}

/** `watch` NDJSON: one reading event per refresh that produced a (new) reading. */
export const watchReadingEventSchema = z.strictObject({
  event: z.literal('reading'),
  reading: usageReadingSchema,
  zone: zoneNameSchema,
});
export type WatchReadingEvent = z.infer<typeof watchReadingEventSchema>;

/**
 * `watch` NDJSON: explicit unavailable event — carries no zone and no fabricated
 * reading (FR-011); `lastGoodReading` is the stream's own last emitted reading.
 */
export const watchUnavailableEventSchema = z.strictObject({
  event: z.literal('reading_unavailable'),
  unavailable: readingUnavailableSchema,
});
export type WatchUnavailableEvent = z.infer<typeof watchUnavailableEventSchema>;

/**
 * `watch` NDJSON: one `zone_transition` per boundary change — the FINAL zone only
 * on multi-band jumps (FR-005) — carrying the canonical guidance for the entered
 * zone (US2, T035).
 */
export const watchTransitionEventSchema = z.strictObject({
  event: z.literal('zone_transition'),
  transition: zoneTransitionSchema,
  guidance: z.string().min(1),
});
export type WatchTransitionEvent = z.infer<typeof watchTransitionEventSchema>;

/**
 * `watch` NDJSON: a pending recommendation with its mandatory trigger (FR-006).
 * Dismissed recommendations are never re-emitted while the zone is unchanged
 * (FR-014).
 */
export const watchRecommendationEventSchema = z.strictObject({
  event: z.literal('recommendation'),
  recommendation: recommendationSchema,
});
export type WatchRecommendationEvent = z.infer<typeof watchRecommendationEventSchema>;

/** Every event the `watch` NDJSON stream may emit (contract-test union). */
export const watchEventSchema = z.discriminatedUnion('event', [
  watchReadingEventSchema,
  watchUnavailableEventSchema,
  watchTransitionEventSchema,
  watchRecommendationEventSchema,
]);
export type WatchEvent = z.infer<typeof watchEventSchema>;
