// T053 — Read-only guarantee (FR-007, SC-004, constitution Principle II).
//
// Proves, over the FULL command sweep (status/watch/scan/save/handoff/config):
//   1. session data is never touched: every fixture transcript's checksum is
//      byte-identical before and after the sweep, and nothing under the session
//      data root (BATON_CLAUDE_DIR) is created, modified, or deleted;
//   2. the only UNPROMPTED write anywhere in the workspace tree is the tool's
//      own bookkeeping file `.baton/state.json` (written by `watch`);
//   3. the explicit user actions (`save <id>`, `handoff`) write exactly their
//      accepted outputs (`.baton/artifacts/*.md`, `.baton/handoff/*.md`) and
//      nothing else.
//
// The sweep runs in two phases so "unprompted" is provable: phase A runs only
// observe-only commands and asserts state.json is the sole new file; phase B
// runs the explicit-confirmation commands and asserts only their outputs appear.
import { spawnSync } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateFixtures } from '../../scripts/fixtures/generate-fixtures.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const cliEntry = join(repoRoot, 'src', 'cli', 'index.ts');

let fixtureRoot: string; // temp root: <fixtureRoot>/tests/fixtures/{claude,ws-*,growth}
let claudeDir: string;
const ws = (name: string): string => join(fixtureRoot, 'tests', 'fixtures', name);

beforeAll(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'baton-read-only-'));
  generateFixtures(fixtureRoot);
  claudeDir = join(fixtureRoot, 'tests', 'fixtures', 'claude');
});

afterAll(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
});

// ── Filesystem snapshotting ───────────────────────────────────────────────────

/** Every file under `root` (recursive), as sorted root-relative paths. */
function walkFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files.push(relative(root, path));
    }
  };
  visit(root);
  return files.sort();
}

/** Map of root-relative path → sha256 checksum of the file's bytes. */
function checksumTree(root: string): Map<string, string> {
  const sums = new Map<string, string>();
  for (const file of walkFiles(root)) {
    sums.set(file, createHash('sha256').update(readFileSync(join(root, file))).digest('hex'));
  }
  return sums;
}

/** Paths present in `after` but not in `before` (the writes of a phase). */
function newFiles(before: Map<string, string>, after: Map<string, string>): string[] {
  return [...after.keys()].filter((path) => !before.has(path));
}

/** Assert every file that existed before still exists with identical bytes. */
function expectPreexistingUntouched(
  before: Map<string, string>,
  after: Map<string, string>,
): void {
  for (const [path, sum] of before) {
    expect(after.has(path), `file deleted: ${path}`).toBe(true);
    expect(after.get(path), `file modified: ${path}`).toBe(sum);
  }
}

// ── CLI helpers ───────────────────────────────────────────────────────────────

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

/** Run `watch --json` until `.baton/state.json` exists, then SIGINT (exit 0). */
async function runWatchUntilStateWrite(workspace: string): Promise<void> {
  const child: ChildProcessWithoutNullStreams = spawn(
    process.execPath,
    ['--import', 'tsx', cliEntry, 'context', 'watch', '--json', '--interval', '1', '--workspace', workspace],
    { cwd: repoRoot, env: { ...process.env, BATON_CLAUDE_DIR: claudeDir } },
  );
  const statePath = join(workspace, '.baton', 'state.json');
  const deadline = Date.now() + 20_000;
  try {
    while (!existsSync(statePath)) {
      if (Date.now() > deadline) throw new Error(`watch never wrote ${statePath}`);
      if (child.exitCode !== null) throw new Error('watch exited before writing state');
      await new Promise((fulfill) => setTimeout(fulfill, 100));
    }
  } finally {
    const exited = new Promise((fulfill) => child.once('exit', fulfill));
    child.kill('SIGINT');
    await exited;
  }
}

// ── The sweep ─────────────────────────────────────────────────────────────────

