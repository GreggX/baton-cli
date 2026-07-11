// T039 — Initial heuristic rule registry (FR-008, FR-012).
//
// 12 deterministic verb/phrase rules across the six categories from
// data-model.md (decision, conclusion, constraint, result, task, question).
// Ids are stable (`<category>.<slug>`), descriptions are shown with every match
// (FR-006 — every candidate names the rule that surfaced it), and patterns are
// case-insensitive phrases / anchored regex sources evaluated in registry order.
// The registry is ordered data, not code: scanning it is a pure function.
import type { HeuristicRule, RuleCategory } from './types.js';
import { heuristicRuleSchema } from './types.js';

/**
 * Per-category display colors for rule pills (design 3a/3b).
 * decision/conclusion/constraint/result are verbatim from the vendored design
 * (accent blue/purple/teal/cyan); task and question extend the same Tokyo Night
 * palette (zone-yellow accent and text) since the mockups only showed four.
 */
export const CATEGORY_COLORS: Readonly<Record<RuleCategory, string>> = Object.freeze({
  decision: '#7aa2f7',
  conclusion: '#bb9af7',
  constraint: '#73daca',
  result: '#2ac3de',
  task: '#e0af68',
  question: '#c0caf5',
});

const rules: HeuristicRule[] = [
  // ── decision ────────────────────────────────────────────────────────────────
  {
    id: 'decision.agreed-to',
    category: 'decision',
    description: 'An agreement was reached in the conversation',
    patterns: ['we agreed', 'agreed to', 'agreed on'],
  },
  {
    id: 'decision.decided-to',
    category: 'decision',
    description: 'A decision was made in the conversation',
    patterns: ['we decided', 'decided to', 'settled on', "we'll go with"],
  },
  // ── conclusion ──────────────────────────────────────────────────────────────
  {
    id: 'conclusion.root-cause',
    category: 'conclusion',
    description: 'A root cause was identified',
    patterns: ['root cause', 'turns out to be', 'turned out to be'],
  },
  {
    id: 'conclusion.confirmed',
    category: 'conclusion',
    description: 'A finding was confirmed or concluded',
    patterns: ['confirmed that', 'we confirmed', 'concluded that'],
  },
  // ── constraint ──────────────────────────────────────────────────────────────
  {
    id: 'constraint.must',
    category: 'constraint',
    description: 'A hard requirement or restriction was stated',
    patterns: ['must not', 'must be', 'must stay', 'cannot exceed', 'is required to'],
  },
  {
    id: 'constraint.limited-to',
    category: 'constraint',
    description: 'An external limit or cap was discovered',
    patterns: ['limited to', 'capped at', 'rate-limit', 'rate limit', 'at most'],
  },
  // ── result ──────────────────────────────────────────────────────────────────
  {
    id: 'result.measured',
    category: 'result',
    description: 'A measured performance result was produced',
    patterns: ['p95', 'p99', 'latency', 'throughput', 'benchmark'],
  },
  {
    id: 'result.tests-passing',
    category: 'result',
    description: 'A test outcome was reported',
    patterns: ['tests passing', 'tests pass', 'test suite passes', 'all tests green'],
  },
  // ── task ────────────────────────────────────────────────────────────────────
  {
    id: 'task.next-step',
    category: 'task',
    description: 'A next step or remaining piece of work was stated',
    patterns: ['next step', 'remaining task', 'still need to', 'still needs to'],
  },
  {
    id: 'task.todo',
    category: 'task',
    description: 'An open TODO was recorded',
    patterns: ['todo:', 'to-do:', 'follow-up:'],
  },
  // ── question ────────────────────────────────────────────────────────────────
  {
    id: 'question.should-we',
    category: 'question',
    description: 'An open should-we question was raised',
    patterns: ['should we'],
  },
  {
    id: 'question.open-question',
    category: 'question',
    description: 'An explicitly open question was flagged',
    patterns: ['open question', 'unresolved question', 'unanswered question'],
  },
];

/** The ordered rule registry — same registry + same content ⇒ identical candidates. */
export const HEURISTIC_RULES: readonly HeuristicRule[] = Object.freeze(
  rules.map((rule) => heuristicRuleSchema.parse(rule)),
);

/** Look a rule up by its stable id. */
export function ruleById(id: string): HeuristicRule | undefined {
  return HEURISTIC_RULES.find((rule) => rule.id === id);
}

/**
 * Registry subset for the given categories, in registry order.
 * `undefined` or empty ⇒ the full registry (scan default: all categories).
 */
export function rulesForCategories(
  categories: readonly RuleCategory[] | undefined,
): HeuristicRule[] {
  if (categories === undefined || categories.length === 0) return [...HEURISTIC_RULES];
  const wanted = new Set<RuleCategory>(categories);
  return HEURISTIC_RULES.filter((rule) => wanted.has(rule.category));
}
