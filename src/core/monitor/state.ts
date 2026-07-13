// T034 — MonitorState persistence (`.baton/state.json`).
// Tool bookkeeping only — session id, lastZone, dismissal records. Never session
// content (data-model invariant), which keeps this automatic write inside the
// FR-007/SC-004 exemption: it is the ONLY unprompted write the tool performs.
//
// State is per-session: a different persisted session id means a fresh state.
// Corrupt or missing file ⇒ empty state (transitions re-detected; worst case one
// duplicate notification — acceptable, never data loss).
//
// Feature 002 T005 (FR-013, research R9): the CLI and the MCP server share this
// file on one workspace, so writes are ATOMIC — write a temp file, rename it over
// state.json. Rename is atomic on POSIX: every observable file state is a complete
// document and concurrent writers settle last-writer-wins. Readers already tolerate
// a mid-rename absence (missing file ⇒ empty state above).
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { MonitorState } from './types.js';
import { monitorStateSchema } from './types.js';

/** Workspace-relative location of the persisted monitor state. */
export const MONITOR_STATE_RELATIVE_PATH = join('.baton', 'state.json');

/** Absolute path of the state file for a workspace. */
export function monitorStatePath(workspace: string): string {
  return join(workspace, MONITOR_STATE_RELATIVE_PATH);
}

/** Fresh state: zone unknown, nothing dismissed. */
export function emptyMonitorState(sessionId: string): MonitorState {
  return { sessionId, lastZone: 'unknown', dismissals: [] };
}

/**
 * Load the persisted state for a workspace's session. Missing file, unreadable
 * file, malformed JSON, schema-invalid content, or a different session id all
 * yield the empty state — never an error, never fabricated bookkeeping.
 */
export function loadMonitorState(workspace: string, sessionId: string): MonitorState {
  let raw: string;
  try {
    raw = readFileSync(monitorStatePath(workspace), 'utf8');
  } catch {
    return emptyMonitorState(sessionId);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptyMonitorState(sessionId);
  }

  const result = monitorStateSchema.safeParse(parsed);
  if (!result.success || result.data.sessionId !== sessionId) {
    return emptyMonitorState(sessionId);
  }
  return result.data;
}

/**
 * Persist the state (creates `.baton/` when needed) — the only unprompted write.
 * Atomic (FR-013): temp file + rename, so no reader ever observes a torn write;
 * concurrent writers (CLI watch + MCP server) settle last-writer-wins. The temp
 * name is per-process (pid) — deterministic, no randomness — so two processes
 * never share a temp file, and a crash mid-write leaves state.json untouched.
 */
export function saveMonitorState(workspace: string, state: MonitorState): void {
  const path = monitorStatePath(workspace);
  mkdirSync(dirname(path), { recursive: true });
  const tempPath = `${path}.${String(process.pid)}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(tempPath, path);
}
