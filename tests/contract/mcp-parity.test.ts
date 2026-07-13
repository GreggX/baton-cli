// Feature 002 T011 — US1 parity tests: MCP tool values ≡ CLI --json values
// (contracts/mcp-tools.md obligation 2, SC-004 / FR-003 "one behavior, two
// surfaces"). Each case runs the SAME fixture state through the real MCP
// client↔server pair and through the real CLI (same BATON_CLAUDE_DIR, same
// workspace) and diffs the reports field-by-field. `dataAgeSeconds` is the one
// wall-clock-relative field: the two surfaces read moments apart, so it is
// compared with a small tolerance instead of exact equality.
//
// Feature 002 T018 — US3 parity tests for context_scan (quickstart scenario 5):
// the scan report is fully deterministic (stable candidate ids, no clock in the
// fingerprint), so the ENTIRE report — candidates AND fingerprint — is compared
// exactly against `baton context scan --json` on ws-decisions, on ws-no-matches
// (the explicit empty result), and under the category filter (SC-004 / FR-003).
//
// Feature 002 T023 — US4 parity tests for context_handoff (quickstart scenario 7):
// with writes enabled, the MCP-produced handoff FILE must equal the CLI's for the
// same fixture state — sections, task state, and every [source: …] annotation.
// The only wall-clock ink in the file is the `- written <ts>` header stamp (the
// two surfaces write moments apart), so both files are compared whole after
// normalizing exactly that stamp; the reports' sessionId/artifactCount are exact.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';
import { createToolHandlers } from '../../src/mcp/tools.js';
import type { McpHarness } from './helpers/mcp-harness.js';
import { startMcpHarness } from './helpers/mcp-harness.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const cliEntry = join(repoRoot, 'src', 'cli', 'index.ts');

/** Seconds of drift tolerated between the two surfaces' wall-clock reads. */
const AGE_TOLERANCE_SECONDS = 120;

let harness: McpHarness | null = null;

afterEach(async () => {
  if (harness !== null) {
    await harness.close();
    harness = null;
  }
});

async function start(workspace: string, allowWrites = false): Promise<McpHarness> {
  harness = await startMcpHarness({ workspace, allowWrites, handlers: createToolHandlers() });
  return harness;
}

/** Run the real CLI against the harness's fixture root; stdout must be pure JSON. */
function runCliJson(args: string[], claudeDir: string): unknown {
  const proc = spawnSync(process.execPath, ['--import', 'tsx', cliEntry, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, BATON_CLAUDE_DIR: claudeDir },
  });
  if (proc.error) throw proc.error;
  return JSON.parse(proc.stdout);
}

function payloadOf(result: CallToolResult): unknown {
  expect(result.isError ?? false).toBe(false);
  const first = result.content[0];
  if (first === undefined || first.type !== 'text') {
    throw new Error('expected a text content block');
  }
  return JSON.parse(first.text);
}

/** Split the wall-clock-relative field off a report for tolerant comparison. */
function splitAge(report: unknown): { rest: Record<string, unknown>; age: unknown } {
  const { dataAgeSeconds, ...rest } = report as Record<string, unknown>;
  return { rest, age: dataAgeSeconds };
}

const WORKSPACES = ['ws-green', 'ws-yellow', 'ws-empty', 'ws-bad-config'] as const;

describe('context_status ≡ baton context status --json (T011, SC-004)', () => {
  for (const workspace of WORKSPACES) {
    it(`reports identical values on ${workspace} (field-by-field)`, async () => {
      const h = await start(workspace);
      const mcp = splitAge(payloadOf(await h.callTool('context_status')));
      const cli = splitAge(
        runCliJson(
          ['context', 'status', '--json', '--workspace', h.workspace],
          h.claudeDir,
        ),
      );
      expect(mcp.rest).toEqual(cli.rest);
      if (typeof mcp.age === 'number' && typeof cli.age === 'number') {
        expect(Math.abs(cli.age - mcp.age)).toBeLessThanOrEqual(AGE_TOLERANCE_SECONDS);
      } else {
        expect(mcp.age).toEqual(cli.age); // null/absent must match exactly
      }
    });
  }
});

