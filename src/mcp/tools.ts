// Feature 002 T013/T014 — US1 tool handlers: context_status + context_config.
// Feature 002 T017 — US2 tool handler: context_catchup.
// Feature 002 T020/T022 — US3 tool handlers: context_scan + context_save.
// Feature 002 T024 — US4 tool handler: context_handoff.
//
// Thin over the feature-001 pipelines (FR-003: one behavior, two surfaces): the
// reader pipeline (SessionSource → reading/unavailable + zone + guidance + data
// age), the config loader/report, for catch-up — the pure replay (T004) plus the
// feature-001 recommendation engine and persisted dismissal bookkeeping, for
// US3 — the deterministic scanner + rule registry and the artifact store, and
// for US4 — the feature-001 handoff assembly/render/write, the exact code paths
// behind the CLI's `status --json`, `config show --json`, `watch`,
// `scan --json`, `save --json`, and `handoff --json`, so values cannot drift
// between surfaces. Results are the CLI --json shapes serialized COMPACT
// (single line, research R5) to stay inside the SC-003 budget.
//
// Read tools are side-effect-free and idempotent (FR-005): nothing here writes —
// not session data, not workspace content, not bookkeeping (catch-up cursors are
// in-memory per connection; .baton/state.json is only READ here). The persisting
// context_save and context_handoff execute ONLY behind the WriteGate (T021):
// without --allow-writes they return the structured Decline and touch nothing;
// when they do execute, each appends exactly one audit entry (FR-014). Unknown
// usage returns the explicit unknown state with reason + last-good age, never a
// fabricated zone (FR-008); a nonexistent or unreadable session-data root
// returns a structured configuration error, never fabricated data (spec edge
// case) and never a silent failure (contract "Errors").
import { accessSync, constants, statSync } from 'node:fs';
import { join } from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { resolveClaudeDir } from '../adapters/claude-code/paths.js';
import { createClaudeCodeSessionSource } from '../adapters/claude-code/session-source.js';
import type { PlannedArtifact } from '../core/artifacts/store.js';
import { saveArtifacts, saveReportSchema } from '../core/artifacts/store.js';
import { loadConfig, toConfigReport } from '../core/config/loader.js';
import type { HandoffMeta } from '../core/handoff/summary.js';
import {
  assembleHandoff,
  handoffRelativePath,
  handoffReportSchema,
  readSavedArtifacts,
  renderHandoffMarkdown,
  verifyArtifacts,
  writeHandoffFile,
} from '../core/handoff/summary.js';
import { HEURISTIC_RULES, ruleById, rulesForCategories } from '../core/heuristics/rules.js';
import type { ScanReport } from '../core/heuristics/scanner.js';
import {
  blockForSpan,
  findMatch,
  scanContent,
  scanFingerprint,
  scanReportSchema,
} from '../core/heuristics/scanner.js';
import type { ArtifactCandidate, HeuristicRule } from '../core/heuristics/types.js';
import { ruleCategorySchema } from '../core/heuristics/types.js';
import { readStatus, toStatusReport } from '../core/monitor/reader.js';
import {
  isDismissed,
  recommendationForTransition,
} from '../core/monitor/recommendations.js';
import type { ScanBlock } from '../core/monitor/session-source.js';
import { loadMonitorState } from '../core/monitor/state.js';
import type { Recommendation, SessionRef } from '../core/monitor/types.js';
import { advanceCheckCursor } from './cursors.js';
import { appendAuditEntry, checkWriteGate } from './gating.js';
import type { CatchupReport } from './registry.js';
import type { Connection, ToolHandlers } from './server.js';

// ── Result shaping ────────────────────────────────────────────────────────────

/** Compact single-line JSON result (research R5 — the budget is the product). */
function jsonResult(payload: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

/** Structured tool error naming the problem — never a silent failure (FR-011). */
function errorResult(error: string, reason: string): CallToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify({ error, reason }) }],
  };
}

/**
 * Spec edge case: a server started against a nonexistent or unreadable
 * session-data root must report a clear configuration error rather than serve
 * fabricated data (a missing root is a setup problem, not "no session yet").
 * Returns the structured error, or null when the root is a readable directory.
 */
