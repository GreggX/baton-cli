// T022 — `baton context config show|validate` (contracts/cli-interface.md).
// show: effective thresholds + source (file/defaults); invalid config is tolerated —
//   warning on stderr, defaults in effect, exit code unaffected (FR-003).
// validate: exit 0 valid, 2 invalid with each violation named (key, value, rule);
//   human rejection copy is design 5b, verbatim.
import { resolve } from 'node:path';
import type { Command } from 'commander';
import type { LoadedConfig } from '../../core/config/loader.js';
import { loadConfig, toConfigReport } from '../../core/config/loader.js';
import type { ConfigError } from '../../core/config/schema.js';
import { DEFAULT_THRESHOLDS } from '../../core/config/schema.js';
import type { GlobalOptions } from '../index.js';
import { EXIT, diagnostic, jsonResult, result } from '../output.js';

/** Register `config show|validate` under the `context` command group. */
export function registerConfigCommand(context: Command): void {
  const config = context
    .command('config')
    .description('Inspect and validate baton.config.json zone thresholds');

  config
    .command('show')
    .description('Show the effective thresholds and their source (file or defaults)')
    .action((_opts: GlobalOptions, command: Command) => {
      runShow(command);
    });

  config
    .command('validate')
    .description('Validate baton.config.json thresholds (exit 2 when invalid)')
    .action((_opts: GlobalOptions, command: Command) => {
      runValidate(command);
    });
}

function loadForCommand(command: Command): { config: LoadedConfig; opts: GlobalOptions } {
  const opts = command.optsWithGlobals<GlobalOptions>();
  const workspace = resolve(opts.workspace ?? process.cwd());
  return { config: loadConfig(workspace), opts };
}

function runShow(command: Command): void {
  const { config, opts } = loadForCommand(command);

  // Tolerated-fallback path: violations are diagnostics, never fatal (FR-003).
  if (config.errors.length > 0) {
    for (const line of rejectionLines(config.errors)) diagnostic(line);
  }

  if (opts.json === true) {
    jsonResult(toConfigReport(config));
  } else {
    const { yellow, orange, red } = config.thresholds;
    result(`thresholds — yellow ${yellow} · orange ${orange} · red ${red}`);
    result(`source: ${config.source}`);
  }
  process.exitCode = EXIT.ok;
}

function runValidate(command: Command): void {
  const { config, opts } = loadForCommand(command);
  const report = toConfigReport(config);

  if (opts.json === true) {
    jsonResult(report);
  } else if (report.valid) {
    const { yellow, orange, red } = config.thresholds;
    result(`✓ thresholds valid — ${yellow} / ${orange} / ${red} (source: ${config.source})`);
  } else {
    for (const line of rejectionLines(config.errors)) result(line);
  }
  process.exitCode = report.valid ? EXIT.ok : EXIT.invalidInvocation;
}

/**
 * Design 5b rejection box: verbatim header and defaults footer, one numbered problem
 * per violation naming key, value, and violated rule (FR-003). Exported so every
 * command that tolerates invalid config (status, watch, …) warns with the same copy.
 */
export function rejectionLines(errors: ConfigError[]): string[] {
  const lines = ['✗ invalid thresholds — configuration rejected', ''];
  errors.forEach((error, index) => {
    lines.push(`  ${index + 1}. ${error.key} (${formatValue(error.value)}) — ${error.rule}`);
  });
  lines.push(
    '',
    `nothing changed — defaults in effect: ${DEFAULT_THRESHOLDS.yellow} / ${DEFAULT_THRESHOLDS.orange} / ${DEFAULT_THRESHOLDS.red}`,
  );
  return lines;
}

function formatValue(value: unknown): string {
  return value === undefined ? 'undefined' : JSON.stringify(value);
}
