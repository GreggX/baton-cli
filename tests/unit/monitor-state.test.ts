// T034 — MonitorState persistence at .baton/state.json: round trip, per-session
// keying (new session id ⇒ fresh state), and corrupt/missing file ⇒ empty state.
// Feature 002 T005 (FR-013, research R9) — atomic temp+rename writes shared by the
// CLI and MCP surfaces: last-writer-wins, no temp litter, readers tolerate
// mid-rename absence.
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MONITOR_STATE_RELATIVE_PATH,
  emptyMonitorState,
  loadMonitorState,
  monitorStatePath,
  saveMonitorState,
} from '../../src/core/monitor/state.js';
import type { MonitorState } from '../../src/core/monitor/types.js';

let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'baton-state-'));
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

describe('MonitorState persistence (.baton/state.json)', () => {
  it('lives at .baton/state.json inside the workspace', () => {
    expect(MONITOR_STATE_RELATIVE_PATH).toBe(join('.baton', 'state.json'));
    expect(monitorStatePath(workspace)).toBe(join(workspace, '.baton', 'state.json'));
  });

  it('missing file → empty state (zone unknown, no dismissals)', () => {
    expect(loadMonitorState(workspace, 's-1')).toEqual(emptyMonitorState('s-1'));
    expect(emptyMonitorState('s-1')).toEqual({
      sessionId: 's-1',
      lastZone: 'unknown',
      dismissals: [],
    });
  });

  it('round-trips a saved state', () => {
    const state: MonitorState = {
      sessionId: 's-1',
      lastZone: 'orange',
      dismissals: [
        { recommendationId: 'r-abc', zone: 'orange', dismissedAt: '2026-07-02T19:00:00.000Z' },
      ],
    };
    saveMonitorState(workspace, state);
    expect(loadMonitorState(workspace, 's-1')).toEqual(state);
    // bookkeeping only: ids, zone names, timestamps — parseable plain JSON
    const raw = JSON.parse(readFileSync(monitorStatePath(workspace), 'utf8')) as MonitorState;
    expect(raw.lastZone).toBe('orange');
  });

  it('per-session keying: a different session id gets a fresh state', () => {
    saveMonitorState(workspace, { sessionId: 's-1', lastZone: 'red', dismissals: [] });
    expect(loadMonitorState(workspace, 's-2')).toEqual(emptyMonitorState('s-2'));
  });

  it('corrupt JSON → empty state, never an error', () => {
    saveMonitorState(workspace, emptyMonitorState('s-1')); // ensure .baton exists
    writeFileSync(monitorStatePath(workspace), 'not json at all {');
    expect(loadMonitorState(workspace, 's-1')).toEqual(emptyMonitorState('s-1'));
  });

  it('schema-invalid content → empty state', () => {
    saveMonitorState(workspace, emptyMonitorState('s-1'));
    writeFileSync(
      monitorStatePath(workspace),
      JSON.stringify({ sessionId: 42, lastZone: 'purple', dismissals: 'nope' }),
    );
    expect(loadMonitorState(workspace, 's-1')).toEqual(emptyMonitorState('s-1'));
  });
});

describe('atomic writes for two-surface concurrency (FR-013, research R9)', () => {
  it('a save leaves no temp file behind — only the complete state.json', () => {
    saveMonitorState(workspace, { sessionId: 's-1', lastZone: 'yellow', dismissals: [] });
    const batonDir = dirname(monitorStatePath(workspace));
    expect(readdirSync(batonDir)).toEqual(['state.json']);
  });

  it('last-writer-wins: the newest write is the persisted one, always a complete document', () => {
    // Simulate the CLI and the MCP server alternating writes on one workspace.
    const cliState: MonitorState = { sessionId: 's-1', lastZone: 'orange', dismissals: [] };
    const mcpState: MonitorState = {
      sessionId: 's-1',
      lastZone: 'red',
      dismissals: [
        { recommendationId: 'r-xyz', zone: 'red', dismissedAt: '2026-07-02T20:00:00.000Z' },
      ],
    };
    for (let round = 0; round < 25; round += 1) {
      saveMonitorState(workspace, cliState);
      saveMonitorState(workspace, mcpState);
      // Every observable file state parses as one complete JSON document.
      const raw = readFileSync(monitorStatePath(workspace), 'utf8');
      expect(() => JSON.parse(raw) as unknown).not.toThrow();
    }
    expect(loadMonitorState(workspace, 's-1')).toEqual(mcpState);
  });

  it('readers tolerate mid-rename absence: a vanished file reads as the empty state', () => {
    saveMonitorState(workspace, { sessionId: 's-1', lastZone: 'orange', dismissals: [] });
    rmSync(monitorStatePath(workspace)); // the instant between unlink and rename
    expect(loadMonitorState(workspace, 's-1')).toEqual(emptyMonitorState('s-1'));
  });

  it('a stale temp file from a crashed writer disturbs neither loads nor later saves', () => {
    const statePath = monitorStatePath(workspace);
    saveMonitorState(workspace, { sessionId: 's-1', lastZone: 'yellow', dismissals: [] });
    writeFileSync(`${statePath}.99999.tmp`, '{"torn": '); // crashed writer's leftovers
    expect(loadMonitorState(workspace, 's-1')).toEqual({
      sessionId: 's-1',
      lastZone: 'yellow',
      dismissals: [],
    });
    const next: MonitorState = { sessionId: 's-1', lastZone: 'green', dismissals: [] };
    saveMonitorState(workspace, next);
    expect(loadMonitorState(workspace, 's-1')).toEqual(next);
  });
});
