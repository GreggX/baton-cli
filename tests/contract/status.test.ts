// T023 — Contract test for `baton context status`
// (contracts/cli-interface.md "baton context status" + contract test obligations 1–3):
//   - ok / estimated / unknown --json shapes validate against the zod schemas in src/core/
//   - exit 0 for ok AND estimated readings; exit 3 for unknown / no session (FR-011)
//   - the unknown state NEVER fabricates a zone or a reading (strict schema, no zone key)
//   - stdout is pure JSON end-to-end while config warnings go to stderr (obligation 3)
//   - human output: zone glyph, pct, ZONE, 22-cell bar, tokens, sparkline, ETA,
//     precision label, data age (design 1a); `--ascii` fallback format (design canonical)
// Fixtures are generated into an isolated temp root so parallel test files never clash.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SESSION_IDS, generateFixtures } from '../../scripts/fixtures/generate-fixtures.js';
import {
  statusReportSchema,
  statusUnknownReportSchema,
} from '../../src/core/monitor/reader.js';
import { ZONE_GUIDANCE } from '../../src/core/monitor/zones.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const cliEntry = join(repoRoot, 'src', 'cli', 'index.ts');

let fixtureRoot: string; // temp root: <fixtureRoot>/tests/fixtures/{claude,ws-*}
let claudeDir: string;
const ws = (name: string): string => join(fixtureRoot, 'tests', 'fixtures', name);

beforeAll(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'baton-status-contract-'));
  generateFixtures(fixtureRoot);
  claudeDir = join(fixtureRoot, 'tests', 'fixtures', 'claude');
});

afterAll(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
});

interface CliRun {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function runCli(args: string[]): CliRun {
  const proc = spawnSync(process.execPath, ['--import', 'tsx', cliEntry, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, BATON_CLAUDE_DIR: claudeDir },
  });
  if (proc.error) throw proc.error;
  return { stdout: proc.stdout, stderr: proc.stderr, exitCode: proc.status ?? -1 };
}

/** Obligation 3: --json stdout must be a single parseable JSON document. */
function parseJson(run: CliRun): unknown {
  return JSON.parse(run.stdout);
}

describe('baton context status --json (ok state)', () => {
  it('exact reading: zod-valid ok report with reading, zone, guidance; exit 0', () => {
    const run = runCli(['context', 'status', '--json', '--workspace', ws('ws-yellow')]);
    expect(run.exitCode).toBe(0);
    const report = statusReportSchema.parse(parseJson(run));
    if (report.state !== 'ok') throw new Error('expected ok state');
    expect(report.reading.sessionId).toBe(SESSION_IDS.yellow);
    expect(report.reading.tokensUsed).toBe(90_400);
    expect(report.reading.contextWindow).toBe(200_000);
    expect(report.reading.pct).toBeCloseTo(45.2, 9);
    expect(report.reading.precision).toBe('exact');
    expect(report.zone).toBe('yellow');
    expect(report.guidance).toBe(ZONE_GUIDANCE.yellow);
    expect(report.dataAgeSeconds).toBeGreaterThanOrEqual(0);
  });

  it('estimated reading (no usage accounting) keeps exit 0 and is labeled estimated', () => {
    const run = runCli([
      'context',
      'status',
      '--json',
      '--workspace',
      ws('ws-yellow'),
      '--session',
      SESSION_IDS.yellowNoUsage,
    ]);
    expect(run.exitCode).toBe(0); // exit 0 includes "estimated" readings per contract
    const report = statusReportSchema.parse(parseJson(run));
    if (report.state !== 'ok') throw new Error('expected ok state');
    expect(report.reading.precision).toBe('estimated');
    expect(report.reading.sessionId).toBe(SESSION_IDS.yellowNoUsage);
  });

  it('classifies with the workspace thresholds from baton.config.json', () => {
    // ws-green sits at 25%; with a custom yellow=20 boundary that is YELLOW.
    const configPath = join(ws('ws-green'), 'baton.config.json');
    writeFileSync(
      configPath,
      JSON.stringify({ thresholds: { yellow: 20, orange: 40, red: 60 } }),
    );
    try {
      const run = runCli(['context', 'status', '--json', '--workspace', ws('ws-green')]);
      expect(run.exitCode).toBe(0);
      const report = statusReportSchema.parse(parseJson(run));
      if (report.state !== 'ok') throw new Error('expected ok state');
      expect(report.reading.pct).toBeCloseTo(25, 9);
      expect(report.zone).toBe('yellow');
      expect(report.guidance).toBe(ZONE_GUIDANCE.yellow);
    } finally {
      rmSync(configPath, { force: true });
    }
  });

  it('reports the last transition derived from per-turn history (US2, T035)', () => {
    // ws-yellow history: 30% → 45.2% crosses the 40% boundary.
    const run = runCli(['context', 'status', '--json', '--workspace', ws('ws-yellow')]);
    expect(run.exitCode).toBe(0);
    const report = statusReportSchema.parse(parseJson(run));
    if (report.state !== 'ok') throw new Error('expected ok state');
    expect(report.lastTransition).toEqual({
      from: 'green',
      to: 'yellow',
      direction: 'escalation',
    });
  });

  it('invalid config: warning on stderr, defaults in effect, stdout stays pure JSON, exit 0', () => {
    const run = runCli(['context', 'status', '--json', '--workspace', ws('ws-bad-config')]);
    expect(run.exitCode).toBe(0); // invalid config is never fatal (FR-003)
    const report = statusReportSchema.parse(parseJson(run)); // pure JSON despite the warning
    if (report.state !== 'ok') throw new Error('expected ok state');
    expect(report.reading.pct).toBeCloseTo(45, 9);
    expect(report.zone).toBe('yellow'); // default thresholds, not the broken 65/60/75 file
    expect(run.stderr).toContain('invalid thresholds');
  });
});

