// Feature 002 T007 — MCP server shell (plan.md src/mcp/server.ts).
//
// A thin presentation layer, peer of src/cli/ (Principle V): SDK server
// construction, capability registration from the static registry, stdio transport
// wiring, workspace resolution (cwd or --workspace), the `--allow-writes`
// Connection state, and graceful shutdown. All behavior lives in src/core/ + the
// adapter — tool handlers are attached by the user-story phases (src/mcp/tools.ts)
// through the `handlers` option; until then the server starts with an empty tool
// set but a fully negotiated protocol surface.
//
// Constitution: src/mcp/ never imports src/cli/ (launcher direction is cli → mcp
// only); stdio only — no network listener of any kind (FR-012).
import { resolve } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ZoneOrUnknown } from '../core/monitor/types.js';
import type { CapabilityName } from './registry.js';
import { CAPABILITIES } from './registry.js';

/** Served implementation info (one product, one binary — research R7). */
export const SERVER_INFO = Object.freeze({ name: 'baton', version: '0.1.0' });

// ── Connection state (data-model.md Connection / CheckCursor) ─────────────────

/** Where a connection's catch-up last left off, per session (data-model.md). */
export interface CheckCursor {
  /** feature 001 SessionRef.id */
  sessionId: string;
  /** index of the first usage-bearing entry not yet reported (≥ 0) */
  position: number;
  /** zone at that position (replay resumes from here) */
  lastZone: ZoneOrUnknown;
}

/** One agent host attached to one workspace-scoped server instance. */
export interface Connection {
  /** absolute path; fixed at server start (cwd or --workspace) */
  workspace: string;
  /** operator attestation from --allow-writes; immutable for the instance lifetime */
  allowWrites: boolean;
  /** sessionId → CheckCursor; in-memory only, dies with the connection (research R4) */
  cursors: Map<string, CheckCursor>;
  /** session-data root override for tests; absent → BATON_CLAUDE_DIR, then ~/.claude */
  claudeDir?: string | undefined;
}

// ── Tool handler seam (populated by US1–US4 in src/mcp/tools.ts) ──────────────

/**
 * One capability's handler: validated arguments in, a protocol CallToolResult out.
 * Handlers are thin over src/core/ — same pipelines, same schemas as the CLI.
 */
export type CapabilityHandler = (
  args: Record<string, unknown>,
  connection: Connection,
) => Promise<CallToolResult>;

/** Handlers keyed by capability name; capabilities without one stay unregistered. */
export type ToolHandlers = Partial<Record<CapabilityName, CapabilityHandler>>;

// ── Server construction ───────────────────────────────────────────────────────

export interface BatonMcpServerOptions {
  /** workspace whose session is served; default: process.cwd() (research R1) */
  workspace?: string | undefined;
  /** operator attestation that the host prompts per request (research R3) */
  allowWrites?: boolean | undefined;
  /** session-data root override for tests; production uses BATON_CLAUDE_DIR/~/.claude */
  claudeDir?: string | undefined;
  /** tool handlers from src/mcp/tools.ts; absent entries are not registered */
  handlers?: ToolHandlers | undefined;
}

/** A constructed (not yet connected) server with its immutable Connection state. */
export interface BatonMcpServer {
  server: McpServer;
  connection: Connection;
  /** Close the protocol connection and transport. Idempotent. */
  close(): Promise<void>;
}

/**
 * Build the McpServer over the capability registry. Everything a tool serves —
 * name, canonical description, zod input schema, annotations — comes from the
 * static table (T006); only the handler is supplied here, so the served surface
 * cannot drift from the contract.
 */
export function createBatonMcpServer(options: BatonMcpServerOptions = {}): BatonMcpServer {
  const connection: Connection = {
    workspace: resolve(options.workspace ?? process.cwd()),
    allowWrites: options.allowWrites === true,
    cursors: new Map<string, CheckCursor>(),
    claudeDir: options.claudeDir,
  };

  const server = new McpServer(
    { ...SERVER_INFO },
    // Declare the tools capability explicitly: the foundational server starts with
    // an empty tool set (handlers arrive with the user stories) but must already
    // negotiate tools/list for the harness and hosts.
    { capabilities: { tools: {} } },
  );

  const handlers = options.handlers ?? {};
  let registered = 0;
  for (const capability of CAPABILITIES) {
    const handler = handlers[capability.name];
    if (handler === undefined) continue; // registered by a later user-story phase
    server.registerTool(
      capability.name,
      {
        description: capability.description,
        inputSchema: capability.inputSchema,
        annotations: { ...capability.annotations },
      },
      async (args: Record<string, unknown>, _extra: unknown): Promise<CallToolResult> =>
        handler(args, connection),
    );
    registered += 1;
  }

  if (registered === 0) {
    // The SDK installs its tools/list & tools/call request handlers lazily, on the
    // first registerTool. With no handlers yet (foundational phase) the protocol
    // surface must still answer tools/list with an empty list, so force the lazy
    // initialization through the public API: register a placeholder, remove it.
    server.registerTool('baton_bootstrap', {}, async () => ({ content: [] })).remove();
  }

  return {
    server,
    connection,
    close: async (): Promise<void> => {
      await server.close();
    },
  };
}

// ── Stdio lifecycle (launched by `baton mcp`, research R7) ────────────────────

/**
 * Serve over stdio until the host disconnects (stdin EOF / transport close) or the
 * process receives SIGINT/SIGTERM — both paths close the protocol connection
 * gracefully. stdout belongs to the protocol; nothing else may write to it.
 */
export async function runStdioServer(options: BatonMcpServerOptions = {}): Promise<void> {
  const baton = createBatonMcpServer(options);
  const transport = new StdioServerTransport();

  // Resolve when the underlying protocol connection closes, whichever side
  // initiated it. Installed before connect so an immediate close is never missed.
  const closed = new Promise<void>((resolveClosed) => {
    baton.server.server.onclose = (): void => {
      resolveClosed();
    };
  });

  const shutdown = (): void => {
    void baton.close();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  // The SDK's stdio transport does not watch for stdin EOF, so a disconnecting
  // host would otherwise leave the connection open until the event loop drains.
  // Treat EOF as the host's goodbye and close gracefully ourselves.
  process.stdin.once('end', shutdown);
  process.stdin.once('close', shutdown);

  try {
    await baton.server.connect(transport);
    await closed;
  } finally {
    process.off('SIGINT', shutdown);
    process.off('SIGTERM', shutdown);
    process.stdin.off('end', shutdown);
    process.stdin.off('close', shutdown);
  }
}
