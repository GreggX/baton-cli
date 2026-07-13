// Feature 002 T010 — US1 contract tests for context_status + context_config
// (contracts/mcp-tools.md obligations 1 partial + the spec's data-root edge case):
//   - both tools listed with their CANONICAL descriptions (verbatim contract text,
//     FR-010/research R6) and read-only + idempotent annotations (research R3)
//   - results validate against the feature-001 zod schemas from src/core/ (FR-003)
//   - ok / estimated / unknown shapes: unknown carries reason + last-good age and
//     NEVER a fabricated zone or reading (FR-008; strict schema proves it)
//   - a server pointed at a nonexistent or unreadable session-data root returns a
//     structured configuration error naming the problem — never fabricated data
// The exact-six listing audit is T025 (Polish); this file asserts the US1 canon.
//
// Feature 002 T015 — US2 contract tests for context_catchup (contracts/mcp-tools.md
// obligation 5, FR-009/FR-013):
//   - first call → the current snapshot (standing advisory for the current zone,
//     NO history), cursor created per connection+session
//   - post-replay delta after scripts/fixtures/append-turns.sh → exactly ONE
//     collapsed transition + the trigger-carrying pending recommendation
//   - a dismissal recorded via the CLI surface (.baton/state.json) is excluded
//     from the next catch-up (cross-surface FR-013 proof)
//   - repeat call → the explicit `empty: true` result
//   - pending payloads validate against the feature-001 Recommendation schema
//     (catch-up has no CLI twin — parity is inherited through the shared replay
//     function and recommendation engine, asserted here at the schema level)
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';
import {
  SESSION_IDS,
  encodeWorkspacePathForFixtures,
  fixtureRepoRoot,
} from '../../scripts/fixtures/generate-fixtures.js';
import { DEFAULT_THRESHOLDS, configReportSchema } from '../../src/core/config/schema.js';
import {
  statusReportSchema,
  statusUnknownReportSchema,
} from '../../src/core/monitor/reader.js';
import {
  dismiss,
  zoneRecommendationId,
} from '../../src/core/monitor/recommendations.js';
import { emptyMonitorState, saveMonitorState } from '../../src/core/monitor/state.js';
import { recommendationSchema } from '../../src/core/monitor/types.js';
import { ZONE_GUIDANCE } from '../../src/core/monitor/zones.js';
import { catchupReportSchema } from '../../src/mcp/registry.js';
import { createToolHandlers } from '../../src/mcp/tools.js';
import type { McpHarness } from './helpers/mcp-harness.js';
import { startMcpHarness } from './helpers/mcp-harness.js';

// Canonical description strings — contracts/mcp-tools.md VERBATIM (tested canon).
const STATUS_DESCRIPTION =
  'Read the current context health of this session: zone (green/yellow/orange/red), usage percentage, and what to do about it. Cheap — check whenever unsure, and always before pasting large content.';
const CONFIG_DESCRIPTION =
  'Read the effective zone thresholds and their source (file or defaults), including any configuration problems. Read-only.';

// T025 — the FULL canon, transcribed from contracts/mcp-tools.md by hand (NOT
// imported from src/mcp/registry.ts: the point is to catch the registry drifting
// from the contract). classification mirrors the contract's (read)/(persisting)
// tags; annotations follow research R3 — read tools are read-only + idempotent,
// persisting tools are NOT read-only so hosts prompt per request; nothing here
// reaches the open world (local files only).
const CONTRACT_CANON: readonly {
  name: string;
  description: string;
  classification: 'read' | 'persisting';
}[] = [
  { name: 'context_status', description: STATUS_DESCRIPTION, classification: 'read' },
  {
    name: 'context_catchup',
    description:
      'What changed since you last checked: zone transitions and pending recommendations, each with its trigger. Returns an explicit empty result when nothing changed — cheap to call routinely.',
    classification: 'read',
  },
  {
    name: 'context_scan',
    description:
      'Deterministically scan this session for passages worth saving as artifacts (decisions, conclusions, constraints, results, tasks, questions). Use in orange or red before recommending compaction. Read-only.',
    classification: 'read',
  },
  {
    name: 'context_save',
    description:
      'Request saving scanned candidates as workspace artifacts. Requires explicit user approval; nothing is written if declined. Propose only candidates the user would plausibly want kept.',
    classification: 'persisting',
  },
  {
    name: 'context_handoff',
    description:
      'Request generation of a handoff summary file so a fresh session can resume this work. Requires explicit user approval. Recommend this in red.',
    classification: 'persisting',
  },
  { name: 'context_config', description: CONFIG_DESCRIPTION, classification: 'read' },
];

let harness: McpHarness | null = null;

afterEach(async () => {
  if (harness !== null) {
    await harness.close();
    harness = null;
  }
});

