// T042 — Contract test for `baton context scan`
// (contracts/cli-interface.md "baton context scan" + contract obligations 1, 3, 5):
//   - --json shape validates against the core zod schema: sessionId, deterministic
//     `fingerprint`, `rulesChecked` populated, candidates with rule ids and spans
//   - --category filters candidates AND the rules checked (repeatable)
//   - explicit empty result: candidates [], rulesChecked populated, exit 0 (US3-AS3)
//   - determinism (FR-012/SC-005): two runs over the same fixture are byte-identical
//   - human output: design 3b rows (rule + matched phrase, excerpt, `turn N · role`),
//     design 3c empty state naming the rules checked, trailing fingerprint line
// Fixtures are generated into an isolated temp root so parallel test files never clash.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SESSION_IDS, generateFixtures } from '../../scripts/fixtures/generate-fixtures.js';
import { HEURISTIC_RULES, rulesForCategories } from '../../src/core/heuristics/rules.js';
import { candidateId, scanReportSchema } from '../../src/core/heuristics/scanner.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const cliEntry = join(repoRoot, 'src', 'cli', 'index.ts');

let fixtureRoot: string; // temp root: <fixtureRoot>/tests/fixtures/{claude,ws-*}
let claudeDir: string;
const ws = (name: string): string => join(fixtureRoot, 'tests', 'fixtures', name);

beforeAll(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'baton-scan-contract-'));
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

describe('baton context scan --json (contract shape)', () => {
  it('validates against the core zod schema with rulesChecked and fingerprint', () => {
    const run = runCli(['context', 'scan', '--json', '--workspace', ws('ws-decisions')]);
    expect(run.exitCode).toBe(0);
    const report = scanReportSchema.parse(JSON.parse(run.stdout)); // pure JSON stdout
    expect(report.sessionId).toBe(SESSION_IDS.decisions);
    expect(report.rulesChecked).toEqual(HEURISTIC_RULES.map((rule) => rule.id));
    expect(report.candidates.length).toBeGreaterThan(0);
    for (const candidate of report.candidates) {
      expect(report.rulesChecked).toContain(candidate.ruleId);
      expect(candidate.status).toBe('surfaced');
      expect(candidate.sessionId).toBe(SESSION_IDS.decisions);
    }
  });

  it('surfaces the ws-decisions candidates with stable ids and correct spans', () => {
    const run = runCli(['context', 'scan', '--json', '--workspace', ws('ws-decisions')]);
    const report = scanReportSchema.parse(JSON.parse(run.stdout));
    // Transcript layout: line 2 = "We decided to use the adapter approach…",
    // line 4 = "The root cause … so we agreed to keep the 500ms debounce…".
    const byRule = new Map(report.candidates.map((c) => [c.ruleId, c]));
    const decided = byRule.get('decision.decided-to');
    expect(decided?.span).toEqual({ startLine: 2, endLine: 2 });
    expect(decided?.excerpt).toContain('We decided to use the adapter approach');
    expect(decided?.id).toBe(
      candidateId(SESSION_IDS.decisions, 'decision.decided-to', {
        startLine: 2,
        endLine: 2,
      }),
    );
    expect(byRule.get('decision.agreed-to')?.span).toEqual({ startLine: 4, endLine: 4 });
    expect(byRule.get('conclusion.root-cause')?.span).toEqual({ startLine: 4, endLine: 4 });
  });

  it('--category filters candidates and rulesChecked (repeatable)', () => {
    const one = runCli([
      'context',
      'scan',
      '--json',
      '--category',
      'decision',
      '--workspace',
      ws('ws-decisions'),
    ]);
    expect(one.exitCode).toBe(0);
    const decisionOnly = scanReportSchema.parse(JSON.parse(one.stdout));
    expect(decisionOnly.rulesChecked).toEqual(
      rulesForCategories(['decision']).map((rule) => rule.id),
    );
    for (const candidate of decisionOnly.candidates) {
      expect(candidate.ruleId.startsWith('decision.')).toBe(true);
    }

    const two = runCli([
      'context',
      'scan',
      '--json',
      '--category',
      'decision',
      '--category',
      'conclusion',
      '--workspace',
      ws('ws-decisions'),
    ]);
    expect(two.exitCode).toBe(0);
    const both = scanReportSchema.parse(JSON.parse(two.stdout));
    expect(both.rulesChecked).toEqual(
      rulesForCategories(['decision', 'conclusion']).map((rule) => rule.id),
    );
    expect(both.candidates.length).toBeGreaterThan(decisionOnly.candidates.length);
  });

  it('rejects an unknown --category with exit 2', () => {
    const run = runCli([
      'context',
      'scan',
      '--json',
      '--category',
      'vibes',
      '--workspace',
      ws('ws-decisions'),
    ]);
    expect(run.exitCode).toBe(2);
    expect(run.stderr).toContain('vibes');
  });

  it('empty result is explicit: candidates [], rulesChecked populated, exit 0', () => {
    const run = runCli(['context', 'scan', '--json', '--workspace', ws('ws-no-matches')]);
    expect(run.exitCode).toBe(0); // empty scan results are success per contract
    const report = scanReportSchema.parse(JSON.parse(run.stdout));
    expect(report.candidates).toEqual([]);
    expect(report.rulesChecked).toEqual(HEURISTIC_RULES.map((rule) => rule.id));
    expect(report.fingerprint).toMatch(/^[0-9a-f]{6}$/);
  });

  it('scanning identical content twice is byte-identical (FR-012, obligation 5)', () => {
    const first = runCli(['context', 'scan', '--json', '--workspace', ws('ws-decisions')]);
    const second = runCli(['context', 'scan', '--json', '--workspace', ws('ws-decisions')]);
    expect(first.exitCode).toBe(0);
    expect(second.stdout).toBe(first.stdout); // byte-identical, fingerprint included
  });

  it('no session data at all: exit 3', () => {
    const empty = mkdtempSync(join(tmpdir(), 'baton-scan-nosession-'));
    try {
      const run = runCli(['context', 'scan', '--json', '--workspace', empty]);
      expect(run.exitCode).toBe(3);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe('baton context scan (human output, design 3b/3c)', () => {
  it('lists candidates as rule + matched phrase + excerpt + turn/role rows', () => {
    const run = runCli(['context', 'scan', '--workspace', ws('ws-decisions')]);
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain('decision.decided-to');
    expect(run.stdout).toContain('matched "we decided"');
    expect(run.stdout).toContain('We decided to use the adapter approach');
    expect(run.stdout).toContain('turn 2 · assistant');
    expect(run.stdout).toContain('turn 4 · assistant');
    // output ends with the fingerprint line (design 3c)
    const lines = run.stdout.trimEnd().split('\n');
    expect(lines[lines.length - 1]).toMatch(/^fingerprint [0-9a-f]{6}$/);
  });

  it('human reruns are byte-identical too', () => {
    const first = runCli(['context', 'scan', '--workspace', ws('ws-decisions')]);
    const second = runCli(['context', 'scan', '--workspace', ws('ws-decisions')]);
    expect(second.stdout).toBe(first.stdout);
  });

  it('empty state names the rules checked and stays exit 0 (design 3c)', () => {
    const run = runCli(['context', 'scan', '--workspace', ws('ws-no-matches')]);
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain('○ No artifact candidates found.');
    expect(run.stdout).toContain(
      `None of the ${String(HEURISTIC_RULES.length)} rules (decision · conclusion · constraint · result · task · question) matched this session's content.`,
    );
    expect(run.stdout).toContain('Nothing was written to the workspace.');
    expect(run.stdout).toContain('fingerprint');
  });
});
