// T048 — Proactive save-suggestion engine (US3, FR-015 + FR-014/FR-006):
//   - entering orange/red triggers a scan; green/yellow never do
//   - one save_candidate recommendation per candidate, each with a rule_match
//     trigger {ruleId, candidateId} and guidance naming the rule (FR-006)
//   - per-candidate dismissal honored: dismissing one never affects the others,
//     and a dismissed candidate is NEVER re-offered — even across zone changes
//   - candidates already saved (artifact frontmatter provenance) never re-offered
//   - new candidates from later in-zone activity are surfaced; already-offered
//     ones are not re-emitted
//   - the proactive scan path writes nothing (FR-007/SC-004)
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { saveArtifacts } from '../../src/core/artifacts/store.js';
import { DEFAULT_THRESHOLDS } from '../../src/core/config/schema.js';
import {
  PROACTIVE_ZONES,
  dismissCandidate,
  isCandidateDismissed,
  isProactiveZone,
  proactiveScan,
  saveSuggestionsPendingLine,
  savedCandidateIds,
} from '../../src/core/heuristics/proactive.js';
import { HEURISTIC_RULES, ruleById } from '../../src/core/heuristics/rules.js';
import { candidateId, scanContent } from '../../src/core/heuristics/scanner.js';
import { advanceMonitor, recommendationId } from '../../src/core/monitor/recommendations.js';
import type { ScanBlock } from '../../src/core/monitor/session-source.js';
import type { MonitorState, UsageReading } from '../../src/core/monitor/types.js';

const SESSION = 's-proactive';

function block(text: string, startLine: number): ScanBlock {
  return {
    role: 'assistant',
    text,
    startLine,
    endLine: startLine,
    timestamp: '2026-07-02T18:50:05.000Z',
  };
}

// Two decision-phrase blocks (initial content) + one later-activity block.
const decidedBlock = block('We decided to use the adapter approach for session discovery.', 4);
const agreedBlock = block('After review we agreed to keep the core free of adapter imports.', 8);
const questionBlock = block('Open question: whether the window map needs a config override.', 12);

const baseBlocks: ScanBlock[] = [decidedBlock, agreedBlock];

const decidedId = candidateId(SESSION, 'decision.decided-to', { startLine: 4, endLine: 4 });
const agreedId = candidateId(SESSION, 'decision.agreed-to', { startLine: 8, endLine: 8 });
const questionId = candidateId(SESSION, 'question.open-question', {
  startLine: 12,
  endLine: 12,
});

function stateInZone(lastZone: MonitorState['lastZone'] = 'orange'): MonitorState {
  return { sessionId: SESSION, lastZone, dismissals: [] };
}

function reading(pct: number): UsageReading {
  return {
    sessionId: SESSION,
    tokensUsed: Math.round(pct * 2000),
    contextWindow: 200_000,
    pct,
    precision: 'exact',
    timestamp: '2026-07-02T18:00:00.000Z',
  };
}

describe('zone gating (FR-015): the scan runs in orange/red only', () => {
  it('green and yellow never trigger a scan', () => {
    for (const zone of ['green', 'yellow'] as const) {
      expect(isProactiveZone(zone)).toBe(false);
      const result = proactiveScan({
        sessionId: SESSION,
        zone,
        blocks: baseBlocks,
        rules: HEURISTIC_RULES,
        state: stateInZone(zone),
      });
      expect(result).toEqual({ scanned: false, candidates: [], recommendations: [] });
    }
  });

  it('entering orange or red triggers the scan', () => {
    expect(PROACTIVE_ZONES).toEqual(['orange', 'red']);
    for (const zone of PROACTIVE_ZONES) {
      expect(isProactiveZone(zone)).toBe(true);
      const result = proactiveScan({
        sessionId: SESSION,
        zone,
        blocks: baseBlocks,
        rules: HEURISTIC_RULES,
        state: stateInZone(zone),
      });
      expect(result.scanned).toBe(true);
      expect(result.candidates.map((candidate) => candidate.id)).toEqual([decidedId, agreedId]);
    }
  });
});

