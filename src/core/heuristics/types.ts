// T012 — Heuristics/artifact entity schemas per data-model.md:
// HeuristicRule (six categories), ArtifactCandidate, Artifact (+frontmatter),
// HandoffSummary sections.
import { z } from 'zod';

/** ISO datetime string ("2026-07-02T18:04:11Z" or with numeric offset). */
const isoDatetime = z.iso.datetime({ offset: true });

// ── Rule categories ───────────────────────────────────────────────────────────

/** The six heuristic rule categories (data-model.md HeuristicRule). */
export const ruleCategorySchema = z.enum([
  'decision',
  'conclusion',
  'constraint',
  'result',
  'task',
  'question',
]);
export type RuleCategory = z.infer<typeof ruleCategorySchema>;

// ── Span ──────────────────────────────────────────────────────────────────────

/** Location in session content (FR-008). */
export const spanSchema = z.object({
  startLine: z.number().int(),
  endLine: z.number().int(),
});
export type Span = z.infer<typeof spanSchema>;

// ── HeuristicRule ─────────────────────────────────────────────────────────────

export const heuristicRuleSchema = z.object({
  /** unique, stable (e.g., `decision.agreed-to`) */
  id: z.string().min(1),
  category: ruleCategorySchema,
  /** human-readable, shown with every match (FR-006) */
  description: z.string(),
  /** case-insensitive phrases / anchored regex sources */
  patterns: z.array(z.string()).min(1),
});
export type HeuristicRule = z.infer<typeof heuristicRuleSchema>;

// ── ArtifactCandidate ─────────────────────────────────────────────────────────

export const candidateStatusSchema = z.enum(['surfaced', 'accepted', 'rejected']);
export type CandidateStatus = z.infer<typeof candidateStatusSchema>;

export const artifactCandidateSchema = z.object({
  /** deterministic: hash(sessionId, ruleId, span) — stable across rescans */
  id: z.string(),
  sessionId: z.string(),
  /** FK -> HeuristicRule.id (FR-008) */
  ruleId: z.string(),
  /** matched passage, trimmed to sentence bounds */
  excerpt: z.string(),
  span: spanSchema,
  status: candidateStatusSchema,
});
export type ArtifactCandidate = z.infer<typeof artifactCandidateSchema>;

// ── Artifact ──────────────────────────────────────────────────────────────────

/** Provenance frontmatter of a saved artifact — plain YAML, human-readable. */
export const artifactFrontmatterSchema = z.object({
  sessionId: z.string(),
  ruleId: z.string(),
  category: ruleCategorySchema,
  span: spanSchema,
  savedAt: isoDatetime,
});
export type ArtifactFrontmatter = z.infer<typeof artifactFrontmatterSchema>;

/** Accepted candidate persisted to the workspace. */
export const artifactSchema = z.object({
  /** `.baton/artifacts/<timestamp>-<ruleId>-<slug>.md` */
  path: z.string(),
  /** provenance */
  candidateId: z.string(),
  frontmatter: artifactFrontmatterSchema,
});
export type Artifact = z.infer<typeof artifactSchema>;

// ── HandoffSummary ────────────────────────────────────────────────────────────

export const handoffSectionsSchema = z.object({
  decisions: z.array(
    z.object({
      text: z.string(),
      source: z.string(),
    }),
  ),
  taskState: z.object({
    summary: z.string(),
    sources: z.array(z.string()),
  }),
  openQuestions: z.array(
    z.object({
      text: z.string(),
      ruleId: z.string(),
      span: spanSchema,
    }),
  ),
  /** paths of saved artifacts referenced by the summary */
  artifactRefs: z.array(z.string()),
});
export type HandoffSections = z.infer<typeof handoffSectionsSchema>;

/** Written only on explicit request (FR-010); available in any zone. */
export const handoffSummarySchema = z.object({
  /** `.baton/handoff/<timestamp>-handoff.md` */
  path: z.string(),
  /** source session */
  sessionId: z.string(),
  sections: handoffSectionsSchema,
});
export type HandoffSummary = z.infer<typeof handoffSummarySchema>;