describe('context_config ≡ baton context config show --json (T011, FR-011)', () => {
  for (const workspace of WORKSPACES) {
    it(`reports the identical config report on ${workspace}`, async () => {
      const h = await start(workspace);
      const mcp = payloadOf(await h.callTool('context_config'));
      const cli = runCliJson(
        ['context', 'config', 'show', '--json', '--workspace', h.workspace],
        h.claudeDir,
      );
      expect(mcp).toEqual(cli);
    });
  }
});

// ── US3: context_scan (T018) ──────────────────────────────────────────────────

/** The deterministic scan report shape both surfaces must produce (FR-003). */
interface ScanReportLike {
  sessionId: string;
  fingerprint: string;
  rulesChecked: string[];
  candidates: { id: string; ruleId: string }[];
}

describe('context_scan ≡ baton context scan --json (T018, SC-004)', () => {
  it('ws-decisions: identical candidates and fingerprint, exact report equality', async () => {
    const h = await start('ws-decisions');
    const mcp = payloadOf(await h.callTool('context_scan')) as ScanReportLike;
    const cli = runCliJson(
      ['context', 'scan', '--json', '--workspace', h.workspace],
      h.claudeDir,
    ) as ScanReportLike;
    // The whole report is deterministic — compare it exactly, no tolerances.
    expect(mcp).toEqual(cli);
    // The parity claim is non-trivial: this fixture MUST surface candidates.
    expect(mcp.candidates.length).toBeGreaterThan(0);
    expect(mcp.fingerprint).toBe(cli.fingerprint);
    expect(mcp.candidates.map((candidate) => candidate.id)).toEqual(
      cli.candidates.map((candidate) => candidate.id),
    );
  });

  it('ws-no-matches: the explicit empty result equals the CLI (candidates [], rulesChecked populated)', async () => {
    const h = await start('ws-no-matches');
    const mcp = payloadOf(await h.callTool('context_scan')) as ScanReportLike;
    const cli = runCliJson(
      ['context', 'scan', '--json', '--workspace', h.workspace],
      h.claudeDir,
    ) as ScanReportLike;
    expect(mcp).toEqual(cli);
    // Explicit empty, never silence (US3-AS3): no candidates, but the report
    // still names every rule checked and carries the deterministic fingerprint.
    expect(mcp.candidates).toEqual([]);
    expect(mcp.rulesChecked.length).toBeGreaterThan(0);
    expect(mcp.fingerprint).toMatch(/^[0-9a-f]{6}$/);
  });

  it('category filter honored: categories ["decision"] ≡ --category decision', async () => {
    const h = await start('ws-decisions');
    const mcp = payloadOf(
      await h.callTool('context_scan', { categories: ['decision'] }),
    ) as ScanReportLike;
    const cli = runCliJson(
      ['context', 'scan', '--category', 'decision', '--json', '--workspace', h.workspace],
      h.claudeDir,
    ) as ScanReportLike;
    expect(mcp).toEqual(cli);
    // The filter really narrowed the run: only decision rules were checked and
    // every surfaced candidate names a decision rule as its trigger (FR-007).
    expect(mcp.rulesChecked.length).toBeGreaterThan(0);
    for (const ruleId of mcp.rulesChecked) {
      expect(ruleId).toMatch(/^decision\./);
    }
    expect(mcp.candidates.length).toBeGreaterThan(0);
    for (const candidate of mcp.candidates) {
      expect(candidate.ruleId).toMatch(/^decision\./);
    }
  });
});

// ── US4: context_handoff (T023) ───────────────────────────────────────────────

/** The CLI handoff --json shape both surfaces must produce (FR-003). */
interface HandoffReportLike {
  path: string;
  sessionId: string;
  artifactCount: number;
}

/**
 * Blank the one wall-clock stamp in a handoff file — the `- written <ts>` header
 * line — so the two surfaces' files (written moments apart) compare whole.
 * Everything else in the file is deterministic and MUST match byte for byte.
 */
function normalizeWrittenStamp(content: string): string {
  return content.replace(
    /^- written \d{4}-\d{2}-\d{2} \d{2}:\d{2}/m,
    '- written <normalized>',
  );
}

