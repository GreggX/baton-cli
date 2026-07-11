// T038 — Unit tests for the heuristic rule registry (T039) and the deterministic
// scanner (T040), constitution-mandated and written FIRST (FR-012, SC-005):
//   - determinism: two scans of the same content are deep-equal AND byte-identical
//     once serialized; the fingerprint is stable
//   - per-category rule matching across all six categories
//   - excerpts trimmed to sentence bounds
//   - correct transcript line spans
//   - stable candidate ids hash(sessionId, ruleId, span) with the `c-` prefix
import { describe, expect, it } from 'vitest';
import {
  CATEGORY_COLORS,
  HEURISTIC_RULES,
  ruleById,
  rulesForCategories,
} from '../../src/core/heuristics/rules.js';
import {
  blockForSpan,
  candidateId,
  findMatch,
  scanContent,
  scanFingerprint,
} from '../../src/core/heuristics/scanner.js';
import { heuristicRuleSchema, ruleCategorySchema } from '../../src/core/heuristics/types.js';
import type { ScanBlock } from '../../src/core/monitor/session-source.js';

const SESSION = 'session-heuristics-test';

function block(text: string, role: 'user' | 'assistant', line: number): ScanBlock {
  return { role, text, startLine: line, endLine: line };
}

describe('heuristic rule registry (T039)', () => {
  it('holds 10–14 schema-valid rules with unique, stable ids', () => {
    expect(HEURISTIC_RULES.length).toBeGreaterThanOrEqual(10);
    expect(HEURISTIC_RULES.length).toBeLessThanOrEqual(14);
    for (const rule of HEURISTIC_RULES) heuristicRuleSchema.parse(rule);
    const ids = HEURISTIC_RULES.map((rule) => rule.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('covers all six categories and ids read <category>.<slug>', () => {
    const categories = new Set(HEURISTIC_RULES.map((rule) => rule.category));
    expect([...categories].sort()).toEqual(
      ['conclusion', 'constraint', 'decision', 'question', 'result', 'task'].sort(),
    );
    for (const rule of HEURISTIC_RULES) {
      expect(rule.id.startsWith(`${rule.category}.`)).toBe(true);
      expect(rule.description.length).toBeGreaterThan(0);
      expect(rule.patterns.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('includes the canonical decision.agreed-to and question.should-we rules', () => {
    expect(ruleById('decision.agreed-to')).toBeDefined();
    expect(ruleById('question.should-we')).toBeDefined();
    expect(ruleById('nope.never')).toBeUndefined();
  });

  it('assigns a display color to every category (design 3a/3b pills)', () => {
    for (const category of ruleCategorySchema.options) {
      expect(CATEGORY_COLORS[category]).toMatch(/^#[0-9a-f]{6}$/);
    }
    // Colors from the vendored design: decision blue, conclusion purple,
    // constraint teal, result cyan.
    expect(CATEGORY_COLORS.decision).toBe('#7aa2f7');
    expect(CATEGORY_COLORS.conclusion).toBe('#bb9af7');
    expect(CATEGORY_COLORS.constraint).toBe('#73daca');
    expect(CATEGORY_COLORS.result).toBe('#2ac3de');
  });

  it('rulesForCategories filters in registry order and defaults to all', () => {
    expect(rulesForCategories(undefined)).toEqual([...HEURISTIC_RULES]);
    const decisions = rulesForCategories(['decision']);
    expect(decisions.length).toBeGreaterThan(0);
    for (const rule of decisions) expect(rule.category).toBe('decision');
  });
});

describe('deterministic scanner (T040)', () => {
  const blocks: ScanBlock[] = [
    block('Which storage layout should the artifacts use eventually.', 'user', 1),
    block(
      'We decided to use the adapter approach for session discovery, keeping agent-specific knowledge behind one seam.',
      'assistant',
      2,
    ),
    block('And what did the flaky refresh investigation find.', 'user', 3),
    block(
      'The root cause of the flaky refresh turns out to be the missing debounce, so we agreed to keep the 500ms debounce in the watcher.',
      'assistant',
      4,
    ),
  ];

  it('two scans over the same content are deep-equal AND byte-identical', () => {
    const first = scanContent({ sessionId: SESSION, blocks, rules: HEURISTIC_RULES });
    const second = scanContent({ sessionId: SESSION, blocks, rules: HEURISTIC_RULES });
    expect(first.length).toBeGreaterThan(0);
    expect(second).toEqual(first);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first)); // byte-identical (FR-012)
    expect(scanFingerprint(second)).toBe(scanFingerprint(first));
    expect(scanFingerprint(first)).toMatch(/^[0-9a-f]{6}$/);
  });

  it('matches per category across all six categories', () => {
    const samples: { text: string; category: string }[] = [
      { text: 'We agreed to cap retries at three attempts.', category: 'decision' },
      { text: 'The root cause was clock skew between the services.', category: 'conclusion' },
      { text: 'The page size must stay below fifty items.', category: 'constraint' },
      { text: 'All 14 tests passing after the fix landed.', category: 'result' },
      { text: 'Next step: wire the estimation fallback into status.', category: 'task' },
      { text: 'Should we cap the polling interval at ten seconds?', category: 'question' },
    ];
    for (const [index, sample] of samples.entries()) {
      const found = scanContent({
        sessionId: SESSION,
        blocks: [block(sample.text, 'assistant', index + 1)],
        rules: HEURISTIC_RULES,
      });
      expect(found.length).toBeGreaterThanOrEqual(1);
      const rule = ruleById(found[0]?.ruleId ?? '');
      expect(rule?.category).toBe(sample.category);
    }
  });

  it('honors a filtered registry: only the given rules are checked', () => {
    const questionRules = rulesForCategories(['question']);
    const found = scanContent({ sessionId: SESSION, blocks, rules: questionRules });
    expect(found).toEqual([]); // the decision/conclusion content has no question matches
  });

  it('trims excerpts to sentence bounds', () => {
    const text =
      'The first sentence sets some plain context. We decided to use the adapter approach here. The last sentence trails off plainly.';
    const found = scanContent({
      sessionId: SESSION,
      blocks: [block(text, 'assistant', 9)],
      rules: rulesForCategories(['decision']),
    });
    expect(found).toHaveLength(1);
    expect(found[0]?.excerpt).toBe('We decided to use the adapter approach here.');
  });

  it('reports the transcript line span of the containing block', () => {
    const found = scanContent({
      sessionId: SESSION,
      blocks: [block('We decided to ship the adapter first.', 'assistant', 7)],
      rules: HEURISTIC_RULES,
    });
    expect(found).toHaveLength(1);
    expect(found[0]?.span).toEqual({ startLine: 7, endLine: 7 });
  });

  it('produces stable ids hash(sessionId, ruleId, span) with the c- prefix', () => {
    const span = { startLine: 2, endLine: 2 };
    const id = candidateId(SESSION, 'decision.decided-to', span);
    expect(id).toMatch(/^c-[0-9a-f]{12}$/);
    expect(candidateId(SESSION, 'decision.decided-to', { ...span })).toBe(id);
    // Any identity part changing changes the id.
    expect(candidateId('other-session', 'decision.decided-to', span)).not.toBe(id);
    expect(candidateId(SESSION, 'decision.agreed-to', span)).not.toBe(id);
    expect(candidateId(SESSION, 'decision.decided-to', { startLine: 3, endLine: 3 })).not.toBe(
      id,
    );
    // Scanner output uses exactly this derivation — stable across rescans.
    const found = scanContent({ sessionId: SESSION, blocks, rules: HEURISTIC_RULES });
    const decided = found.find((candidate) => candidate.ruleId === 'decision.decided-to');
    expect(decided?.id).toBe(id);
  });

  it('emits at most one candidate per (block, rule): first matching sentence wins', () => {
    const text =
      'We decided to use the adapter approach. Later we decided to keep the scanner pure.';
    const found = scanContent({
      sessionId: SESSION,
      blocks: [block(text, 'assistant', 5)],
      rules: rulesForCategories(['decision']),
    });
    expect(found).toHaveLength(1);
    expect(found[0]?.excerpt).toBe('We decided to use the adapter approach.');
  });

  it('one sentence can surface several rules — distinct ids, same span', () => {
    const found = scanContent({ sessionId: SESSION, blocks, rules: HEURISTIC_RULES });
    const atLine4 = found.filter((candidate) => candidate.span.startLine === 4);
    const ruleIds = atLine4.map((candidate) => candidate.ruleId).sort();
    expect(ruleIds).toEqual(['conclusion.root-cause', 'decision.agreed-to']);
    expect(new Set(atLine4.map((candidate) => candidate.id)).size).toBe(2);
  });

  it('surfaces everything as status "surfaced" and finds nothing in bland content', () => {
    const found = scanContent({ sessionId: SESSION, blocks, rules: HEURISTIC_RULES });
    for (const candidate of found) expect(candidate.status).toBe('surfaced');
    const bland = scanContent({
      sessionId: SESSION,
      blocks: [
        block('The source tree has a core directory and an adapters directory.', 'assistant', 1),
      ],
      rules: HEURISTIC_RULES,
    });
    expect(bland).toEqual([]);
  });

  it('findMatch returns the earliest matched phrase; blockForSpan maps spans to turns', () => {
    const rule = ruleById('decision.agreed-to');
    if (rule === undefined) throw new Error('expected rule');
    const match = findMatch(rule, 'so we agreed to keep the debounce');
    expect(match?.phrase.toLowerCase()).toBe('we agreed');
    expect(findMatch(rule, 'nothing to see here')).toBeNull();

    const located = blockForSpan(blocks, { startLine: 4, endLine: 4 });
    expect(located?.turn).toBe(4);
    expect(located?.block.role).toBe('assistant');
    expect(blockForSpan(blocks, { startLine: 99, endLine: 99 })).toBeNull();
  });
});
