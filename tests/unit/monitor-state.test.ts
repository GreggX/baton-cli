// T034 — MonitorState persistence at .baton/state.json: round trip, per-session
// keying (new session id ⇒ fresh state), and corrupt/missing file ⇒ empty state.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
