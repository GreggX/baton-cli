// T029 — Watch integration (US1 independent test, quickstart scenarios 1–3 partial):
//   - appending turns to the ws-growing fixture flips the displayed zone
//     green → yellow within 10 s (FR-001) on the NDJSON stream
//   - ws-empty NEVER fabricates a zone: only explicit reading_unavailable events
//   - SIGINT exits 0; out-of-range --interval exits 2 (contract)
// Fixtures live in an isolated temp root so parallel test files never clash, and
// the watched transcript is appended to exactly the way a live session grows.
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { generateFixtures } from '../../scripts/fixtures/generate-fixtures.js';
import {
  watchReadingEventSchema,
  watchUnavailableEventSchema,
} from '../../src/core/monitor/reader.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const cliEntry = join(repoRoot, 'src', 'cli', 'index.ts');

let fixtureRoot: string;
let claudeDir: string;
const ws = (name: string): string => join(fixtureRoot, 'tests', 'fixtures', name);

beforeAll(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'baton-watch-integration-'));
  generateFixtures(fixtureRoot);
  claudeDir = join(fixtureRoot, 'tests', 'fixtures', 'claude');
});

afterAll(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
});

/** The single transcript file inside a fixture workspace's project directory. */
function transcriptPath(workspace: string): string {
  const encoded = workspace.replaceAll('/', '-');
  const dir = join(claudeDir, 'projects', encoded);
  const names = readdirSync(dir).filter((name) => name.endsWith('.jsonl'));
  const first = names[0];
  if (names.length !== 1 || first === undefined) {
    throw new Error(`expected exactly one transcript in ${dir}`);
  }
  return join(dir, first);
}

/** A turn that moves ws-growing from 35% (green) to 45.2% (yellow). */
function yellowTurnLine(sessionId: string): string {
  return JSON.stringify({
    type: 'assistant',
    uuid: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
    parentUuid: null,
    sessionId,
    timestamp: '2026-07-02T19:20:00.000Z',
    cwd: ws('ws-growing'),
    version: '2.0.0',
    gitBranch: 'main',
    message: {
      id: 'msg_growth_yellow',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-4-5',
      content: [{ type: 'text', text: 'Context grew across the yellow boundary.' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: {
        input_tokens: 3400,
        cache_creation_input_tokens: 4200,
        cache_read_input_tokens: 82_000,
        output_tokens: 800,
      },
    },
  });
}

interface WatchProcess {
  child: ChildProcessWithoutNullStreams;
  events: unknown[];
  waitForEvent(predicate: (event: unknown) => boolean, timeoutMs: number): Promise<unknown>;
  stop(): Promise<number | null>;
}

const running: WatchProcess[] = [];

function startWatch(workspace: string): WatchProcess {
  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      cliEntry,
      'context',
      'watch',
      '--json',
      '--interval',
      '1',
      '--workspace',
      workspace,
    ],
    { cwd: repoRoot, env: { ...process.env, BATON_CLAUDE_DIR: claudeDir } },
  );

  const events: unknown[] = [];
  const waiters: { predicate: (event: unknown) => boolean; fulfill: (event: unknown) => void }[] =
    [];
  const rl = createInterface({ input: child.stdout });
  rl.on('line', (line) => {
    if (line.trim() === '') return;
    const event: unknown = JSON.parse(line); // NDJSON: every line must parse
    events.push(event);
    for (let index = waiters.length - 1; index >= 0; index -= 1) {
      const waiter = waiters[index];
      if (waiter !== undefined && waiter.predicate(event)) {
        waiters.splice(index, 1);
        waiter.fulfill(event);
      }
    }
  });
  const stderrChunks: string[] = [];
  child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk.toString()));

  const proc: WatchProcess = {
    child,
    events,
    waitForEvent(predicate, timeoutMs) {
      const existing = events.find(predicate);
      if (existing !== undefined) return Promise.resolve(existing);
      return new Promise((fulfill, reject) => {
        const timer = setTimeout(() => {
          reject(
            new Error(
              `no matching event within ${String(timeoutMs)}ms; saw: ${JSON.stringify(events)}; stderr: ${stderrChunks.join('')}`,
            ),
          );
        }, timeoutMs);
        waiters.push({
          predicate,
          fulfill: (event) => {
            clearTimeout(timer);
            fulfill(event);
          },
        });
      });
    },
    stop() {
      return new Promise((fulfill) => {
        if (child.exitCode !== null) {
          fulfill(child.exitCode);
          return;
        }
        child.once('exit', (code) => {
          fulfill(code);
        });
        child.kill('SIGINT');
      });
    },
  };
  running.push(proc);
  return proc;
}

