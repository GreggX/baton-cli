// T047 — Contract test for `baton context save`
// (contracts/cli-interface.md "baton context save" + obligations 1–3, SC-004):
//   - --json shape validates against the core zod schema: saved[{candidateId, path}]
//   - only accepted candidates are written; everything else leaves no file
//   - unknown candidate id → exit 2 with the offending id on stderr, and NOTHING
//     is written even when valid ids are in the same invocation (no partial writes)
//   - the artifact file carries provenance frontmatter (sessionId, ruleId,
//     category, span, savedAt) and the design 3d body (header, session/turn/
//     timestamp, rule + matched phrase, saved line, verbatim `>` excerpt)
//   - no ids on a non-TTY: exit 2 (interactive review needs a terminal)
// Fixtures are generated into an isolated temp root so parallel test files never clash.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { SESSION_IDS, generateFixtures } from '../../scripts/fixtures/generate-fixtures.js';
import { saveReportSchema } from '../../src/core/artifacts/store.js';
import { scanReportSchema } from '../../src/core/heuristics/scanner.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const cliEntry = join(repoRoot, 'src', 'cli', 'index.ts');

let fixtureRoot: string; // temp root: <fixtureRoot>/tests/fixtures/{claude,ws-*}
let claudeDir: string;
const ws = (name: string): string => join(fixtureRoot, 'tests', 'fixtures', name);
const artifactsDir = (workspace: string): string => join(workspace, '.baton', 'artifacts');

beforeAll(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'baton-save-contract-'));
  generateFixtures(fixtureRoot);
  claudeDir = join(fixtureRoot, 'tests', 'fixtures', 'claude');
});

afterAll(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
});

afterEach(() => {
  // Each test starts from a clean workspace — saved artifacts don't leak across tests.
  rmSync(join(ws('ws-decisions'), '.baton'), { recursive: true, force: true });
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

/** Candidate ids for ws-decisions, via the scan contract surface. */
function scanCandidates(): { id: string; ruleId: string; excerpt: string }[] {
  const run = runCli(['context', 'scan', '--json', '--workspace', ws('ws-decisions')]);
  expect(run.exitCode).toBe(0);
  return scanReportSchema.parse(JSON.parse(run.stdout)).candidates;
}

describe('baton context save <candidate-id> --json (explicit mode)', () => {
  it('writes exactly the accepted candidate and reports {candidateId, path}', () => {
    const candidates = scanCandidates();
    const decided = candidates.find((c) => c.ruleId === 'decision.decided-to');
    if (decided === undefined) throw new Error('expected decision.decided-to candidate');

    const run = runCli([
      'context',
      'save',
      decided.id,
      '--json',
      '--workspace',
      ws('ws-decisions'),
    ]);
    expect(run.exitCode).toBe(0);
    const report = saveReportSchema.parse(JSON.parse(run.stdout)); // pure JSON stdout
    expect(report.saved).toHaveLength(1);
    expect(report.saved[0]?.candidateId).toBe(decided.id);
    const path = report.saved[0]?.path ?? '';
    expect(path.startsWith(join('.baton', 'artifacts'))).toBe(true);
    expect(path).toContain('decision.decided-to');
    expect(path.endsWith('.md')).toBe(true);

    // Only the accepted candidate landed on disk — nothing else (SC-004).
    expect(existsSync(join(ws('ws-decisions'), path))).toBe(true);
    expect(readdirSync(artifactsDir(ws('ws-decisions')))).toHaveLength(1);
  });

  it('artifact file carries provenance frontmatter and the design 3d body', () => {
    const candidates = scanCandidates();
    const decided = candidates.find((c) => c.ruleId === 'decision.decided-to');
    if (decided === undefined) throw new Error('expected decision.decided-to candidate');

    const run = runCli([
      'context',
      'save',
      decided.id,
      '--json',
      '--workspace',
      ws('ws-decisions'),
    ]);
    const report = saveReportSchema.parse(JSON.parse(run.stdout));
    const content = readFileSync(join(ws('ws-decisions'), report.saved[0]?.path ?? ''), 'utf8');

    // Provenance frontmatter (data-model Artifact): sessionId, ruleId, category,
    // span, savedAt.
    expect(content).toContain(`sessionId: ${SESSION_IDS.decisions}`);
    expect(content).toContain('ruleId: decision.decided-to');
    expect(content).toContain('category: decision');
    expect(content).toContain('startLine: 2');
    expect(content).toContain('endLine: 2');
    expect(content).toContain('savedAt: ');

    // Design 3d body: header, session/turn/timestamp, rule + matched phrase,
    // the saved line, and the verbatim excerpt as a quote.
    expect(content).toContain('# Decision — ');
    expect(content).toContain(`- session: ${SESSION_IDS.decisions.slice(0, 8)} · turn 2 · 2026-07-02 18:50`);
    expect(content).toContain('- rule: decision.decided-to (matched "we decided")');
    expect(content).toContain('- saved: accepted by user before compaction');
    expect(content).toContain(`> ${decided.excerpt}`);
  });

  it('saves multiple explicit ids in one call — one file per accepted candidate', () => {
    const candidates = scanCandidates();
    expect(candidates.length).toBeGreaterThanOrEqual(2);
    const ids = candidates.slice(0, 2).map((c) => c.id);
    const run = runCli([
      'context',
      'save',
      ...ids,
      '--json',
      '--workspace',
      ws('ws-decisions'),
    ]);
    expect(run.exitCode).toBe(0);
    const report = saveReportSchema.parse(JSON.parse(run.stdout));
    expect(report.saved.map((s) => s.candidateId)).toEqual(ids);
    expect(readdirSync(artifactsDir(ws('ws-decisions')))).toHaveLength(2);
  });

  it('unknown candidate id: exit 2, id on stderr, nothing written at all', () => {
    const candidates = scanCandidates();
    const valid = candidates[0];
    if (valid === undefined) throw new Error('expected at least one candidate');

    const run = runCli([
      'context',
      'save',
      valid.id,
      'c-doesnotexist99',
      '--json',
      '--workspace',
      ws('ws-decisions'),
    ]);
    expect(run.exitCode).toBe(2);
    expect(run.stderr).toContain('c-doesnotexist99'); // the offending id, on stderr
    // No partial writes: the valid id in the same invocation wrote nothing either.
    expect(existsSync(artifactsDir(ws('ws-decisions')))).toBe(false);
  });

  it('no ids on a non-TTY: exit 2 and nothing written', () => {
    const run = runCli(['context', 'save', '--workspace', ws('ws-decisions')]);
    expect(run.exitCode).toBe(2);
    expect(existsSync(artifactsDir(ws('ws-decisions')))).toBe(false);
  });

  it('no session data at all: exit 3', () => {
    const empty = mkdtempSync(join(tmpdir(), 'baton-save-nosession-'));
    try {
      const run = runCli(['context', 'save', 'c-whatever', '--workspace', empty]);
      expect(run.exitCode).toBe(3);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
