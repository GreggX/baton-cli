// T021 — Contract test for `baton context config show|validate`
// (contracts/cli-interface.md "baton context config" + contract test obligations 1–3):
//   - --json output parses and validates against the zod schema in src/core/
//   - valid=false carries one named error per violation (key, value, rule — FR-003)
//   - exit codes: validate-invalid → 2; tolerated-fallback path (show) keeps exit 0;
//     bad args → 2
//   - stdout/stderr separation: --json stdout is pure JSON while warnings go to stderr
// Human `validate` rejection copy is design 5b, verbatim strings.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { DEFAULT_THRESHOLDS, configReportSchema } from '../../src/core/config/schema.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const cliEntry = join(repoRoot, 'src', 'cli', 'index.ts');
const badConfigWorkspace = join(repoRoot, 'tests', 'fixtures', 'ws-bad-config');

const DEFAULTS = { yellow: 40, orange: 60, red: 75 };

interface CliRun {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function runCli(args: string[]): CliRun {
  const proc = spawnSync(process.execPath, ['--import', 'tsx', cliEntry, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env },
  });
  if (proc.error) throw proc.error;
  return { stdout: proc.stdout, stderr: proc.stderr, exitCode: proc.status ?? -1 };
}

const tempDirs: string[] = [];

function makeWorkspace(config?: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'baton-config-contract-'));
  tempDirs.push(dir);
  if (config !== undefined) {
    writeFileSync(join(dir, 'baton.config.json'), JSON.stringify(config));
  }
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Parse a --json stdout and require it to be a single zod-valid config report. */
function parseReport(run: CliRun): ReturnType<typeof configReportSchema.parse> {
  // Obligation 3: --json stdout is pure JSON — parseable end-to-end.
  const parsed: unknown = JSON.parse(run.stdout);
  return configReportSchema.parse(parsed);
}

describe('baton context config show', () => {
  it('absent config: zod-valid JSON, defaults, source "defaults", exit 0', () => {
    const run = runCli(['context', 'config', 'show', '--json', '--workspace', makeWorkspace()]);
    expect(run.exitCode).toBe(0);
    const report = parseReport(run);
    expect(report).toEqual({
      valid: true,
      thresholds: DEFAULTS,
      source: 'defaults',
      errors: [],
    });
  });

  it('valid config file: file thresholds, source "file", exit 0', () => {
    const workspace = makeWorkspace({ thresholds: { yellow: 20, orange: 50, red: 80 } });
    const run = runCli(['context', 'config', 'show', '--json', '--workspace', workspace]);
    expect(run.exitCode).toBe(0);
    const report = parseReport(run);
    expect(report).toEqual({
      valid: true,
      thresholds: { yellow: 20, orange: 50, red: 80 },
      source: 'file',
      errors: [],
    });
  });

  it('invalid config (tolerated-fallback path): valid=false with named errors, defaults in effect, exit STAYS 0, warning on stderr', () => {
    const run = runCli(['context', 'config', 'show', '--json', '--workspace', badConfigWorkspace]);
    expect(run.exitCode).toBe(0); // invalid config is never fatal outside `validate` (FR-003)
    const report = parseReport(run);
    expect(report.valid).toBe(false);
    expect(report.thresholds).toEqual(DEFAULTS);
    expect(report.source).toBe('defaults');
    // named per-violation error: key, value, violated rule (FR-003)
    expect(report.errors).toEqual([
      {
        key: 'thresholds.orange',
        value: 60,
        rule: 'must be greater than thresholds.yellow (65)',
      },
    ]);
    // Obligation 3: stdout stayed pure JSON (parsed above) while the warning went to stderr.
    expect(run.stderr).toContain('invalid thresholds');
  });

  it('human output names the effective thresholds and their source', () => {
    const run = runCli(['context', 'config', 'show', '--workspace', makeWorkspace()]);
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain('40');
    expect(run.stdout).toContain('60');
    expect(run.stdout).toContain('75');
    expect(run.stdout).toContain('defaults');
  });

  it('honors global flags placed before the subcommand', () => {
    const run = runCli(['--json', '--workspace', badConfigWorkspace, 'context', 'config', 'show']);
    expect(run.exitCode).toBe(0);
    const report = parseReport(run);
    expect(report.valid).toBe(false);
  });
});

describe('baton context config validate', () => {
  it('valid config: exit 0, zod-valid JSON with valid=true and source "file"', () => {
    const workspace = makeWorkspace({ thresholds: { yellow: 20, orange: 50, red: 80 } });
    const run = runCli(['context', 'config', 'validate', '--json', '--workspace', workspace]);
    expect(run.exitCode).toBe(0);
    const report = parseReport(run);
    expect(report.valid).toBe(true);
    expect(report.source).toBe('file');
    expect(report.errors).toEqual([]);
  });

  it('absent config: exit 0 — defaults are a valid configuration', () => {
    const run = runCli(['context', 'config', 'validate', '--workspace', makeWorkspace()]);
    expect(run.exitCode).toBe(0);
  });

  it('invalid config: exit 2 with each violation named (key, value, rule) in --json', () => {
    const run = runCli([
      'context',
      'config',
      'validate',
      '--json',
      '--workspace',
      badConfigWorkspace,
    ]);
    expect(run.exitCode).toBe(2);
    const report = parseReport(run);
    expect(report.valid).toBe(false);
    expect(report.thresholds).toEqual(DEFAULTS);
    expect(report.errors).toEqual([
      {
        key: 'thresholds.orange',
        value: 60,
        rule: 'must be greater than thresholds.yellow (65)',
      },
    ]);
  });

  it('multiple violations produce one named error each', () => {
    const workspace = makeWorkspace({ thresholds: { yellow: 80, orange: 60, red: 50 } });
    const run = runCli(['context', 'config', 'validate', '--json', '--workspace', workspace]);
    expect(run.exitCode).toBe(2);
    const report = parseReport(run);
    expect(report.errors).toEqual([
      { key: 'thresholds.orange', value: 60, rule: 'must be greater than thresholds.yellow (80)' },
      { key: 'thresholds.red', value: 50, rule: 'must be greater than thresholds.orange (60)' },
    ]);
  });

  it('invalid config, human output: design 5b rejection copy with numbered problems, exit 2', () => {
    const run = runCli(['context', 'config', 'validate', '--workspace', badConfigWorkspace]);
    expect(run.exitCode).toBe(2);
    // design 5b, verbatim
    expect(run.stdout).toContain('✗ invalid thresholds — configuration rejected');
    expect(run.stdout).toContain('nothing changed — defaults in effect: 40 / 60 / 75');
    // numbered problems naming key, value, and violated rule
    const problemLine = run.stdout
      .split('\n')
      .find((line) => /^\s*1\./.test(line));
    expect(problemLine).toBeDefined();
    expect(problemLine).toContain('orange (60)');
    expect(problemLine).toContain('yellow (65)');
  });

  it('the defaults-in-effect line reflects the canonical defaults', () => {
    expect(DEFAULT_THRESHOLDS).toEqual(DEFAULTS);
  });
});

describe('invalid invocation (exit-code map)', () => {
  it('unknown config subcommand exits 2', () => {
    const run = runCli(['context', 'config', 'frobnicate']);
    expect(run.exitCode).toBe(2);
    expect(run.stderr.length).toBeGreaterThan(0);
  });

  it('unknown option exits 2', () => {
    const run = runCli(['context', 'config', 'show', '--bogus']);
    expect(run.exitCode).toBe(2);
    expect(run.stderr.length).toBeGreaterThan(0);
  });
});