describe('read-only guarantee across the full command sweep (FR-007, SC-004)', () => {
  it(
    'transcripts stay byte-identical; unprompted writes are exactly .baton/state.json; explicit save/handoff write only their outputs',
    { timeout: 120_000 },
    async () => {
      // Baseline: checksum EVERY fixture file, transcripts included.
      const transcriptsBefore = checksumTree(claudeDir);
      const treeBefore = checksumTree(fixtureRoot);
      expect(
        [...transcriptsBefore.keys()].filter((path) => path.endsWith('.jsonl')).length,
      ).toBeGreaterThanOrEqual(9); // sanity: the fixture transcripts are in scope

      // ── Phase A: observe-only commands (no user confirmation involved) ──────
      expect(runCli(['context', 'status', '--json', '--workspace', ws('ws-green')]).exitCode).toBe(0);
      expect(runCli(['context', 'status', '--workspace', ws('ws-yellow')]).exitCode).toBe(0);
      expect(runCli(['context', 'status', '--ascii', '--workspace', ws('ws-red')]).exitCode).toBe(0);
      expect(runCli(['context', 'status', '--json', '--workspace', ws('ws-empty')]).exitCode).toBe(3);
      expect(runCli(['context', 'status', '--json', '--workspace', ws('ws-bad-config')]).exitCode).toBe(0);
      expect(runCli(['context', 'config', 'show', '--json', '--workspace', ws('ws-green')]).exitCode).toBe(0);
      expect(runCli(['context', 'config', 'validate', '--json', '--workspace', ws('ws-bad-config')]).exitCode).toBe(2);
      expect(runCli(['context', 'scan', '--json', '--workspace', ws('ws-decisions')]).exitCode).toBe(0);
      expect(runCli(['context', 'scan', '--workspace', ws('ws-no-matches')]).exitCode).toBe(0);
      expect(runCli(['context', 'scan', '--category', 'decision', '--workspace', ws('ws-decisions')]).exitCode).toBe(0);
      // watch on ws-orange (68%): zone entry + the automatic orange-zone scan run,
      // then SIGINT — its state persistence is the one allowed unprompted write.
      await runWatchUntilStateWrite(ws('ws-orange'));

      const treeAfterObserve = checksumTree(fixtureRoot);
      expectPreexistingUntouched(treeBefore, treeAfterObserve);
      // The ONLY unprompted write anywhere: the tool's own state file (SC-004).
      expect(newFiles(treeBefore, treeAfterObserve)).toEqual([
        join('tests', 'fixtures', 'ws-orange', '.baton', 'state.json'),
      ]);
      // state.json holds bookkeeping only — never session content.
      const state = JSON.parse(
        readFileSync(join(ws('ws-orange'), '.baton', 'state.json'), 'utf8'),
      ) as Record<string, unknown>;
      expect(Object.keys(state).sort()).toEqual(
        expect.arrayContaining(['dismissals', 'lastZone', 'sessionId']),
      );
      expect(JSON.stringify(state)).not.toContain('watcher'); // no transcript text leaked

      // ── Phase B: explicit user actions (the FR-007 confirmations) ───────────
      const scanRun = runCli(['context', 'scan', '--json', '--workspace', ws('ws-decisions')]);
      const scanReport = JSON.parse(scanRun.stdout) as { candidates: { id: string }[] };
      const candidateId = scanReport.candidates[0]?.id;
      if (candidateId === undefined) throw new Error('expected ws-decisions candidates');

      const saveRun = runCli(['context', 'save', candidateId, '--json', '--workspace', ws('ws-decisions')]);
      expect(saveRun.exitCode).toBe(0);
      const saveReport = JSON.parse(saveRun.stdout) as { saved: { path: string }[] };
      const savedPath = saveReport.saved[0]?.path;
      if (savedPath === undefined) throw new Error('expected a saved artifact path');

      const handoffRun = runCli(['context', 'handoff', '--json', '--workspace', ws('ws-red')]);
      expect(handoffRun.exitCode).toBe(0);
      const handoffReport = JSON.parse(handoffRun.stdout) as { path: string };

      const treeAfterExplicit = checksumTree(fixtureRoot);
      expectPreexistingUntouched(treeAfterObserve, treeAfterExplicit);
      // Explicit actions wrote exactly their accepted outputs — nothing else.
      expect(newFiles(treeAfterObserve, treeAfterExplicit).sort()).toEqual(
        [
          join('tests', 'fixtures', 'ws-decisions', savedPath),
          join('tests', 'fixtures', 'ws-red', handoffReport.path),
        ].sort(),
      );

      // ── Final proof: session data untouched by the WHOLE sweep ──────────────
      const transcriptsAfter = checksumTree(claudeDir);
      expect([...transcriptsAfter.keys()]).toEqual([...transcriptsBefore.keys()]);
      for (const [path, sum] of transcriptsBefore) {
        expect(transcriptsAfter.get(path), `session data modified: ${path}`).toBe(sum);
      }
    },
  );
});