describe('context_handoff ≡ baton context handoff --json (T023, SC-004)', () => {
  it('ws-red with a saved artifact: sections, task state, and [source: …] annotations equal the CLI file', async () => {
    const h = await start('ws-red', true);

    // Shared state for BOTH surfaces: save the decision candidate through MCP so
    // each handoff must link the same artifact (non-trivial [source: …] parity).
    const scan = payloadOf(await h.callTool('context_scan')) as ScanReportLike;
    const decided = scan.candidates.find(
      (candidate) => candidate.ruleId === 'decision.decided-to',
    );
    if (decided === undefined) {
      throw new Error('expected a decision.decided-to candidate in ws-red');
    }
    const saved = payloadOf(
      await h.callTool('context_save', { candidateIds: [decided.id] }),
    ) as { saved: { path: string }[] };
    const artifactPath = saved.saved[0]?.path;
    if (artifactPath === undefined) throw new Error('expected a saved artifact path');

    // MCP handoff first — read its file BEFORE the CLI writes its own.
    const mcp = payloadOf(await h.callTool('context_handoff')) as HandoffReportLike;
    const mcpContent = readFileSync(join(h.workspace, mcp.path), 'utf8');

    const cli = runCliJson(
      ['context', 'handoff', '--json', '--workspace', h.workspace],
      h.claudeDir,
    ) as HandoffReportLike;
    const cliContent = readFileSync(join(h.workspace, cli.path), 'utf8');

    // Report parity: same session, same artifact count, same default location.
    expect(mcp.sessionId).toBe(cli.sessionId);
    expect(mcp.artifactCount).toBe(cli.artifactCount);
    expect(mcp.artifactCount).toBe(1);
    expect(mcp.path).toMatch(/^\.baton\/handoff\/\d{8}-\d{6}-handoff\.md$/);
    expect(cli.path).toMatch(/^\.baton\/handoff\/\d{8}-\d{6}-handoff\.md$/);

    // FILE parity: whole file identical once the written stamp is normalized —
    // header meta, every section, task state glyphs, artifact links, sources.
    expect(normalizeWrittenStamp(mcpContent)).toBe(normalizeWrittenStamp(cliContent));

    // The equality above is non-trivial: the shared file really carries the
    // design 4b sections, the task-state lines, and per-item [source: …]
    // annotations, with the saved artifact linked by its provenance.
    for (const heading of [
      '## Task state',
      '## Key decisions',
      '## Saved artifacts (1/1 verified on disk)',
      '## Open questions',
      '## Resume',
    ]) {
      expect(mcpContent).toContain(heading);
    }
    expect(mcpContent).toContain('[source: turn 1 · user]');
    expect(mcpContent).toContain(
      `1. We decided to route every reading through the shared pipeline. → ${artifactPath} [source: ${artifactPath}]`,
    );
    expect(mcpContent).toMatch(/- ◐ in progress — .+ \[source: turn \d+ · user\]/);
    expect(mcpContent).toMatch(/- ○ open — .+ \[source: task\.[a-z-]+ · turn \d+\]/);
  });

  it('ws-red without saved artifacts: the captured-here decision and 0/0 verification equal the CLI', async () => {
    const h = await start('ws-red', true);

    const mcp = payloadOf(await h.callTool('context_handoff')) as HandoffReportLike;
    const mcpContent = readFileSync(join(h.workspace, mcp.path), 'utf8');

    const cli = runCliJson(
      ['context', 'handoff', '--json', '--workspace', h.workspace],
      h.claudeDir,
    ) as HandoffReportLike;
    const cliContent = readFileSync(join(h.workspace, cli.path), 'utf8');

    expect(mcp.sessionId).toBe(cli.sessionId);
    expect(mcp.artifactCount).toBe(0);
    expect(cli.artifactCount).toBe(0);
    expect(normalizeWrittenStamp(mcpContent)).toBe(normalizeWrittenStamp(cliContent));
    expect(mcpContent).toContain(
      '— captured here (no artifact saved) [source: decision.decided-to · turn 2]',
    );
    expect(mcpContent).toContain('## Saved artifacts (0/0 verified on disk)');
  });
});