function dataRootProblem(connection: Connection): CallToolResult | null {
  const root = resolveClaudeDir(connection.claudeDir);
  try {
    if (!statSync(root).isDirectory()) throw new Error('not a directory');
    accessSync(root, constants.R_OK | constants.X_OK);
    return null;
  } catch {
    return errorResult(
      'data-root-unreadable',
      `session data root ${root} does not exist or is not readable — point BATON_CLAUDE_DIR at your agent's session data directory`,
    );
  }
}

// ── Deterministic scan run (shared by context_scan and context_save) ──────────

/** One full deterministic scan of the connection's session (read-only). */
interface ScanRun {
  session: SessionRef;
  blocks: ScanBlock[];
  rules: readonly HeuristicRule[];
  candidates: ArtifactCandidate[];
  fingerprint: string;
}

/**
 * Resolve the connection's active session and scan its content with the given
 * rules — the same adapter content extraction + feature-001 scanner behind the
 * CLI's `scan`/`save` (FR-003; no clock, no randomness — identical content ⇒
 * identical candidates and fingerprint). Returns a structured error result when
 * no session exists (contract `no-session`).
 */
async function runScan(
  connection: Connection,
  rules: readonly HeuristicRule[],
): Promise<{ run: ScanRun } | { error: CallToolResult }> {
  const source = createClaudeCodeSessionSource({ claudeDir: connection.claudeDir });
  const session = await source.resolveSession({ workspace: connection.workspace });
  if (session === null) {
    return {
      error: errorResult(
        'no-session',
        `no session found for workspace ${connection.workspace}`,
      ),
    };
  }
  const blocks = await source.contentForScan(session);
  const candidates = scanContent({ sessionId: session.id, blocks, rules });
  return {
    run: { session, blocks, rules, candidates, fingerprint: scanFingerprint(candidates) },
  };
}

/** Candidate + display context → the artifact store's planned input (as the CLI). */
function planCandidate(
  blocks: readonly ScanBlock[],
  candidate: ArtifactCandidate,
  rule: HeuristicRule,
): PlannedArtifact {
  const located = blockForSpan(blocks, candidate.span);
  const match = findMatch(rule, candidate.excerpt);
  return {
    candidate,
    rule,
    matchedPhrase: match === null ? null : match.phrase.toLowerCase(),
    turn: located === null ? null : located.turn,
    turnTimestamp: located?.block.timestamp ?? null,
  };
}

// ── Handlers (attached to the registry surface by src/mcp/server.ts) ──────────

/**
 * Build the capability handlers for one server instance. US1: context_status
 * (T013) and context_config (T014); US2: context_catchup (T017); later user
 * stories extend this map.
 */
