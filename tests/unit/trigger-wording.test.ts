// T058 — Trigger-wording audit (FR-006, SC-003): 100% of recommendations and
// notifications name their trigger — the zone and threshold(s) crossed, or the
// heuristic rule that matched. This test enumerates EVERY producer of
// recommendation/notification copy and audits the generated strings:
//
//   - zone-transition recommendations (src/core/monitor/recommendations.ts)
//     over every (from → to) zone pair, both directions, incl. unknown attach;
//   - save-candidate recommendations (src/core/heuristics/proactive.ts)
//     for every rule in the registry (src/core/heuristics/rules.ts);
//   - transition banner titles/subtitles and the watch event-log summaries
//     (crossingSummary/transitionSubtitle — the notification copy in watch).
import { describe, expect, it } from 'vitest';
import { DEFAULT_THRESHOLDS } from '../../src/core/config/schema.js';
import {
  saveCandidateGuidance,
  saveCandidateRecommendation,
} from '../../src/core/heuristics/proactive.js';
import { HEURISTIC_RULES } from '../../src/core/heuristics/rules.js';
import { scanContent } from '../../src/core/heuristics/scanner.js';
import type { ArtifactCandidate } from '../../src/core/heuristics/types.js';
import { recommendationForTransition } from '../../src/core/monitor/recommendations.js';
import {
  crossedThresholds,
  crossingSummary,
  detectTransition,
  transitionSubtitle,
} from '../../src/core/monitor/transitions.js';
import type { UsageReading, ZoneName, ZoneOrUnknown } from '../../src/core/monitor/types.js';
import { ZONE_GUIDANCE } from '../../src/core/monitor/zones.js';

const ZONES: readonly ZoneName[] = ['green', 'yellow', 'orange', 'red'];
const FROM_ZONES: readonly ZoneOrUnknown[] = ['unknown', ...ZONES];

/** A pct comfortably inside each zone (defaults 40/60/75). */
const ZONE_PCT: Readonly<Record<ZoneName, number>> = {
  green: 25,
  yellow: 45,
  orange: 68,
  red: 80,
};

function reading(pct: number): UsageReading {
  return {
    sessionId: 's-audit',
    tokensUsed: Math.round(pct * 2000),
    contextWindow: 200_000,
    pct,
    precision: 'exact',
    timestamp: '2026-07-02T18:00:00.000Z',
  };
}

describe('zone-transition recommendations name zone + every threshold crossed (FR-006)', () => {
  for (const from of FROM_ZONES) {
    for (const to of ZONES) {
      if (from === to) continue;
      it(`${from} → ${to}`, () => {
        const transition = detectTransition(from, reading(ZONE_PCT[to]), DEFAULT_THRESHOLDS);
        if (transition === null) throw new Error('expected a transition');
        const fromPct = from === 'unknown' ? null : ZONE_PCT[from as ZoneName];
        const recommendation = recommendationForTransition(
          transition,
          DEFAULT_THRESHOLDS,
          fromPct,
        );

        if (to === 'green') {
          // Recovery is a quiet stamp, never advice to act — no recommendation.
          expect(recommendation).toBeNull();
          return;
        }
        if (recommendation === null) throw new Error('expected a recommendation');

        // Mandatory trigger object (FR-006: no untriggered recommendations).
        expect(recommendation.trigger).toEqual({ kind: 'zone_transition', transition });
        // Names the zone entered…
        expect(recommendation.guidance).toContain(to);
        // …every threshold whose boundary was crossed, as an explicit `NN%`…
        for (const threshold of crossedThresholds(from, to, DEFAULT_THRESHOLDS)) {
          expect(recommendation.guidance).toContain(`${String(threshold)}%`);
        }
        // …and the canonical guidance for that zone.
        expect(recommendation.guidance).toContain(ZONE_GUIDANCE[to]);
      });
    }
  }
});

describe('save-candidate recommendations name their rule id (FR-006/FR-015)', () => {
  // Drive every registry rule through the REAL scanner so the audit covers the
  // exact strings users see: one block per rule, first pattern as the content.
  for (const rule of HEURISTIC_RULES) {
    it(rule.id, () => {
      const pattern = rule.patterns[0];
      if (pattern === undefined) throw new Error(`rule ${rule.id} has no patterns`);
      const candidates = scanContent({
        sessionId: 's-audit',
        blocks: [
          {
            role: 'assistant',
            text: `For the audit we note that ${pattern} applies to this passage.`,
            startLine: 1,
            endLine: 1,
            timestamp: null,
          },
        ],
        rules: [rule],
      });
      const candidate: ArtifactCandidate | undefined = candidates[0];
      if (candidate === undefined) throw new Error(`rule ${rule.id} did not match its own pattern`);

      const recommendation = saveCandidateRecommendation(candidate, rule);
      // Mandatory rule_match trigger naming rule AND candidate (FR-006).
      expect(recommendation.trigger).toEqual({
        kind: 'rule_match',
        ruleId: rule.id,
        candidateId: candidate.id,
      });
      // The visible guidance names the rule id and the transcript location.
      expect(recommendation.guidance).toContain(rule.id);
      expect(recommendation.guidance).toMatch(/line \d+/);
      expect(saveCandidateGuidance(candidate, rule)).toContain(rule.id);
    });
  }

  it('every registry rule carries a human-readable description (shown with matches)', () => {
    for (const rule of HEURISTIC_RULES) {
      expect(rule.description.length, rule.id).toBeGreaterThan(0);
      expect(rule.id).toMatch(/^[a-z]+\.[a-z-]+$/);
      expect(rule.id.startsWith(`${rule.category}.`), `${rule.id} category prefix`).toBe(true);
    }
  });
});

describe('watch notification copy names zone/thresholds (FR-005/FR-006, design 2a/2b)', () => {
  it('escalation summaries name every threshold crossed', () => {
    const transition = detectTransition('green', reading(68), DEFAULT_THRESHOLDS);
    if (transition === null) throw new Error('expected a transition');
    expect(crossingSummary(transition, DEFAULT_THRESHOLDS, 35)).toBe('crossed 40% & 60%');
    expect(transitionSubtitle(transition, DEFAULT_THRESHOLDS, 35)).toBe(
      'crossed 40% & 60% · now 68%',
    );
  });

  it('drop summaries carry the compaction movement (design copy verbatim)', () => {
    const transition = detectTransition('red', reading(30), DEFAULT_THRESHOLDS);
    if (transition === null) throw new Error('expected a transition');
    expect(crossingSummary(transition, DEFAULT_THRESHOLDS, 78)).toBe('compaction 78% → 30%');
  });
});