async function start(workspace: string): Promise<McpHarness> {
  harness = await startMcpHarness({ workspace, handlers: createToolHandlers() });
  return harness;
}

/** The single agent-visible text block of a tool result. */
function textOf(result: CallToolResult): string {
  const first = result.content[0];
  if (first === undefined || first.type !== 'text') {
    throw new Error('expected a text content block');
  }
  return first.text;
}

/** Parse a NON-error tool result's compact JSON payload. */
function payloadOf(result: CallToolResult): unknown {
  expect(result.isError ?? false).toBe(false);
  return JSON.parse(textOf(result));
}

describe('US1 listing & canon (T010)', () => {
  it('lists context_status and context_config with the canonical contract descriptions', async () => {
    const h = await start('ws-green');
    const { tools } = await h.listTools();
    const status = tools.find((tool) => tool.name === 'context_status');
    const config = tools.find((tool) => tool.name === 'context_config');
    expect(status).toBeDefined();
    expect(config).toBeDefined();
    expect(status?.description).toBe(STATUS_DESCRIPTION);
    expect(config?.description).toBe(CONFIG_DESCRIPTION);
  });

  it('serves both as read-only + idempotent (annotations hosts rely on, research R3)', async () => {
    const h = await start('ws-green');
    const { tools } = await h.listTools();
    for (const name of ['context_status', 'context_config']) {
      const tool = tools.find((entry) => entry.name === name);
      expect(tool?.annotations?.readOnlyHint, `${name} readOnlyHint`).toBe(true);
      expect(tool?.annotations?.idempotentHint, `${name} idempotentHint`).toBe(true);
      expect(tool?.annotations?.openWorldHint, `${name} openWorldHint`).toBe(false);
    }
  });
});

describe('context_status result shapes (T010)', () => {
  it('ok/exact: zod-valid CLI status shape with zone, guidance, and last transition', async () => {
    const h = await start('ws-yellow');
    const payload = payloadOf(await h.callTool('context_status'));
    const report = statusReportSchema.parse(payload);
    if (report.state !== 'ok') throw new Error('expected ok state');
    expect(report.reading.sessionId).toBe(SESSION_IDS.yellow);
    expect(report.reading.tokensUsed).toBe(90_400);
    expect(report.reading.contextWindow).toBe(200_000);
    expect(report.reading.pct).toBeCloseTo(45.2, 9);
    expect(report.reading.precision).toBe('exact');
    expect(report.zone).toBe('yellow');
    expect(report.guidance).toBe(ZONE_GUIDANCE.yellow);
    expect(report.dataAgeSeconds).toBeGreaterThanOrEqual(0);
    expect(report.lastTransition).toEqual({
      from: 'green',
      to: 'yellow',
      direction: 'escalation',
    });
  });

  it('estimated: a session without usage accounting stays labeled estimated (FR-013)', async () => {
    const h = await start('ws-yellow');
    // Leave only the usage-free sessions in the workspace so the active-session
    // rule resolves the chars/4-estimated one (no session param is exposed).
    const projectDir = join(
      h.claudeDir,
      'projects',
      encodeWorkspacePathForFixtures(h.workspace),
    );
    rmSync(join(projectDir, `${SESSION_IDS.yellow}.jsonl`));
    rmSync(join(projectDir, `${SESSION_IDS.yellowBigWindow}.jsonl`));
    const report = statusReportSchema.parse(payloadOf(await h.callTool('context_status')));
    if (report.state !== 'ok') throw new Error('expected ok state');
    expect(report.reading.sessionId).toBe(SESSION_IDS.yellowNoUsage);
    expect(report.reading.precision).toBe('estimated');
  });

  it('unknown: reason + last-good age, never a fabricated zone (FR-008)', async () => {
    const h = await start('ws-empty');
    const payload = payloadOf(await h.callTool('context_status'));
    // STRICT schema: any extra key — a zone, a reading — fails the parse.
    const report = statusUnknownReportSchema.parse(payload);
    expect(report.state).toBe('unknown');
    expect(report.reason.length).toBeGreaterThan(0);
    expect(report.lastGoodReading).toBeNull();
    expect(report.dataAgeSeconds).toBeGreaterThanOrEqual(0);
    expect(payload).not.toHaveProperty('zone');
    expect(payload).not.toHaveProperty('reading');
  });
});

describe('context_config result shapes (T010)', () => {
  it('defaults workspace: zod-valid report with source defaults and no errors', async () => {
    const h = await start('ws-green');
    const report = configReportSchema.parse(payloadOf(await h.callTool('context_config')));
    expect(report.valid).toBe(true);
    expect(report.thresholds).toEqual(DEFAULT_THRESHOLDS);
    expect(report.source).toBe('defaults');
    expect(report.errors).toEqual([]);
  });

  it('invalid workspace config: named violations with defaults in effect (FR-011)', async () => {
    const h = await start('ws-bad-config');
    const report = configReportSchema.parse(payloadOf(await h.callTool('context_config')));
    expect(report.valid).toBe(false);
    expect(report.source).toBe('defaults');
    expect(report.thresholds).toEqual(DEFAULT_THRESHOLDS); // defaults in effect
    expect(report.errors).toEqual([
      {
        key: 'thresholds.orange',
        value: 60,
        rule: 'must be greater than thresholds.yellow (65)',
      },
    ]);
  });
});