describe('per-candidate save_candidate recommendations (FR-006/FR-015)', () => {
  it('emits one recommendation per candidate with a rule_match trigger {ruleId, candidateId}', () => {
    const result = proactiveScan({
      sessionId: SESSION,
      zone: 'orange',
      blocks: baseBlocks,
      rules: HEURISTIC_RULES,
      state: stateInZone(),
    });
    expect(result.recommendations).toHaveLength(2);
    const [first, second] = result.recommendations;
    if (first === undefined || second === undefined) throw new Error('expected two offers');

    expect(first.kind).toBe('save_candidate');
    expect(first.state).toBe('pending');
    expect(first.trigger).toEqual({
      kind: 'rule_match',
      ruleId: 'decision.decided-to',
      candidateId: decidedId,
    });
    expect(second.kind).toBe('save_candidate');
    expect(second.trigger).toEqual({
      kind: 'rule_match',
      ruleId: 'decision.agreed-to',
      candidateId: agreedId,
    });

    // Guidance names the rule that fired — explainable, never untriggered (FR-006).
    expect(first.guidance).toContain('decision.decided-to');
    expect(second.guidance).toContain('decision.agreed-to');

    // Deterministic id: hash(sessionId, kind, trigger identity).
    expect(first.id).toBe(recommendationId(SESSION, 'save_candidate', first.trigger));
    expect(first.id).not.toBe(second.id);
  });

  it('is deterministic: identical input ⇒ byte-identical output', () => {
    const run = (): unknown =>
      proactiveScan({
        sessionId: SESSION,
        zone: 'red',
        blocks: baseBlocks,
        rules: HEURISTIC_RULES,
        state: stateInZone('red'),
      });
    expect(JSON.stringify(run())).toBe(JSON.stringify(run()));
  });
});

describe('per-candidate dismissal (FR-014): honored and never re-offered', () => {
  it('a dismissed candidate is filtered; the others are unaffected', () => {
    const state = dismissCandidate(stateInZone(), decidedId, '2026-07-02T19:00:00.000Z');
    expect(isCandidateDismissed(state, decidedId)).toBe(true);
    expect(isCandidateDismissed(state, agreedId)).toBe(false);

    const result = proactiveScan({
      sessionId: SESSION,
      zone: 'orange',
      blocks: baseBlocks,
      rules: HEURISTIC_RULES,
      state,
    });
    expect(result.candidates.map((candidate) => candidate.id)).toEqual([agreedId]);
    expect(result.recommendations.map((offer) => offer.trigger)).toEqual([
      { kind: 'rule_match', ruleId: 'decision.agreed-to', candidateId: agreedId },
    ]);
  });

  it('dismissing the same candidate twice keeps one record', () => {
    const once = dismissCandidate(stateInZone(), decidedId, '2026-07-02T19:00:00.000Z');
    const twice = dismissCandidate(once, decidedId, '2026-07-02T19:05:00.000Z');
    expect(twice.dismissedCandidates).toHaveLength(1);
  });

  it('stays dismissed across zone changes — candidate dismissals never re-arm', () => {
    const dismissed = dismissCandidate(stateInZone(), decidedId, '2026-07-02T19:00:00.000Z');

    // Escalate orange → red: zone advisories re-arm, candidate dismissals must not.
    const advance = advanceMonitor({
      state: dismissed,
      reading: reading(80),
      thresholds: DEFAULT_THRESHOLDS,
      fromPct: 68,
    });
    expect(advance.zone).toBe('red');
    expect(isCandidateDismissed(advance.state, decidedId)).toBe(true);

    const result = proactiveScan({
      sessionId: SESSION,
      zone: 'red',
      blocks: baseBlocks,
      rules: HEURISTIC_RULES,
      state: advance.state,
    });
    expect(result.candidates.map((candidate) => candidate.id)).toEqual([agreedId]);
  });
});

