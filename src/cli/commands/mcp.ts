// Feature 002 T008 — `baton mcp [--allow-writes] [--workspace <path>]`.
//
// Top-level launcher for the MCP context server on the same binary (research R7:
// hosts configure `command: baton, args: [mcp]` — the SC-005 single step). This is
// the ONLY cli → mcp import direction the constitution allows. The subprocess's
// stdout belongs to the MCP protocol, so this command writes nothing to it;
// diagnostics go to stderr.
import { resolve } from 'node:path';
import type { Command } from 'commander';
import { runStdioServer } from '../../mcp/server.js';
import { createToolHandlers } from '../../mcp/tools.js';

interface McpOptions {
  allowWrites?: boolean;
  workspace?: string;
}

/** Register the top-level `mcp` command on the `baton` program. */
export function registerMcpCommand(program: Command): void {
  program
    .command('mcp')
    .description(
      'Serve the six context capabilities to an MCP host over stdio (one workspace per instance; persisting tools decline unless --allow-writes)',
    )
    .option(
      '--allow-writes',
      'enable the persisting tools (context_save, context_handoff) — your attestation that the host prompts for approval on every request',
    )
    .option(
      '--workspace <path>',
      'workspace the session belongs to (default: current directory)',
    )
    .action(async (_opts: McpOptions, command: Command) => {
      const opts = command.optsWithGlobals<McpOptions>();
      await runStdioServer({
        workspace: resolve(opts.workspace ?? process.cwd()),
        allowWrites: opts.allowWrites === true,
        handlers: createToolHandlers(),
      });
    });
}
