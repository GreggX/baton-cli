// T031 — Recommendation lifecycle (US2, FR-006/FR-014): deterministic ids,
// zone → kind mapping, guidance embedding the trigger explanation, pending →
// dismissed bookkeeping, no re-issue while the zone is unchanged, re-arm on zone
// exit and on escalation.
import { describe, expect, it } from 'vitest';
import { DEFAULT_THRESHOLDS } from '../../src/core/config/schema.js';
import {
  ZONE_RECOMMENDATION_KINDS,
  advanceMonitor,
  dismiss,
  isDismissed,
  rearmDismissals,
  recommendationForTransition,
  zoneRecommendationId,
} from '../../src/core/monitor/recommendations.js';
import { detectTransition } from '../../src/core/monitor/transitions.js';
import type { MonitorState, UsageReading, ZoneTransition } from '../../src/core/monitor/types.js';
import { ZONE_GUIDANCE } from '../../src/core/monitor/zones.js';

function reading(pct: number, sessionId = 's-rec'): UsageReading {
  return {
    sessionId,
    tokensUsed: Math.round(pct * 2000),
    contextWindow: 200_000,
    pct,
    precision: 'exact',
    timestamp: '2026-07-02T18:00:00.000Z',
  };
}

function transitionTo(
  from: 'unknown' | 'green' | 'yellow' | 'orange' | 'red',
  pct: number,
  sessionId = 's-rec',
): ZoneTransition {
  const transition = detectTransition(from, reading(pct, sessionId), DEFAULT_THRESHOLDS);
  if (transition === null) throw new Error('expected a transition');
  return transition;
}

function emptyState(sessionId = 's-rec'): MonitorState {
  return { sessionId, lastZone: 'unknown', dismissals: [] };
}

describe('zone → recommendation kind mapping', () => {
  it('yellow → favor_retrieval, orange → compact, red → new_session', () => {
    expect(ZONE_RECOMMENDATION_KINDS).toEqual({
      yellow: 'favor_retrieval',
      orange: 'compact',
      red: 'new_session',
    });
    expect(recommendationForTransition(transitionTo('green', 45), DEFAULT_THRESHOLDS, 35)?.kind).toBe(
      'favor_retrieval',
    );
    expect(recommendationForTransition(transitionTo('yellow', 68), DEFAULT_THRESHOLDS, 45)?.kind).toBe(
      'compact',
    );
    expect(recommendationForTransition(transitionTo('orange', 80), DEFAULT_THRESHOLDS, 68)?.kind).toBe(
      'new_session',
    );
  });

  it('de-escalation into green (recovery) produces no recommendation', () => {
    expect(recommendationForTransition(transitionTo('orange', 30), DEFAULT_THRESHOLDS, 78)).toBeNull();
  });

  it('recommendations start pending with a mandatory zone_transition trigger (FR-006)', () => {
    const transition = transitionTo('yellow', 68);
    const recommendation = recommendationForTransition(transition, DEFAULT_THRESHOLDS, 45);
    expect(recommendation?.state).toBe('pending');
    expect(recommendation?.trigger).toEqual({ kind: 'zone_transition', transition });
  });
});

describe('guidance embeds the trigger explanation (FR-006)', () => {
  it('names the zone, every crossed threshold, the new pct, and the canonical guidance', () => {
    const recommendation = recommendationForTransition(
      transitionTo('green', 68),
      DEFAULT_THRESHOLDS,
      35,
    );
    expect(recommendation?.guidance).toContain('orange');
    expect(recommendation?.guidance).toContain('crossed 40% & 60%');
    expect(recommendation?.guidance).toContain('now 68%');
    expect(recommendation?.guidance).toContain(ZONE_GUIDANCE.orange);
  });

  it('single-boundary escalation names its threshold', () => {
    const recommendation = recommendationForTransition(
      transitionTo('orange', 80),
      DEFAULT_THRESHOLDS,
      68,
    );
    expect(recommendation?.guidance).toContain('crossed 75%');
    expect(recommendation?.guidance).toContain(ZONE_GUIDANCE.red);
  });
});

describe('deterministic recommendation ids (FR-014 bookkeeping)', () => {
  it('same zone entry → same id, regardless of the entered-from zone or reading', () => {
    const a = recommendationForTransition(transitionTo('green', 68), DEFAULT_THRESHOLDS, 35);
    const b = recommendationForTransition(transitionTo('yellow', 70), DEFAULT_THRESHOLDS, 45);
    expect(a?.id).toBeDefined();
    expect(a?.id).toBe(b?.id);
    expect(a?.id).toBe(zoneRecommendationId('s-rec', 'orange'));
  });

  it('different zones and different sessions → different ids', () => {
    expect(zoneRecommendationId('s-rec', 'orange')).not.toBe(zoneRecommendationId('s-rec', 'red'));
    expect(zoneRecommendationId('s-rec', 'orange')).not.toBe(
      zoneRecommendationId('s-other', 'orange'),
    );
  });
});