describe('saved candidates never re-offered (artifact frontmatter provenance)', () => {
  let workspace: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'baton-proactive-'));
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  /** Persist the "we decided" candidate as a real artifact via the store. */
  function saveDecidedArtifact(): void {
    const rule = ruleById('decision.decided-to');
    if (rule === undefined) throw new Error('missing rule decision.decided-to');
    const [candidate] = scanContent({
      sessionId: SESSION,
      blocks: [decidedBlock],
      rules: [rule],
    });
    if (candidate === undefined) throw new Error('expected the decided candidate');
    saveArtifacts(
      workspace,
      [
        {
          candidate: { ...candidate, status: 'accepted' },
          rule,
          matchedPhrase: 'we decided',
          turn: 1,
          turnTimestamp: '2026-07-02T18:50:05.000Z',
        },
      ],
      '2026-07-02T19:05:00.000Z',
    );
  }

  it('recomputes candidate ids from saved artifact frontmatter, per session', () => {
    saveDecidedArtifact();
    expect(savedCandidateIds(workspace, SESSION)).toEqual(new Set([decidedId]));
    // Provenance is per-session: other sessions are unaffected.
    expect(savedCandidateIds(workspace, 's-other').size).toBe(0);
  });

  it('no artifacts directory ⇒ nothing saved (and nothing created)', () => {
    expect(savedCandidateIds(workspace, SESSION).size).toBe(0);
    expect(readdirSync(workspace)).toEqual([]);
  });

  it('a saved candidate is filtered out of the offers', () => {
    saveDecidedArtifact();
    const result = proactiveScan({
      sessionId: SESSION,
      zone: 'orange',
      blocks: baseBlocks,
      rules: HEURISTIC_RULES,
      state: stateInZone(),
      savedCandidateIds: savedCandidateIds(workspace, SESSION),
    });
    expect(result.candidates.map((candidate) => candidate.id)).toEqual([agreedId]);
    expect(result.recommendations).toHaveLength(1);
  });
});

describe('later in-zone activity (FR-015)', () => {
  it('surfaces new candidates; already-offered ones are not re-emitted', () => {
    const first = proactiveScan({
      sessionId: SESSION,
      zone: 'orange',
      blocks: baseBlocks,
      rules: HEURISTIC_RULES,
      state: stateInZone(),
    });
    const offered = new Set(
      first.recommendations.flatMap((offer) =>
        offer.trigger.kind === 'rule_match' ? [offer.trigger.candidateId] : [],
      ),
    );
    expect(offered).toEqual(new Set([decidedId, agreedId]));

    const second = proactiveScan({
      sessionId: SESSION,
      zone: 'orange',
      blocks: [...baseBlocks, questionBlock],
      rules: HEURISTIC_RULES,
      state: stateInZone(),
      offeredCandidateIds: offered,
    });
    // The full offerable set still lists all three candidates…
    expect(second.candidates.map((candidate) => candidate.id)).toEqual([
      decidedId,
      agreedId,
      questionId,
    ]);
    // …but only the NEW candidate produces a recommendation event.
    expect(second.recommendations.map((offer) => offer.trigger)).toEqual([
      { kind: 'rule_match', ruleId: 'question.open-question', candidateId: questionId },
    ]);
  });
});

describe('read-only guarantee: the proactive scan path writes nothing', () => {
  it('leaves the workspace untouched (FR-007/SC-004)', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'baton-proactive-ro-'));
    try {
      proactiveScan({
        sessionId: SESSION,
        zone: 'red',
        blocks: [...baseBlocks, questionBlock],
        rules: HEURISTIC_RULES,
        state: stateInZone('red'),
        savedCandidateIds: savedCandidateIds(workspace, SESSION),
      });
      expect(readdirSync(workspace)).toEqual([]);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});

describe('aggregated pending line (watch TTY display)', () => {
  it('matches the canonical copy and pluralizes the count', () => {
    expect(saveSuggestionsPendingLine(3)).toBe(
      '3 save suggestions pending — [a] review [d] dismiss',
    );
    expect(saveSuggestionsPendingLine(1)).toBe(
      '1 save suggestion pending — [a] review [d] dismiss',
    );
  });
});
