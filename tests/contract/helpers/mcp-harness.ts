// Feature 002 T009 — in-memory MCP test harness (research R8).
//
// Pairs the REAL server (createBatonMcpServer) with a real SDK client over the
// SDK's linked in-memory transport pair — the actual protocol, no subprocess —
// against a freshly generated BATON_CLAUDE_DIR fixture workspace. Fixtures are
// materialized into an isolated temp root per harness (generateFixtures), so
// parallel test files never clash and write-gating tests can assert byte-identical
// workspaces.
//
// The session-data root is threaded BOTH ways the product supports it: explicitly
// through the server's claudeDir option and via the BATON_CLAUDE_DIR environment
// variable (restored on close) — the same knob the CLI contract tests use.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult, ListToolsResult } from '@modelcontextprotocol/sdk/types.js';
import { generateFixtures } from '../../../scripts/fixtures/generate-fixtures.js';
import type { BatonMcpServer, ToolHandlers } from '../../../src/mcp/server.js';
import { createBatonMcpServer } from '../../../src/mcp/server.js';

export interface McpHarnessOptions {
  /** fixture workspace name (e.g. "ws-green") or an absolute workspace path */
  workspace: string;
  /** start the server with the --allow-writes attestation (default: false) */
  allowWrites?: boolean;
  /** tool handlers to register (src/mcp/tools.ts once the user stories land) */
  handlers?: ToolHandlers;
}

export interface McpHarness {
  /** connected SDK client — the agent host's side of the pair */
  client: Client;
  /** the real server under test, with its Connection state */
  baton: BatonMcpServer;
  /** absolute path of the workspace the server instance is scoped to */
  workspace: string;
  /** the BATON_CLAUDE_DIR fixture root this harness generated */
  claudeDir: string;
  /** temp root holding this harness's generated fixtures */
  fixtureRoot: string;
  /** absolute path of a sibling fixture workspace in this harness's temp root */
  workspacePath(name: string): string;
  /** tools/list through the real protocol */
  listTools(): Promise<ListToolsResult>;
  /** tools/call through the real protocol */
  callTool(name: string, args?: Record<string, unknown>): Promise<CallToolResult>;
  /** close client + server and delete the temp fixture root. Idempotent. */
  close(): Promise<void>;
}

/**
 * Start a real client ↔ server pair scoped to one fixture workspace.
 * Callers own the returned harness and MUST close() it (afterEach/afterAll).
 */
export async function startMcpHarness(options: McpHarnessOptions): Promise<McpHarness> {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'baton-mcp-harness-'));
  generateFixtures(fixtureRoot);
  const claudeDir = join(fixtureRoot, 'tests', 'fixtures', 'claude');
  const workspacePath = (name: string): string =>
    isAbsolute(name) ? name : join(fixtureRoot, 'tests', 'fixtures', name);
  const workspace = workspacePath(options.workspace);

  const previousClaudeDir = process.env['BATON_CLAUDE_DIR'];
  process.env['BATON_CLAUDE_DIR'] = claudeDir;

  const baton = createBatonMcpServer({
    workspace,
    allowWrites: options.allowWrites ?? false,
    claudeDir,
    handlers: options.handlers,
  });
  const client = new Client({ name: 'baton-mcp-harness', version: '0.0.0' });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([
    baton.server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await client.close();
    await baton.close();
    if (previousClaudeDir === undefined) {
      delete process.env['BATON_CLAUDE_DIR'];
    } else {
      process.env['BATON_CLAUDE_DIR'] = previousClaudeDir;
    }
    rmSync(fixtureRoot, { recursive: true, force: true });
  };

  return {
    client,
    baton,
    workspace,
    claudeDir,
    fixtureRoot,
    workspacePath,
    listTools: async (): Promise<ListToolsResult> => client.listTools(),
    callTool: async (
      name: string,
      args: Record<string, unknown> = {},
    ): Promise<CallToolResult> =>
      (await client.callTool({ name, arguments: args })) as CallToolResult,
    close,
  };
}
