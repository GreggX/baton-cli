// Feature 002 T006 — static capability registry (data-model.md "Capability").
//
// One table drives everything: server registration (T007), the contract tests'
// listing-and-canon audit (T010/T025), and the parity obligation's 1:1 mapping.
// Descriptions are CANONICAL — they MUST equal contracts/mcp-tools.md verbatim
// (FR-010, research R6; a contract test asserts the served strings). Result
// schemas are the feature-001 zod schemas: one shape, two surfaces (FR-003).
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { saveReportSchema } from '../core/artifacts/store.js';
import { configReportSchema } from '../core/config/schema.js';
import { handoffReportSchema } from '../core/handoff/summary.js';
import { ruleCategorySchema } from '../core/heuristics/types.js';
import { scanReportSchema } from '../core/heuristics/scanner.js';
import { statusReportSchema } from '../core/monitor/reader.js';
import { recommendationSchema, zoneTransitionSchema } from '../core/monitor/types.js';

// ── CatchupReport (data-model.md — the serving layer's own result shape) ──────

/**
 * The answer to "what changed since I last checked?" (FR-009). Transitions come
 * from the pure replay (multi-band jumps already collapsed); `pending` holds
 * currently-pending recommendations only (user dismissals excluded while the zone
 * is unchanged); `empty: true` ⇒ both arrays empty, within the SC-003 budget.
 */
export const catchupReportSchema = z.object({
  sessionId: z.string(),
  transitions: z.array(zoneTransitionSchema),
  pending: z.array(recommendationSchema),
  empty: z.boolean(),
});
export type CatchupReport = z.infer<typeof catchupReportSchema>;

// ── Capability table ──────────────────────────────────────────────────────────

/** The six exposed tools — 1:1 with specs/mcp-parity-obligation.md (research R2). */
export const CAPABILITY_NAMES = [
  'context_status',
  'context_catchup',
  'context_scan',
  'context_save',
  'context_handoff',
  'context_config',
] as const;
export type CapabilityName = (typeof CAPABILITY_NAMES)[number];

/** One exposed tool (data-model.md Capability). */
export interface Capability {
  name: CapabilityName;
  /** canonical, incl. the when-to-use clause — equals contracts/mcp-tools.md VERBATIM */
  description: string;
  /** read ⇒ side-effect-free, idempotent, no approval; persisting ⇒ write-gated */
  classification: 'read' | 'persisting';
  /** read: read-only + idempotent hints; persisting: non-read-only so hosts prompt */
  annotations: ToolAnnotations;
  /** zod raw shape served as the tool's input schema (empty ⇒ no params) */
  inputSchema: z.ZodRawShape;
  /** the corresponding CLI --json zod schema from src/core/ (FR-003) */
  resultSchema: z.ZodType;
}

/** Hints for the side-effect-free tools: hosts may call freely, no approval needed. */
export const READ_ANNOTATIONS: ToolAnnotations = Object.freeze({
  readOnlyHint: true,
  idempotentHint: true,
  openWorldHint: false,
});

/** Hints for the write-gated tools: NOT read-only, so hosts prompt per request (R3). */
export const PERSISTING_ANNOTATIONS: ToolAnnotations = Object.freeze({
  readOnlyHint: false,
  openWorldHint: false,
});

/**
 * The static registry. Order matches the parity obligation's capability table.
 * Tool handlers are attached by the serving layer (src/mcp/tools.ts, US1–US4);
 * this table carries everything else so contracts and tests can audit it.
 */
export const CAPABILITIES: readonly Capability[] = Object.freeze([
  {
    name: 'context_status',
    description:
      'Read the current context health of this session: zone (green/yellow/orange/red), usage percentage, and what to do about it. Cheap — check whenever unsure, and always before pasting large content.',
    classification: 'read',
    annotations: READ_ANNOTATIONS,
    inputSchema: {},
    resultSchema: statusReportSchema,
  },
  {
    name: 'context_catchup',
    description:
      'What changed since you last checked: zone transitions and pending recommendations, each with its trigger. Returns an explicit empty result when nothing changed — cheap to call routinely.',
    classification: 'read',
    annotations: READ_ANNOTATIONS,
    inputSchema: {},
    resultSchema: catchupReportSchema,
  },
  {
    name: 'context_scan',
    description:
      'Deterministically scan this session for passages worth saving as artifacts (decisions, conclusions, constraints, results, tasks, questions). Use in orange or red before recommending compaction. Read-only.',
    classification: 'read',
    annotations: READ_ANNOTATIONS,
    inputSchema: { categories: z.array(ruleCategorySchema).optional() },
    resultSchema: scanReportSchema,
  },
  {
    name: 'context_save',
    description:
      'Request saving scanned candidates as workspace artifacts. Requires explicit user approval; nothing is written if declined. Propose only candidates the user would plausibly want kept.',
    classification: 'persisting',
    annotations: PERSISTING_ANNOTATIONS,
    inputSchema: { candidateIds: z.array(z.string()).min(1) },
    resultSchema: saveReportSchema,
  },
  {
    name: 'context_handoff',
    description:
      'Request generation of a handoff summary file so a fresh session can resume this work. Requires explicit user approval. Recommend this in red.',
    classification: 'persisting',
    annotations: PERSISTING_ANNOTATIONS,
    inputSchema: {},
    resultSchema: handoffReportSchema,
  },
  {
    name: 'context_config',
    description:
      'Read the effective zone thresholds and their source (file or defaults), including any configuration problems. Read-only.',
    classification: 'read',
    annotations: READ_ANNOTATIONS,
    inputSchema: {},
    resultSchema: configReportSchema,
  },
]);

/** Look up one capability by name (the table is the single source of truth). */
export function capabilityByName(name: CapabilityName): Capability {
  const capability = CAPABILITIES.find((entry) => entry.name === name);
  /* v8 ignore next 3 — CAPABILITY_NAMES and CAPABILITIES are the same static table */
  if (capability === undefined) {
    throw new Error(`unknown capability: ${name}`);
  }
  return capability;
}