describe('nonexistent or unreadable session-data root (T010, spec edge case)', () => {
  it('nonexistent data root: structured configuration error, never fabricated data', async () => {
    const h = await start('ws-green');
    rmSync(h.claudeDir, { recursive: true, force: true });
    const result = await h.callTool('context_status');
    expect(result.isError).toBe(true);
    const payload = JSON.parse(textOf(result)) as Record<string, unknown>;
    expect(typeof payload['error']).toBe('string');
    expect((payload['error'] as string).length).toBeGreaterThan(0);
    expect(payload['reason']).toContain(h.claudeDir); // names the offending root
    expect(payload).not.toHaveProperty('zone');
    expect(payload).not.toHaveProperty('reading');
    expect(payload).not.toHaveProperty('state');
  });

  // chmod 000 does not restrict root, so this scenario is unobservable under uid 0.
  it.skipIf(typeof process.getuid === 'function' && process.getuid() === 0)(
    'unreadable data root: structured configuration error, never fabricated data',
    async () => {
      const h = await start('ws-green');
      chmodSync(h.claudeDir, 0o000);
      try {
        const result = await h.callTool('context_status');
        expect(result.isError).toBe(true);
        const payload = JSON.parse(textOf(result)) as Record<string, unknown>;
        expect(typeof payload['error']).toBe('string');
        expect(payload['reason']).toContain(h.claudeDir);
        expect(payload).not.toHaveProperty('zone');
        expect(payload).not.toHaveProperty('state');
      } finally {
        chmodSync(h.claudeDir, 0o755); // let close() clean the fixture root up
      }
    },
  );
});

// ── US2: context_catchup (T015) ───────────────────────────────────────────────

/**
 * Replay the growth turns into a fixture workspace's transcript with the REAL
 * scripts/fixtures/append-turns.sh. The script resolves the growth base/turn
 * files from its own location (repo root), so a byte-identical copy is placed
 * inside the harness's temp fixture root first — the script then runs fully
 * hermetic against THIS harness's generated fixtures (no cross-test races with
 * suites that regenerate the repository fixtures).
 */
