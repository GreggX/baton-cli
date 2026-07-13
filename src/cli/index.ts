#!/usr/bin/env node
// T020 — baton CLI entry: commander program `baton` with the `context` command group,
// global flags (--json, --session, --workspace), stdout/stderr separation, and the
// exit-code map from contracts/cli-interface.md (0 ok / 1 runtime error / 2 invalid
// invocation / 3 no session).
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Command, CommanderError } from 'commander';
import { registerConfigCommand } from './commands/config.js';
import { registerHandoffCommand } from './commands/handoff.js';
import { registerMcpCommand } from './commands/mcp.js';
import { registerSaveCommand } from './commands/save.js';
import { registerScanCommand } from './commands/scan.js';
import { registerStatusCommand } from './commands/status.js';
import { registerWatchCommand } from './commands/watch.js';
import { EXIT, diagnostic } from './output.js';

/** Global options shared by every `baton context …` command (contract "Global options"). */
export interface GlobalOptions {
  /** machine-readable JSON on stdout */
  json?: boolean;
  /** override active-session resolution */
  session?: string;
  /** workspace the session belongs to (default: cwd) */
  workspace?: string;
}

/** Declare the contract's global options on a command. */
function addGlobalOptions(command: Command): Command {
  return command
    .option('--json', 'machine-readable JSON output on stdout')
    .option('--session <id>', 'override active-session resolution')
    .option('--workspace <path>', 'workspace the session belongs to (default: current directory)');
}

/**
 * Apply the global options to every command in the tree, so they are accepted in any
 * position (`baton --json context status` and `baton context status --json` alike).
 * Commands read them via `command.optsWithGlobals()`.
 */
function addGlobalOptionsDeep(command: Command): void {
  addGlobalOptions(command);
  for (const sub of command.commands) {
    addGlobalOptionsDeep(sub as Command);
  }
}

/** Build the `baton` program. Exported so tests can drive the command tree directly. */
export function buildProgram(): Command {
  const program = new Command('baton');
  program
    .description('Session Context Monitor — advisory traffic-light for agent context usage')
    .exitOverride(); // inherited by subcommands created below; mapped to exit codes in run()

  const context = program
    .command('context')
    .description('Observe session context usage (advisory only — never mutates session data)');

  registerConfigCommand(context);
  registerHandoffCommand(context);
  registerSaveCommand(context);
  registerScanCommand(context);
  registerStatusCommand(context);
  registerWatchCommand(context);

  addGlobalOptionsDeep(program);

  // Feature 002 T008: `baton mcp` is a top-level launcher (research R7), not a
  // `context` subcommand. Registered AFTER the deep pass — it declares its own
  // --workspace/--allow-writes surface and must not receive the context group's
  // global flags (which would duplicate --workspace).
  registerMcpCommand(program);
  return program;
}

/**
 * Parse and execute, translating outcomes to the contract's exit codes:
 * commander usage errors → 2; help/version → 0; unexpected errors → 1 (message on
 * stderr); otherwise whatever the command set (0/2/3), defaulting to 0.
 */
export async function run(argv: readonly string[]): Promise<number> {
  const program = buildProgram();
  try {
    await program.parseAsync([...argv], { from: 'node' });
    return typeof process.exitCode === 'number' ? process.exitCode : EXIT.ok;
  } catch (error) {
    if (error instanceof CommanderError) {
      // commander already printed its message (help → stdout, usage errors → stderr)
      return error.exitCode === 0 ? EXIT.ok : EXIT.invalidInvocation;
    }
    diagnostic(error instanceof Error ? error.message : String(error));
    return EXIT.runtimeError;
  }
}

// Run only when executed as the CLI entry (bin/tsx/node), not when imported by tests.
const invokedPath = process.argv[1];
if (invokedPath !== undefined && isEntryPoint(invokedPath)) {
  process.exitCode = await run(process.argv);
}

function isEntryPoint(argvPath: string): boolean {
  try {
    return import.meta.url === pathToFileURL(realpathSync(argvPath)).href;
  } catch {
    return false;
  }
}
