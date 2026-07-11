// T050 — Handoff integration (US4 independent test, quickstart scenario 7):
//   - `handoff` on ws-red produces a plain Markdown file with every design 4b
//     section — header meta, Task state (✓/◐/○), Key decisions (numbered,
//     artifact link or "captured here"), Saved artifacts (n/n verified on
//     disk), Open questions, Resume — and every derived item carries its
//     [source: rule id + turn, or artifact path] annotation (FR-010)
//   - decisions reference fixture artifacts saved beforehand; without saved
//     artifacts the decision is "— captured here (no artifact saved)"
//   - works from green (4d: the note appears, the file is still written)
//   - --out override respected (nothing lands at the default location)
//   - --json emits {path, sessionId, artifactCount}; exit 3 with no session
// Fixtures are generated into an isolated temp root so parallel files never clash.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { SESSION_IDS, generateFixtures } from '../../scripts/fixtures/generate-fixtures.js';
import { saveReportSchema } from '../../src/core/artifacts/store.js';
import { handoffReportSchema } from '../../src/core/handoff/summary.js';
import { scanReportSchema } from '../../src/core/heuristics/scanner.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const cliEntry = join(repoRoot, 'src', 'cli', 'index.ts');

let fixtureRoot: string; // temp root: <fixtureRoot>/tests/fixtures/{claude,ws-*}
let claudeDir: string;
const ws = (name: string): string => join(fixtureRoot, 'tests', 'fixtures', name);

beforeAll(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'baton-handoff-integration-'));
  generateFixtures(fixtureRoot);
  claudeDir = join(fixtureRoot, 'tests', 'fixtures', 'claude');
});

afterAll(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
});

