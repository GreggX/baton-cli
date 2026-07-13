// Feature 002 T021 — WriteGate + Decline responses + audit writer (US3/US4).
//
// The Principle II enforcement for the persisting capabilities (research R3,
// data-model.md WriteGate/Decline/AuditEntry):
//
//   - WITHOUT the operator's `--allow-writes` attestation, a persisting tool
//     returns the structured Decline — reason plus the EXACT CLI command that
//     performs the same action — and executes NOTHING. Absence of approval is
//     always a no (FR-006). Declines write nothing: no artifact, no state, no
//     audit entry, so the no-write guarantee stays byte-exact (T019).
//   - Every write a persisting capability actually EXECUTES appends exactly one
//     entry to the append-only, plain-text `.baton/audit.log` (FR-014): one JSON
//     line with timestamp, capability, what was written (candidate ids or output
//     path), the workspace paths created, and the gate state that admitted it.
//     Audit entries carry NO session content — ids, paths, timestamps only (the
//     same exemption discipline as MonitorState) — and never leave the machine.
//     Read tools never touch the log.
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { Connection } from './server.js';

/** The two write-gated capabilities (data-model.md Capability: persisting). */
export type PersistingCapability = 'context_save' | 'context_handoff';

// ── Decline (data-model.md — returned by persisting tools when gated) ─────────

export const declineSchema = z.object({
  declined: z.literal(true),
  reason: z.string(),
  /** the exact CLI command performing the same action + how to enable writes */
  instructions: z.string(),
});
export type Decline = z.infer<typeof declineSchema>;

/** The one decline reason this gate produces (contracts/mcp-tools.md). */
export const WRITES_DISABLED = 'writes-disabled';

/**
 * Per-capability CLI instructions — contracts/mcp-tools.md VERBATIM for save;
 * handoff follows the same canonical pattern with its own CLI command.
 */
const CLI_INSTRUCTIONS: Readonly<Record<PersistingCapability, string>> = Object.freeze({
  context_save:
    'Ask the user to run: baton context save <id>… — or restart the server with baton mcp --allow-writes',
  context_handoff:
    'Ask the user to run: baton context handoff — or restart the server with baton mcp --allow-writes',
});

/** Build the structured Decline result for a gated persisting capability. */
export function declineResult(capability: PersistingCapability): CallToolResult {
  const decline: Decline = {
    declined: true,
    reason: WRITES_DISABLED,
    instructions: CLI_INSTRUCTIONS[capability],
  };
  return { content: [{ type: 'text', text: JSON.stringify(decline) }] };
}

/**
 * The WriteGate: null ⇒ the write may proceed (the host prompted for this
 * request under the operator's standing `--allow-writes` attestation); a
 * CallToolResult ⇒ the Decline to return INSTEAD of executing anything.
 * Callers check the gate before reading, resolving, or writing a single byte.
 */
export function checkWriteGate(
  connection: Connection,
  capability: PersistingCapability,
): CallToolResult | null {
  return connection.allowWrites ? null : declineResult(capability);
}

// ── AuditEntry (persisted, append-only `.baton/audit.log`, FR-014) ────────────

/** Workspace-relative location of the audit log — the tool's own bookkeeping. */
export const AUDIT_LOG_RELATIVE_PATH = join('.baton', 'audit.log');

/** Absolute audit log path for a workspace. */
export function auditLogPath(workspace: string): string {
  return join(workspace, AUDIT_LOG_RELATIVE_PATH);
}

/** One executed persisting operation (data-model.md AuditEntry). */
export const auditEntrySchema = z.object({
  /** ISO datetime — when the write completed */
  timestamp: z.iso.datetime({ offset: true }),
  capability: z.enum(['context_save', 'context_handoff']),
  /** candidateIds for saves; output path for handoffs — ids/paths, never content */
  detail: z.union([
    z.object({ candidateIds: z.array(z.string()) }),
    z.object({ outputPath: z.string() }),
  ]),
  /** workspace-relative paths created by the write */
  written: z.array(z.string()),
  /** the gate state that admitted the write */
  gate: z.literal('allow-writes'),
});
export type AuditEntry = z.infer<typeof auditEntrySchema>;

/**
 * Append ONE audit entry — one plain-text JSON line — for ONE executed write.
 * Invoked ONLY after a persisting capability actually performed its write;
 * declines and read tools never call this (their trees stay byte-identical).
 * The entry is schema-validated first, so a malformed record can never land.
 */
export function appendAuditEntry(workspace: string, entry: AuditEntry): void {
  const path = auditLogPath(workspace);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(auditEntrySchema.parse(entry))}\n`);
}
