// Feature 002 T026 — stdio smoke test over the REAL transport (research R8:
// the one subprocess test; everything else runs the in-memory pair).
//
//   - builds dist/ and spawns the actual production entry — `baton mcp` via
//     `node dist/cli/index.js mcp --workspace <fixture>` — exactly what an MCP
//     host launches after `claude mcp add baton -- baton mcp` (research R7)
//   - performs the protocol handshake with a real SDK client over stdio
//   - calls context_status against the ws-yellow fixture and asserts a valid,
//     budget-compliant response arrives in under 2 seconds (SC-001, SC-003)
//   - asserts the serving process holds no listening network sockets — stdio
//     only, no listener of any kind (FR-012), proven with lsof against the
//     live subprocess
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SESSION_IDS, generateFixtures } from '../../scripts/fixtures/generate-fixtures.js';
import { statusReportSchema } from '../../src/core/monitor/reader.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const distEntry = join(repoRoot, 'dist', 'cli', 'index.js');

/** SC-001: the status answer deadline (milliseconds). */
const STATUS_DEADLINE_MS = 2_000;
/** SC-003: 200 tokens by the chars/4 rule. */
const BUDGET_CHARS = 200 * 4;

let fixtureRoot: string;
let workspace: string;
let client: Client;
let transport: StdioClientTransport;
let stderrChunks: string[];

beforeAll(async () => {
  // The smoke test exercises the BUILT binary — compile the current sources so
  // dist/ cannot be stale or missing (nothing else in the suite reads dist/).
  const build = spawnSync('npm', ['run', 'build'], { cwd: repoRoot, encoding: 'utf8' });
  expect(build.error).toBeUndefined();
  expect(build.status, build.stderr).toBe(0);

  // Isolated fixture root, same layout the in-memory harness generates.
  fixtureRoot = mkdtempSync(join(tmpdir(), 'baton-mcp-stdio-'));
  generateFixtures(fixtureRoot);
  const claudeDir = join(fixtureRoot, 'tests', 'fixtures', 'claude');
  workspace = join(fixtureRoot, 'tests', 'fixtures', 'ws-yellow');

  // The production launch line: node dist/cli/index.js mcp --workspace <ws>.
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [distEntry, 'mcp', '--workspace', workspace],
    env: { ...getDefaultEnvironment(), BATON_CLAUDE_DIR: claudeDir },
    stderr: 'pipe', // collected for diagnostics; stdout belongs to the protocol
  });
  stderrChunks = [];
  transport.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk.toString()));

  client = new Client({ name: 'baton-stdio-smoke', version: '0.0.0' });
  await client.connect(transport); // spawn + full protocol handshake
}, 120_000);

afterAll(async () => {
  await client?.close(); // closes the transport and terminates the subprocess
  if (fixtureRoot !== undefined) rmSync(fixtureRoot, { recursive: true, force: true });
});

describe('baton mcp over real stdio (T026)', () => {
  it('handshakes as the baton server and lists the six tools', async () => {
    expect(client.getServerVersion()?.name, stderrChunks.join('')).toBe('baton');
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'context_catchup',
      'context_config',
      'context_handoff',
      'context_save',
      'context_scan',
      'context_status',
    ]);
  });

  it('answers context_status validly, within budget, in under 2 seconds (SC-001, SC-003)', async () => {
    const startedAt = performance.now();
    const result = (await client.callTool({
      name: 'context_status',
      arguments: {},
    })) as CallToolResult;
    const elapsedMs = performance.now() - startedAt;
    expect(elapsedMs, stderrChunks.join('')).toBeLessThan(STATUS_DEADLINE_MS);

    expect(result.isError ?? false).toBe(false);
    const first = result.content[0];
    if (first === undefined || first.type !== 'text') {
      throw new Error('expected a text content block');
    }
    // Budgeted: compact single-line JSON within 200 tokens by chars/4 (SC-003).
    expect(first.text.length).toBeLessThanOrEqual(BUDGET_CHARS);
    expect(first.text).not.toContain('\n');
    // Valid: the CLI status shape from the shared feature-001 schema (FR-003).
    const report = statusReportSchema.parse(JSON.parse(first.text));
    if (report.state !== 'ok') throw new Error('expected ok state');
    expect(report.reading.sessionId).toBe(SESSION_IDS.yellow);
    expect(report.zone).toBe('yellow');
  });

  it('holds no listening network sockets — stdio only (FR-012)', () => {
    const pid = transport.pid;
    expect(pid).not.toBeNull();
    // lsof -i restricts to internet files; -P/-n keep ports/addresses literal.
    // Exit status 1 with empty output is lsof's "nothing matched" — the pass case.
    const lsof = spawnSync('lsof', ['-a', '-p', String(pid), '-i', '-P', '-n'], {
      encoding: 'utf8',
    });
    expect(lsof.error).toBeUndefined();
    expect([0, 1], lsof.stderr).toContain(lsof.status);
    const listening = (lsof.stdout ?? '')
      .split('\n')
      .filter((line) => line.includes('LISTEN'));
    expect(listening, lsof.stdout).toEqual([]);
  });
});
