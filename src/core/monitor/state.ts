// T034 — MonitorState persistence (`.baton/state.json`).
// Tool bookkeeping only — session id, lastZone, dismissal records. Never session
// content (data-model invariant), which keeps this automatic write inside the
// FR-007/SC-004 exemption: it is the ONLY unprompted write the tool performs.
//
// State is per-session: a different persisted session id means a fresh state.
// Corrupt or missing file ⇒ empty state (transitions re-detected; worst case one
// duplicate notification — acceptable, never data loss).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

/** Persist the state (creates `.baton/` when needed) — the only unprompted write. */
export function saveMonitorState(workspace: string, state: MonitorState): void {
  const path = monitorStatePath(workspace);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`);
}