export function createToolHandlers(): ToolHandlers {
  return {
    // T013 — same values as `baton context status --json` for identical state.
    context_status: async (_args, connection) => {
      const problem = dataRootProblem(connection);
      if (problem !== null) return problem;
      // Invalid workspace config is tolerated exactly like the CLI (FR-011):
      // defaults classify here, the named violations surface via context_config.
      const config = loadConfig(connection.workspace);
      const source = createClaudeCodeSessionSource({ claudeDir: connection.claudeDir });
      const status = await readStatus(source, {
        workspace: connection.workspace,
        thresholds: config.thresholds,
        now: new Date(), // injected clock, same as the CLI — core never reads it
      });
      return jsonResult(toStatusReport(status));
    },

    // T017 — deterministic replay since this connection's cursor (research R4):
    // adapter usage history → pure replay → transitions (multi-band jumps already
    // collapsed, FR-009); pending advisory via the feature-001 recommendation
    // engine, honoring dismissals persisted in the shared .baton/state.json by
    // EITHER surface (FR-013). First call per session: snapshot — the standing
    // advisory for the current zone, no history. No clock, no writes.
    context_catchup: async (_args, connection) => {
      const problem = dataRootProblem(connection);
      if (problem !== null) return problem;
      const config = loadConfig(connection.workspace);
      const source = createClaudeCodeSessionSource({ claudeDir: connection.claudeDir });
      const session = await source.resolveSession({ workspace: connection.workspace });
      if (session === null) {
        return errorResult(
          'no-session',
          `no session found for workspace ${connection.workspace}`,
        );
      }
      const history =
        source.usageHistory !== undefined ? await source.usageHistory(session) : [];
      const advance = advanceCheckCursor(
        connection.cursors,
        session.id,
        history,
        config.thresholds,
      );

      // Currently-pending advisory: the one for the zone most recently entered
      // (the replay's last transition ends AT the current zone). Green entries
      // advise nothing; a dismissal recorded in the shared state file — by the
      // CLI or by this server — excludes it while the zone is unchanged (FR-014).
      // loadMonitorState is a pure READ: catch-up persists nothing.
      const pending: Recommendation[] = [];
      if (advance.lastTransition !== null) {
        const state = loadMonitorState(connection.workspace, session.id);
        const recommendation = recommendationForTransition(
          advance.lastTransition,
          config.thresholds,
        );
        if (
          recommendation !== null &&
          !isDismissed(state, recommendation.id, advance.lastTransition.to)
        ) {
          pending.push(recommendation);
        }
      }

      const report: CatchupReport = {
        sessionId: session.id,
        transitions: advance.transitions,
        pending,
        empty: advance.transitions.length === 0 && pending.length === 0,
      };
      return jsonResult(report);
    },

    // T020 — same values as `baton context scan --json` for identical content:
    // adapter content extraction → the deterministic feature-001 scanner, CLI
    // scan shape with the stable fingerprint (SC-004). Read-only — scanning
    // writes nothing, ever (FR-005).
    context_scan: async (args, connection) => {
      const problem = dataRootProblem(connection);
      if (problem !== null) return problem;
      const parsed = z.array(ruleCategorySchema).optional().safeParse(args['categories']);
      if (!parsed.success) {
        return errorResult(
          'invalid-params',
          `invalid categories — each must be one of ${ruleCategorySchema.options.join('|')}`,
        );
      }
      const outcome = await runScan(connection, rulesForCategories(parsed.data));
      if ('error' in outcome) return outcome.error;
      const { run } = outcome;
      const report: ScanReport = scanReportSchema.parse({
        sessionId: run.session.id,
        fingerprint: run.fingerprint,
        rulesChecked: run.rules.map((rule) => rule.id),
        candidates: run.candidates,
      });
      return jsonResult(report);
    },

    // T022 — `baton context save <id>…` behind the WriteGate (T021). Candidate
    // resolution comes from a FRESH deterministic scan over the full registry —
    // ids are stable hashes, so a rescan reproduces exactly the ids the model
    // saw from context_scan. Every id is validated BEFORE anything is written
    // (nothing partially written), only accepted candidates reach the feature-001
    // artifact store, and the one executed write appends the one audit entry
    // (FR-014).
    context_save: async (args, connection) => {
      // The gate first (FR-006): without the operator's --allow-writes
      // attestation the request is declined outright — nothing is read,
      // resolved, written, or audited. Absence of approval is a no.
      const gated = checkWriteGate(connection, 'context_save');
      if (gated !== null) return gated;

      const problem = dataRootProblem(connection);
      if (problem !== null) return problem;
      const parsed = z.array(z.string()).min(1).safeParse(args['candidateIds']);
      if (!parsed.success) {
        return errorResult(
          'invalid-params',
          'candidateIds must be a non-empty array of candidate ids from context_scan',
        );
      }
      const ids = parsed.data;

      const outcome = await runScan(connection, HEURISTIC_RULES);
      if ('error' in outcome) return outcome.error;
      const { run } = outcome;
      const byId = new Map(run.candidates.map((candidate) => [candidate.id, candidate]));

      // Validate EVERY id before writing ANYTHING — an unknown id fails the
      // whole request by name and leaves no file and no audit entry behind.
      const unknown = ids.filter((id) => !byId.has(id));
      if (unknown.length > 0) {
        return errorResult('invalid-params', `unknown candidate id: ${unknown.join(', ')}`);
      }

      const planned: PlannedArtifact[] = [];
      for (const id of ids) {
        const candidate = byId.get(id);
        /* v8 ignore next — unreachable after the unknown-id validation above */
        if (candidate === undefined) continue;
        const rule = ruleById(candidate.ruleId);
        /* v8 ignore next — every scanner candidate names a registry rule */
        if (rule === undefined) continue;
        planned.push(planCandidate(run.blocks, { ...candidate, status: 'accepted' }, rule));
      }

      // Single wall-clock read for the write, same as the CLI save command —
      // never on the read paths (determinism stays with core).
      const savedAt = new Date();
      const artifacts = saveArtifacts(connection.workspace, planned, savedAt);

      // FR-014: exactly one audit entry for this one executed write — candidate
      // ids, written paths, gate state; no session content.
      appendAuditEntry(connection.workspace, {
        timestamp: new Date().toISOString(), // when the write completed
        capability: 'context_save',
        detail: { candidateIds: ids },
        written: artifacts.map((artifact) => artifact.path),
        gate: 'allow-writes',
      });

      return jsonResult(
        saveReportSchema.parse({
          saved: artifacts.map((artifact) => ({
            candidateId: artifact.candidateId,
            path: artifact.path,
          })),
        }),
      );
    },

    // T024 — `baton context handoff` behind the WriteGate (T021): the SAME
    // feature-001 assembly (task state, decisions, open questions, artifact
    // refs — every item carrying its [source: …]) and the SAME renderer as the
    // CLI, so the file cannot drift between surfaces (SC-004). The tool takes
    // NO path parameter: the write lands at the default `.baton/handoff/` path
    // only — the model cannot direct writes elsewhere (contract). One write,
    // one audit entry (FR-014).
    context_handoff: async (_args, connection) => {
      // The gate first (FR-006): without the operator's --allow-writes
      // attestation the request is declined outright — nothing is read,
      // assembled, written, or audited. Absence of approval is a no.
      const gated = checkWriteGate(connection, 'context_handoff');
      if (gated !== null) return gated;

      const problem = dataRootProblem(connection);
      if (problem !== null) return problem;

      // Invalid workspace config is tolerated exactly like the CLI (FR-011):
      // defaults classify here, the named violations surface via context_config.
      const config = loadConfig(connection.workspace);

      // Single wall-clock read for the write, same as the CLI handoff command
      // (meta timestamp == file name stamp) — never on the read paths.
      const now = new Date();
      const source = createClaudeCodeSessionSource({ claudeDir: connection.claudeDir });
      const status = await readStatus(source, {
        workspace: connection.workspace,
        thresholds: config.thresholds,
        now,
      });
      const session = status.session;
      if (session === null) {
        return errorResult(
          'no-session',
          `no session found for workspace ${connection.workspace}`,
        );
      }

      const blocks = await source.contentForScan(session);
      const artifacts = readSavedArtifacts(connection.workspace, session.id);
      const draft = await assembleHandoff({
        sessionId: session.id,
        blocks,
        rules: [...HEURISTIC_RULES],
        artifacts,
      });

      const meta: HandoffMeta = {
        workspacePath: connection.workspace,
        writtenAtIso: now.toISOString(),
        reading: status.state === 'ok' ? status.reading : null,
        zone: status.state === 'ok' ? status.zone : null,
        turns: blocks.length,
        verification: verifyArtifacts(connection.workspace, artifacts),
      };
      const relativePath = handoffRelativePath(meta.writtenAtIso);
      writeHandoffFile(
        join(connection.workspace, relativePath),
        renderHandoffMarkdown(draft, meta),
      ); // the single write

      // FR-014: exactly one audit entry for this one executed write — output
      // path, written paths, gate state; no session content.
      appendAuditEntry(connection.workspace, {
        timestamp: new Date().toISOString(), // when the write completed
        capability: 'context_handoff',
        detail: { outputPath: relativePath },
        written: [relativePath],
        gate: 'allow-writes',
      });

      return jsonResult(
        handoffReportSchema.parse({
          path: relativePath,
          sessionId: session.id,
          artifactCount: draft.artifactRefs.length,
        }),
      );
    },

    // T014 — same report as `baton context config show --json` (FR-011).
    context_config: async (_args, connection) =>
      jsonResult(toConfigReport(loadConfig(connection.workspace))),
  };
}