afterEach(() => {
  // Each test starts from clean workspaces — artifacts/handoffs never leak across tests.
  rmSync(join(ws('ws-red'), '.baton'), { recursive: true, force: true });
  rmSync(join(ws('ws-green'), '.baton'), { recursive: true, force: true });
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

/** Save the ws-red decision candidate as an artifact; returns its relative path. */
function saveDecisionArtifact(): string {
  const scan = runCli(['context', 'scan', '--json', '--workspace', ws('ws-red')]);
  expect(scan.exitCode).toBe(0);
  const candidates = scanReportSchema.parse(JSON.parse(scan.stdout)).candidates;
  const decided = candidates.find((c) => c.ruleId === 'decision.decided-to');
  if (decided === undefined) throw new Error('expected decision.decided-to candidate in ws-red');
  const save = runCli(['context', 'save', decided.id, '--json', '--workspace', ws('ws-red')]);
  expect(save.exitCode).toBe(0);
  const path = saveReportSchema.parse(JSON.parse(save.stdout)).saved[0]?.path;
  if (path === undefined) throw new Error('expected a saved artifact path');
  return path;
}

/** Section body: the lines between `## <name>` and the next `##` heading. */
function sectionLines(content: string, name: string): string[] {
  const lines = content.split('\n');
  const start = lines.findIndex((line) => line.startsWith(`## ${name}`));
  expect(start, `missing section "## ${name}"`).toBeGreaterThanOrEqual(0);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith('## '));
  return rest.slice(0, end === -1 ? rest.length : end).filter((line) => line.trim() !== '');
}

describe('baton context handoff (US4, FR-010)', () => {
  it('ws-red with a saved artifact: all sections, per-item sources, artifact links', () => {
    const artifactPath = saveDecisionArtifact();

    const run = runCli(['context', 'handoff', '--json', '--workspace', ws('ws-red')]);
    expect(run.exitCode).toBe(0);

    // --json contract: {path, sessionId, artifactCount}; stdout is pure JSON.
    const report = handoffReportSchema.parse(JSON.parse(run.stdout));
    expect(report.sessionId).toBe(SESSION_IDS.red);
    expect(report.artifactCount).toBe(1);
    expect(report.path).toMatch(/^\.baton\/handoff\/\d{8}-\d{6}-handoff\.md$/);

    // Design 4a progressive output on stderr (progress, never stdout).
    expect(run.stderr).toContain('collecting — 4 turns');
    expect(run.stderr).toContain('task state 1 done · 1 in progress · 3 open');
    expect(run.stderr).toContain('verifying artifacts on disk — 1/1 present');

    const content = readFileSync(join(ws('ws-red'), report.path), 'utf8');

    // Header meta (design 4b): written-at, zone, tokens, turns, ≈tokens note.
    expect(content).toContain('# Handoff — ws-red · session 44444444');
    expect(content).toContain(' · at 80% (red) · 160.0k/200k · 4 turns');
    expect(content).toMatch(/- written \d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
    expect(content).toMatch(
      /- reading this \+ linked artifacts ≈ \d+k tokens — not the 160\.0k that produced it/,
    );

    // ## Task state — ✓ done / ◐ in progress / ○ open, each naming its source.
    expect(content).toContain(
      '- ✓ done — Next step: wire the estimation fallback into the status command. [source: turn 1 · user]',
    );
    expect(content).toContain(
      '- ◐ in progress — Should we cap the polling interval at ten seconds to keep the refresh guarantee? [source: turn 3 · user]',
    );
    expect(content).toContain(
      '- ○ open — TODO: handle the empty transcript case before release. [source: task.todo · turn 1]',
    );
    expect(content).toContain(
      '- ○ open — The remaining task is to document the cap. [source: task.next-step · turn 4]',
    );

    // ## Key decisions — numbered, linked to the saved artifact (its provenance).
    expect(content).toContain(
      `1. We decided to route every reading through the shared pipeline. → ${artifactPath} [source: ${artifactPath}]`,
    );

    // ## Saved artifacts (n/n verified on disk) — relative link + turn.
    expect(content).toContain('## Saved artifacts (1/1 verified on disk)');
    expect(content).toContain(`- ${artifactPath} · turn 2`);

    // ## Open questions — question-rule matches with rule id + turn sources.
    expect(content).toContain(
      '- Should we cap the polling interval at ten seconds to keep the refresh guarantee? [source: question.should-we · turn 3]',
    );
    expect(content).toMatch(
      /- Open question: should we surface the burn rate in the status line as well\? \[source: question\.[a-z-]+ · turn 4\]/,
    );

    // ## Resume — the design 4b three steps.
    const resume = sectionLines(content, 'Resume');
    expect(resume[0]).toBe(`1. start a fresh session in ${ws('ws-red')}`);
    expect(resume[1]).toBe('2. read this file · pull artifacts only as needed');
    expect(resume[2]).toMatch(/^3\. continue at: /);

    // FR-010: EVERY derived item in the derived sections carries a [source: …].
    for (const name of ['Task state', 'Key decisions', 'Open questions']) {
      const items = sectionLines(content, name).filter(
        (line) => /^(-|\d+\.)\s/.test(line) && line !== '- none',
      );
      expect(items.length).toBeGreaterThan(0);
      for (const line of items) {
        expect(line, `item without source in "## ${name}": ${line}`).toMatch(
          /\[source: [^\]]+\]$/,
        );
      }
    }
  });

  it('without saved artifacts: decision is captured here, 0/0 verified', () => {
    const run = runCli(['context', 'handoff', '--json', '--workspace', ws('ws-red')]);
    expect(run.exitCode).toBe(0);
    const report = handoffReportSchema.parse(JSON.parse(run.stdout));
    expect(report.artifactCount).toBe(0);

    const content = readFileSync(join(ws('ws-red'), report.path), 'utf8');
    // Decisions survive even when no artifact was saved (design 4b item 2).
    expect(content).toContain(
      '1. We decided to route every reading through the shared pipeline. — captured here (no artifact saved) [source: decision.decided-to · turn 2]',
    );
    expect(content).toContain('## Saved artifacts (0/0 verified on disk)');
  });

  it('works from green (4d): note on stderr, identical capability, file written', () => {
    const run = runCli(['context', 'handoff', '--json', '--workspace', ws('ws-green')]);
    expect(run.exitCode).toBe(0);

    // Design 4d green-zone note — advisory, on stderr, never blocks the write.
    expect(run.stderr).toContain("you're in green — a handoff isn't needed yet");

    const report = handoffReportSchema.parse(JSON.parse(run.stdout));
    expect(report.sessionId).toBe(SESSION_IDS.green);
    const content = readFileSync(join(ws('ws-green'), report.path), 'utf8');
    expect(content).toContain('# Handoff — ws-green · session 11111111');
    expect(content).toContain('(green)');
    for (const heading of ['## Task state', '## Key decisions', '## Open questions', '## Resume']) {
      expect(content).toContain(heading);
    }
  });

  it('--out override respected; human output ends with + path and HANDOFF READY', () => {
    const outDir = mkdtempSync(join(tmpdir(), 'baton-handoff-out-'));
    try {
      const outPath = join(outDir, 'my-handoff.md');
      const run = runCli([
        'context',
        'handoff',
        '--out',
        outPath,
        '--workspace',
        ws('ws-red'),
      ]);
      expect(run.exitCode).toBe(0);

      // The file landed exactly where --out pointed…
      expect(existsSync(outPath)).toBe(true);
      const content = readFileSync(outPath, 'utf8');
      expect(content).toContain('# Handoff — ws-red · session 44444444');

      // …and nowhere else: the default location was not created, and the
      // handoff command performed no other workspace write.
      expect(existsSync(join(ws('ws-red'), '.baton'))).toBe(false);

      // Design 4a completion: `+ <path>` then the HANDOFF READY box (stdout).
      expect(run.stdout).toContain(`+ ${outPath}`);
      expect(run.stdout).toContain('⏺ HANDOFF READY — this session can end without losing state');
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it('single write only: exactly one handoff file per invocation', () => {
    const run = runCli(['context', 'handoff', '--json', '--workspace', ws('ws-red')]);
    expect(run.exitCode).toBe(0);
    const handoffDir = join(ws('ws-red'), '.baton', 'handoff');
    expect(readdirSync(handoffDir).filter((name) => name.endsWith('.md'))).toHaveLength(1);
  });

  it('no session data at all: exit 3, nothing written', () => {
    const empty = mkdtempSync(join(tmpdir(), 'baton-handoff-nosession-'));
    try {
      const run = runCli(['context', 'handoff', '--workspace', empty]);
      expect(run.exitCode).toBe(3);
      expect(existsSync(join(empty, '.baton'))).toBe(false);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
