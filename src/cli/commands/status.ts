// T025 — `baton context status` (US1, FR-004).
//
// Human output is the design 1a statusline row, one line: zone glyph, bold pct,
// ZONE, 22-cell eighth-block bar, tokens, 12-sample sparkline, ETA, precision
// label, data age. `--ascii` renders the canonical 16-cell fallback chip.
// `--json` emits the statusReportSchema contract document. Unknown state (FR-011):
// explicit reason, exit 3, never a fabricated zone. Estimated readings stay
// visibly labeled `estimated` (FR-013). Invalid config warns on stderr and falls
// back to defaults without affecting the exit code (FR-003).
import { resolve } from 'node:path';
import type { Command } from 'commander';
import { createClaudeCodeSessionSource } from '../../adapters/claude-code/session-source.js';
import { loadConfig } from '../../core/config/loader.js';
import type { Status, StatusOk, StatusUnknown } from '../../core/monitor/reader.js';
import {
  burnPerTurn,
  readStatus,
  sparklineSamples,
  toStatusReport,
} from '../../core/monitor/reader.js';
import type { GlobalOptions } from '../index.js';
import { EXIT, diagnostic, jsonResult, result } from '../output.js';
import {
  UNKNOWN_COLOR,
  UNKNOWN_GLYPH,
  ZONE_COLORS,
  ZONE_GLYPHS,
  boldText,
  colorize,
  formatAge,
  formatAscii,
  formatBar,
  formatEta,
  formatSparkline,
  formatTokens,
} from '../ui/format.js';
import { rejectionLines } from './config.js';

interface StatusOptions extends GlobalOptions {
  ascii?: boolean;
}

/** Register `status` under the `context` command group. */
export function registerStatusCommand(context: Command): void {
  context
    .command('status')
    .description('Current context zone and percentage, on demand')
    .option('--ascii', 'plain ASCII output for non-UTF terminals')
    .action(async (_opts: StatusOptions, command: Command) => {
      await runStatus(command);
    });
}

async function runStatus(command: Command): Promise<void> {
  const opts = command.optsWithGlobals<StatusOptions>();
  const workspace = resolve(opts.workspace ?? process.cwd());

  const config = loadConfig(workspace);
  if (config.errors.length > 0) {
    // Tolerated-fallback path: warn on stderr, keep going on defaults (FR-003).
    for (const line of rejectionLines(config.errors)) diagnostic(line);
  }

  const source = createClaudeCodeSessionSource();
  const status = await readStatus(source, {
    workspace,
    sessionId: opts.session,
    thresholds: config.thresholds,
    now: new Date(),
  });

  if (opts.json === true) {
    jsonResult(toStatusReport(status));
  } else if (opts.ascii === true) {
    result(
      status.state === 'ok'
        ? formatAscii(status.reading.pct, status.zone)
        : formatAscii(null, null),
    );
  } else {
    result(statusLine(status, config.thresholds.red, process.stdout.isTTY === true));
  }

  process.exitCode = status.state === 'ok' ? EXIT.ok : EXIT.noSession;
}

/** Design 1a one-line statusline row. */
function statusLine(status: Status, redThreshold: number, tty: boolean): string {
  return status.state === 'ok'
    ? okLine(status, redThreshold, tty)
    : unknownLine(status, tty);
}

function okLine(status: StatusOk, redThreshold: number, tty: boolean): string {
  const { reading, zone, history } = status;
  const glyph = colorize(ZONE_GLYPHS[zone], ZONE_COLORS[zone], tty);
  const pct = boldText(`${String(Math.round(reading.pct))}%`, tty);
  const zoneLabel = colorize(zone.toUpperCase(), ZONE_COLORS[zone], tty);
  const bar = formatBar(reading.pct);
  const tokens = formatTokens(reading.tokensUsed, reading.contextWindow);
  const sparkline = formatSparkline(sparklineSamples(history));
  const eta = formatEta(zone, reading.pct, burnPerTurn(history), redThreshold);
  const age = `updated ${formatAge(status.dataAgeSeconds)} ago`;
  // Last transition if any (contract "stdout (human)"), derived from history (US2).
  const last =
    status.lastTransition !== null
      ? ` · last ${status.lastTransition.from}→${status.lastTransition.to}`
      : '';
  return `${glyph} ${pct} ${zoneLabel} ${bar} ${tokens} ${sparkline} ${eta} · ${reading.precision}${last} · ${age}`;
}

function unknownLine(status: StatusUnknown, tty: boolean): string {
  // Design 5a UNKNOWN treatment: ◌ --% UNKNOWN, empty bar, reason, last-good age.
  const head = colorize(`${UNKNOWN_GLYPH} --% UNKNOWN`, UNKNOWN_COLOR, tty);
  const parts = [`${head} ${formatBar(null)} ${status.reason}`];
  if (status.lastGoodReading !== null && status.dataAgeSeconds !== null) {
    parts.push(`last good reading ${formatAge(status.dataAgeSeconds)} ago`);
  }
  return parts.join(' · ');
}
