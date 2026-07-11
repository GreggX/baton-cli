// T040 — Deterministic heuristic scanner (FR-008, FR-012, SC-005).
//
// Pure function `(sessionId, blocks, rules) → ArtifactCandidate[]`: no IO, no
// clock, no randomness, no network — identical content and registry yield a
// byte-identical candidate list. Excerpts are trimmed to sentence bounds, spans
// point at the containing block's transcript lines, and candidate ids are the
// stable derivation hash(sessionId, ruleId, span) so rescans re-produce the
// same ids (`c-` + first 12 hex of sha256 — deterministic, not random).
//
// Also home of the scan report zod schema (the `--json` contract shared with
// the future MCP surface) and the deterministic scan fingerprint (design 3c):
// a stable hash of the candidate list, checkable at a glance across reruns.
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ScanBlock } from '../monitor/session-source.js';
import type { ArtifactCandidate, HeuristicRule, Span } from './types.js';
import { artifactCandidateSchema } from './types.js';

// ── Stable candidate ids ──────────────────────────────────────────────────────

/** Deterministic candidate id: `c-` + first 12 hex of sha256(sessionId, ruleId, span). */
export function candidateId(sessionId: string, ruleId: string, span: Span): string {
  const digest = createHash('sha256')
    .update(JSON.stringify([sessionId, ruleId, span.startLine, span.endLine]))
    .digest('hex');
  return `c-${digest.slice(0, 12)}`;
}

// ── Pattern matching ──────────────────────────────────────────────────────────

/** One rule-pattern hit inside a text: the matched substring and where it starts. */
export interface RuleMatch {
  /** exact matched text, verbatim from the input */
  phrase: string;
  /** 0-based index of the match in the input text */
  index: number;
}

const regexCache = new Map<string, RegExp>();

function patternRegex(source: string): RegExp {
  let regex = regexCache.get(source);
  if (regex === undefined) {
    regex = new RegExp(source, 'i'); // case-insensitive phrases / regex sources
    regexCache.set(source, regex);
  }
  return regex;
}

/**
 * Earliest match of any of the rule's patterns in `text`, or null.
 * Ties resolve by pattern order — fully deterministic.
 */
export function findMatch(rule: HeuristicRule, text: string): RuleMatch | null {
  let best: RuleMatch | null = null;
  for (const source of rule.patterns) {
    const match = patternRegex(source).exec(text);
    if (match === null) continue;
    if (best === null || match.index < best.index) {
      best = { phrase: match[0], index: match.index };
    }
  }
  return best;
}

// ── Sentence splitting (excerpts are sentence-bound) ──────────────────────────

/** Split text into trimmed sentences: newline first, then ./!/? boundaries. */
export function splitSentences(text: string): string[] {
  const sentences: string[] = [];
  for (const line of text.split('\n')) {
    for (const part of line.split(/(?<=[.!?])\s+/)) {
      const trimmed = part.trim();
      if (trimmed !== '') sentences.push(trimmed);
    }
  }
  return sentences;
}

// ── The scanner ───────────────────────────────────────────────────────────────

export interface ScanContentOptions {
  /** owning session — part of every candidate's id derivation */
  sessionId: string;
  /** session content in stable order (adapter-provided, FR-012) */
  blocks: readonly ScanBlock[];
  /** ordered rule registry (possibly category-filtered) */
  rules: readonly HeuristicRule[];
}

/**
 * Scan session content with the given rules. Order-stable: blocks in content
 * order, rules in registry order, at most one candidate per (block, rule) —
 * the first matching sentence wins. Same input ⇒ byte-identical output.
 */
export function scanContent(options: ScanContentOptions): ArtifactCandidate[] {
  const { sessionId, blocks, rules } = options;
  const candidates: ArtifactCandidate[] = [];
  for (const block of blocks) {
    const sentences = splitSentences(block.text);
    for (const rule of rules) {
      for (const sentence of sentences) {
        if (findMatch(rule, sentence) === null) continue;
        const span: Span = { startLine: block.startLine, endLine: block.endLine };
        candidates.push(
          artifactCandidateSchema.parse({
            id: candidateId(sessionId, rule.id, span),
            sessionId,
            ruleId: rule.id,
            excerpt: sentence,
            span,
            status: 'surfaced',
          }),
        );
        break; // one candidate per (block, rule): first matching sentence
      }
    }
  }
  return candidates;
}

// ── Scan fingerprint (design 3c) ──────────────────────────────────────────────

/**
 * Deterministic short fingerprint of a candidate list — stable hash, first 6
 * hex of sha256 over the serialized candidates. No clock in the hash: identical
 * rescans are checkable at a glance (`fingerprint a3f2c9`).
 */
export function scanFingerprint(candidates: readonly ArtifactCandidate[]): string {
  return createHash('sha256').update(JSON.stringify(candidates)).digest('hex').slice(0, 6);
}

// ── Span → block/turn lookup (display + provenance) ───────────────────────────

export interface LocatedBlock {
  /** 1-based conversation turn (index of the block in the scanned content) */
  turn: number;
  block: ScanBlock;
}

/** The scanned block containing a span, with its 1-based turn number. */
export function blockForSpan(
  blocks: readonly ScanBlock[],
  span: Span,
): LocatedBlock | null {
  for (const [index, block] of blocks.entries()) {
    if (block.startLine <= span.startLine && block.endLine >= span.endLine) {
      return { turn: index + 1, block };
    }
  }
  return null;
}

// ── `baton context scan --json` contract schema ───────────────────────────────

/** Contract shape of `baton context scan --json` (contracts/cli-interface.md). */
export const scanReportSchema = z.object({
  sessionId: z.string(),
  /** deterministic fingerprint of the candidate list (design 3c) */
  fingerprint: z.string().regex(/^[0-9a-f]{6}$/),
  /** ids of every rule checked (post --category filter), registry order */
  rulesChecked: z.array(z.string()),
  candidates: z.array(artifactCandidateSchema),
});
export type ScanReport = z.infer<typeof scanReportSchema>;