function runAppendTurns(h: McpHarness, workspaceName: string): void {
  const scriptRelative = join('scripts', 'fixtures', 'append-turns.sh');
  const scriptCopy = join(h.fixtureRoot, scriptRelative);
  mkdirSync(dirname(scriptCopy), { recursive: true });
  copyFileSync(join(fixtureRepoRoot(), scriptRelative), scriptCopy);
  // interval 0: replay every turn immediately — catch-up derives from the file,
  // not from watching, so no pacing is needed.
  const result = spawnSync('bash', [scriptCopy, h.workspacePath(workspaceName), '0'], {
    env: { ...process.env, BATON_CLAUDE_DIR: h.claudeDir },
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr.toString()).toBe(0);
}

describe('context_catchup (T015, FR-009/FR-013)', () => {
  it('first call returns the current snapshot: standing advisory, NO history', async () => {
    // ws-yellow's transcript already crossed green → yellow in its past; the
    // snapshot must not deliver that history — only the current zone's advisory.
    const h = await start('ws-yellow');
    const report = catchupReportSchema.parse(payloadOf(await h.callTool('context_catchup')));
    expect(report.sessionId).toBe(SESSION_IDS.yellow);
    expect(report.transitions).toEqual([]); // no history on the first call
    expect(report.pending).toHaveLength(1);
    // Feature-001 Recommendation schema is the payload contract (FR-003).
    const pending = recommendationSchema.parse(report.pending[0]);
    expect(pending.kind).toBe('favor_retrieval');
    expect(pending.state).toBe('pending');
    if (pending.trigger.kind !== 'zone_transition') {
      throw new Error('expected a zone_transition trigger');
    }
    expect(pending.trigger.transition.to).toBe('yellow'); // names its trigger
    expect(report.empty).toBe(false);
  });

  it('first call on a quiet green session is the explicit empty snapshot', async () => {
    const h = await start('ws-growing'); // 35% — green, nothing pending
    const report = catchupReportSchema.parse(payloadOf(await h.callTool('context_catchup')));
    expect(report).toEqual({
      sessionId: SESSION_IDS.growing,
      transitions: [],
      pending: [],
      empty: true,
    });
  });

  it('post-replay delta: exactly ONE collapsed transition + trigger-carrying pending recommendation', async () => {
    const h = await start('ws-growing');
    payloadOf(await h.callTool('context_catchup')); // snapshot creates the cursor
    runAppendTurns(h, 'ws-growing'); // 35% → 38% → 39.5% → 68%: crosses 40% AND 60%
    const report = catchupReportSchema.parse(payloadOf(await h.callTool('context_catchup')));
    expect(report.sessionId).toBe(SESSION_IDS.growing);
    // Multi-band collapse (FR-009): one transition naming the FINAL zone.
    expect(report.transitions).toHaveLength(1);
    expect(report.transitions[0]).toMatchObject({
      sessionId: SESSION_IDS.growing,
      from: 'green',
      to: 'orange',
      direction: 'escalation',
    });
    expect(report.transitions[0]?.reading.pct).toBeCloseTo(68, 9); // carries its cause
    // The pending advisory validates against the feature-001 schema and carries
    // the very transition that triggered it (FR-006: no untriggered advice).
    expect(report.pending).toHaveLength(1);
    const pending = recommendationSchema.parse(report.pending[0]);
    expect(pending.kind).toBe('compact');
    expect(pending.state).toBe('pending');
    if (pending.trigger.kind !== 'zone_transition') {
      throw new Error('expected a zone_transition trigger');
    }
    expect(pending.trigger.transition).toEqual(report.transitions[0]);
    expect(pending.guidance).toContain('orange');
    expect(report.empty).toBe(false);
  });

  it('repeat call after the delta → the explicit empty result (anti-nag)', async () => {
    const h = await start('ws-growing');
    payloadOf(await h.callTool('context_catchup')); // snapshot
    runAppendTurns(h, 'ws-growing');
    payloadOf(await h.callTool('context_catchup')); // the delta, reported once
    const repeat = catchupReportSchema.parse(payloadOf(await h.callTool('context_catchup')));
    expect(repeat).toEqual({
      sessionId: SESSION_IDS.growing,
      transitions: [],
      pending: [],
      empty: true,
    });
  });

  it('a dismissal recorded via the CLI surface (state.json) is excluded from the next catch-up (FR-013)', async () => {
    const h = await start('ws-growing');
    payloadOf(await h.callTool('context_catchup')); // snapshot
    runAppendTurns(h, 'ws-growing'); // grows into orange
    // The user dismisses the compact advisory on the CLI surface: `watch`'s `d`
    // key records it with the feature-001 bookkeeping API and persists it to the
    // shared .baton/state.json (same id — deterministic hash — same file).
    saveMonitorState(
      h.workspace,
      dismiss(
        emptyMonitorState(SESSION_IDS.growing),
        zoneRecommendationId(SESSION_IDS.growing, 'orange'),
        'orange',
        '2026-07-02T19:05:00.000Z',
      ),
    );
    const report = catchupReportSchema.parse(payloadOf(await h.callTool('context_catchup')));
    expect(report.transitions).toHaveLength(1); // the transition is a fact — still delivered
    expect(report.pending).toEqual([]); // the dismissed advisory is NOT delivered
    expect(report.empty).toBe(false);
  });
});

// ── Polish: the complete listing-and-canon audit (T025) ──────────────────────
//
// Feature 002 T025 — contracts/mcp-tools.md obligation 1 in full: the production
// launcher's tool set (createToolHandlers, the same handlers `baton mcp` serves)
// lists EXACTLY the six contract tools, and every served description and
// annotation matches the contract canon verbatim. The canon table above is
// transcribed from the contract by hand, so registry drift cannot hide.

describe('complete listing & canon (T025, contract obligation 1)', () => {
  it('lists exactly the six contract tools — nothing missing, nothing extra', async () => {
    const h = await start('ws-green');
    const { tools } = await h.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(
      CONTRACT_CANON.map((entry) => entry.name).sort(),
    );
  });

  it('serves every description VERBATIM from contracts/mcp-tools.md (FR-010, research R6)', async () => {
    const h = await start('ws-green');
    const { tools } = await h.listTools();
    for (const canon of CONTRACT_CANON) {
      const tool = tools.find((entry) => entry.name === canon.name);
      expect(tool, canon.name).toBeDefined();
      expect(tool?.description, canon.name).toBe(canon.description);
    }
  });

  it('serves the canonical annotations: read ⇒ read-only + idempotent; persisting ⇒ NOT read-only so hosts prompt (research R3)', async () => {
    const h = await start('ws-green');
    const { tools } = await h.listTools();
    for (const canon of CONTRACT_CANON) {
      const tool = tools.find((entry) => entry.name === canon.name);
      expect(tool?.annotations, canon.name).toEqual(
        canon.classification === 'read'
          ? { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
          : { readOnlyHint: false, openWorldHint: false },
      );
    }
  });
});