describe('dismissal API (FR-014)', () => {
  const id = zoneRecommendationId('s-rec', 'orange');
  const dismissed = dismiss(emptyState(), id, 'orange', '2026-07-02T19:00:00.000Z');

  it('dismiss records {recommendationId, zone, dismissedAt}', () => {
    expect(dismissed.dismissals).toEqual([
      { recommendationId: id, zone: 'orange', dismissedAt: '2026-07-02T19:00:00.000Z' },
    ]);
  });

  it('dismissing the same id twice keeps one record', () => {
    const twice = dismiss(dismissed, id, 'orange', '2026-07-02T19:05:00.000Z');
    expect(twice.dismissals).toHaveLength(1);
  });

  it('stays dismissed while the session remains in the same zone', () => {
    expect(isDismissed(dismissed, id, 'orange')).toBe(true);
  });

  it('re-arms on zone exit (de-escalation)', () => {
    expect(isDismissed(dismissed, id, 'yellow')).toBe(false);
    expect(rearmDismissals(dismissed, 'yellow').dismissals).toEqual([]);
  });

  it('re-arms on escalation to a higher zone', () => {
    expect(isDismissed(dismissed, id, 'red')).toBe(false);
    expect(rearmDismissals(dismissed, 'red').dismissals).toEqual([]);
  });

  it('rearmDismissals keeps dismissals belonging to the current zone', () => {
    expect(rearmDismissals(dismissed, 'orange').dismissals).toHaveLength(1);
  });
});

describe('advanceMonitor over a session lifecycle', () => {
  it('one notice per crossing; dismissed advice is not re-issued while the zone is unchanged; re-arm on exit', () => {
    // attach: unknown → green (no advice in green)
    const a1 = advanceMonitor({ state: emptyState(), reading: reading(25), thresholds: DEFAULT_THRESHOLDS });
    expect(a1.transition?.from).toBe('unknown');
    expect(a1.transition?.to).toBe('green');
    expect(a1.recommendation).toBeNull();
    expect(a1.state.lastZone).toBe('green');

    // multi-band jump green → orange: exactly one transition + the compact advice
    const a2 = advanceMonitor({ state: a1.state, reading: reading(68), thresholds: DEFAULT_THRESHOLDS, fromPct: 25 });
    expect(a2.transition?.from).toBe('green');
    expect(a2.transition?.to).toBe('orange');
    expect(a2.recommendation?.kind).toBe('compact');
    if (a2.recommendation === null) throw new Error('expected a recommendation');

    // further growth inside orange: silent (one notice per crossing)
    const a3 = advanceMonitor({ state: a2.state, reading: reading(69), thresholds: DEFAULT_THRESHOLDS, fromPct: 68 });
    expect(a3.transition).toBeNull();
    expect(a3.recommendation).toBeNull();

    // dismiss the orange advice: no re-issue while the session stays orange
    const dismissedState = dismiss(a3.state, a2.recommendation.id, 'orange', '2026-07-02T19:00:00.000Z');
    const a4 = advanceMonitor({ state: dismissedState, reading: reading(70), thresholds: DEFAULT_THRESHOLDS, fromPct: 69 });
    expect(a4.transition).toBeNull();
    expect(a4.recommendation).toBeNull();
    expect(a4.state.dismissals).toHaveLength(1); // still bookkept while in orange

    // leaving the zone re-arms: dismissal pruned, yellow advice issued
    const a5 = advanceMonitor({ state: a4.state, reading: reading(45), thresholds: DEFAULT_THRESHOLDS, fromPct: 70 });
    expect(a5.transition?.direction).toBe('de-escalation');
    expect(a5.recommendation?.kind).toBe('favor_retrieval');
    expect(a5.state.dismissals).toEqual([]);

    // re-entering orange re-issues the SAME deterministic id (re-armed)
    const a6 = advanceMonitor({ state: a5.state, reading: reading(68), thresholds: DEFAULT_THRESHOLDS, fromPct: 45 });
    expect(a6.recommendation?.id).toBe(a2.recommendation.id);
  });

  it('re-arms when the persisted lastZone proves the dismissal zone was exited while unmonitored', () => {
    // dismissed in orange; the session dropped to yellow while the monitor was off
    const state: MonitorState = {
      sessionId: 's-rec',
      lastZone: 'yellow',
      dismissals: [
        {
          recommendationId: zoneRecommendationId('s-rec', 'orange'),
          zone: 'orange',
          dismissedAt: '2026-07-02T19:00:00.000Z',
        },
      ],
    };
    const advance = advanceMonitor({ state, reading: reading(68), thresholds: DEFAULT_THRESHOLDS, fromPct: 45 });
    expect(advance.transition?.to).toBe('orange');
    expect(advance.recommendation?.kind).toBe('compact'); // re-armed, not suppressed
  });

  it('restart continuity: persisted lastZone equal to the current zone stays fully silent', () => {
    const state: MonitorState = { sessionId: 's-rec', lastZone: 'orange', dismissals: [] };
    const advance = advanceMonitor({ state, reading: reading(69), thresholds: DEFAULT_THRESHOLDS });
    expect(advance.transition).toBeNull();
    expect(advance.recommendation).toBeNull();
    expect(advance.state.lastZone).toBe('orange');
  });
});