afterEach(async () => {
  for (const proc of running.splice(0)) {
    if (proc.child.exitCode === null) {
      proc.child.kill('SIGKILL');
      await new Promise((fulfill) => proc.child.once('exit', fulfill));
    }
  }
});

function zoneOf(event: unknown): string | null {
  if (typeof event === 'object' && event !== null && 'zone' in event) {
    const zone = (event as { zone: unknown }).zone;
    return typeof zone === 'string' ? zone : null;
  }
  return null;
}

describe('baton context watch (NDJSON stream)', () => {
  it(
    'flips green → yellow within 10 s of the fixture transcript growing (FR-001)',
    { timeout: 40_000 },
    async () => {
      const watch = startWatch(ws('ws-growing'));

      // Initial reading: ws-growing sits at 35% → green.
      const first = await watch.waitForEvent(
        (event) => zoneOf(event) === 'green',
        15_000,
      );
      const firstReading = watchReadingEventSchema.parse(first);
      expect(firstReading.reading.pct).toBeCloseTo(35, 9);

      // Session activity: append a turn crossing the 40% boundary (45.2%).
      const appendedAt = Date.now();
      appendFileSync(
        transcriptPath(ws('ws-growing')),
        `${yellowTurnLine(firstReading.reading.sessionId)}\n`,
      );

      const flipped = await watch.waitForEvent(
        (event) => zoneOf(event) === 'yellow',
        10_000, // the FR-001 guarantee itself
      );
      expect(Date.now() - appendedAt).toBeLessThanOrEqual(10_000);
      const yellowReading = watchReadingEventSchema.parse(flipped);
      expect(yellowReading.reading.tokensUsed).toBe(90_400);
      expect(yellowReading.reading.pct).toBeCloseTo(45.2, 9);
      expect(yellowReading.zone).toBe('yellow');

      expect(await watch.stop()).toBe(0); // SIGINT → exit 0
    },
  );

  it(
    'ws-empty never fabricates a zone: explicit reading_unavailable only (FR-011)',
    { timeout: 40_000 },
    async () => {
      const watch = startWatch(ws('ws-empty'));

      const event = await watch.waitForEvent(
        (candidate) =>
          typeof candidate === 'object' &&
          candidate !== null &&
          'event' in candidate,
        15_000,
      );
      const unavailable = watchUnavailableEventSchema.parse(event);
      expect(unavailable.event).toBe('reading_unavailable');
      expect(unavailable.unavailable.reason.length).toBeGreaterThan(0);
      expect(unavailable.unavailable.lastGoodReading).toBeNull();

      // Let the 1 s polling fallback run a few cycles: still no zone anywhere.
      await new Promise((fulfill) => setTimeout(fulfill, 2_500));
      for (const seen of watch.events) {
        expect(zoneOf(seen)).toBeNull();
        expect((seen as { event: unknown }).event).toBe('reading_unavailable');
      }

      expect(await watch.stop()).toBe(0);
    },
  );
});

describe('baton context watch --interval bounds (contract)', () => {
  it.each(['0', '11', 'abc'])('rejects --interval %s with exit 2', (value) => {
    const proc = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        cliEntry,
        'context',
        'watch',
        '--json',
        '--interval',
        value,
        '--workspace',
        ws('ws-green'),
      ],
      { cwd: repoRoot, encoding: 'utf8', env: { ...process.env, BATON_CLAUDE_DIR: claudeDir } },
    );
    expect(proc.status).toBe(2);
    expect(proc.stderr).toContain('--interval');
  });
});