describe('baton context status --json (unknown state, FR-011)', () => {
  it('empty transcript: state unknown with reason, exit 3, and NO fabricated zone', () => {
    const run = runCli(['context', 'status', '--json', '--workspace', ws('ws-empty')]);
    expect(run.exitCode).toBe(3);
    const parsed = parseJson(run);
    // strict schema: exactly {state, reason, lastGoodReading, dataAgeSeconds} — a zone
    // or reading key would fail the parse (never fabricates a zone).
    const report = statusUnknownReportSchema.parse(parsed);
    expect(report.state).toBe('unknown');
    expect(report.reason.length).toBeGreaterThan(0);
    expect(report.lastGoodReading).toBeNull();
    expect(parsed).not.toHaveProperty('zone');
    expect(parsed).not.toHaveProperty('reading');
  });

  it('workspace with no session data at all: state unknown, exit 3', () => {
    const empty = mkdtempSync(join(tmpdir(), 'baton-status-nosession-'));
    try {
      const run = runCli(['context', 'status', '--json', '--workspace', empty]);
      expect(run.exitCode).toBe(3);
      const report = statusUnknownReportSchema.parse(parseJson(run));
      expect(report.reason).toContain('no session');
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe('baton context status (human one-line, design 1a)', () => {
  it('renders glyph, pct, ZONE, 22-cell bar, tokens, sparkline, ETA, precision, data age', () => {
    const run = runCli(['context', 'status', '--workspace', ws('ws-yellow')]);
    expect(run.exitCode).toBe(0);
    const line = run.stdout;
    expect(line).toContain('◆'); // yellow zone glyph — shape is the primary channel
    expect(line).toContain('45%');
    expect(line).toContain('YELLOW');
    // 22-cell eighth-block bar: 45.2% → exactly 10 full cells then 12 dots
    expect(line).toContain('▕██████████············▏');
    expect(line).toContain('90.4k/200k'); // one decimal on used, integer window
    expect(line).toContain('▃▄'); // sparkline over per-turn history (30% → 45.2%)
    expect(line).toContain('~2 turns→red'); // ETA from deterministic burn slope
    expect(line).toContain('exact');
    expect(line).toContain('updated');
    expect(line).toContain('ago');
  });

  it('names the last transition when one is derivable (US2, T035)', () => {
    const run = runCli(['context', 'status', '--workspace', ws('ws-yellow')]);
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain('last green→yellow');
  });

  it('labels estimated readings visibly (FR-013)', () => {
    const run = runCli([
      'context',
      'status',
      '--workspace',
      ws('ws-yellow'),
      '--session',
      SESSION_IDS.yellowNoUsage,
    ]);
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain('estimated');
  });

  it('red zone shows the handoff ETA', () => {
    const run = runCli(['context', 'status', '--workspace', ws('ws-red')]);
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain('■');
    expect(run.stdout).toContain('RED');
    expect(run.stdout).toContain('handoff now');
  });

  it('unknown state renders the 5a treatment and exits 3 — never a live zone', () => {
    const run = runCli(['context', 'status', '--workspace', ws('ws-empty')]);
    expect(run.exitCode).toBe(3);
    expect(run.stdout).toContain('◌ --% UNKNOWN');
    expect(run.stdout).not.toContain('GREEN');
    expect(run.stdout).not.toContain('YELLOW');
  });
});

describe('baton context status --ascii (canonical fallback)', () => {
  it('renders the 16-cell ASCII chip: ctx [#######.........] 45% Y', () => {
    const run = runCli(['context', 'status', '--ascii', '--workspace', ws('ws-yellow')]);
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain('ctx [#######.........] 45% Y');
  });

  it('unknown state renders (ctx -- ?) and exits 3', () => {
    const run = runCli(['context', 'status', '--ascii', '--workspace', ws('ws-empty')]);
    expect(run.exitCode).toBe(3);
    expect(run.stdout).toContain('(ctx -- ?)');
  });
});
