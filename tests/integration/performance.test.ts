// T054 — Performance (plan Performance Goals, FR-001):
//   - the heuristic scan of a generated 10 MB transcript completes in < 5 s
//     (read + tolerant JSONL parse + full-registry scan + fingerprint);
//   - a usage reading refreshes within ≤ 10 s of new session activity (append),
//     proven on the SAME 10 MB transcript through the real `watch --json` stream.
//
// The transcript is generated deterministically (no randomness, no clock in the
// content) into an isolated temp session-data root.
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClaudeCodeSessionSource } from '../../src/adapters/claude-code/session-source.js';
import { HEURISTIC_RULES } from '../../src/core/heuristics/rules.js';
import { scanContent, scanFingerprint } from '../../src/core/heuristics/scanner.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const cliEntry = join(repoRoot, 'src', 'cli', 'index.ts');

const SESSION_ID = 'abcdefab-1234-4abc-8abc-abcdefabcdef';
const MODEL = 'claude-sonnet-4-5';
const TARGET_BYTES = 10 * 1024 * 1024; // 10 MB

let root: string;
let claudeDir: string;
let workspace: string;
let transcriptPath: string;
let turnCount = 0;

/** Deterministic filler prose (~50 chars per sentence), no clock, no randomness. */
function fillerSentence(turn: number, index: number): string {
  return `Segment ${String(turn)}.${String(index)} keeps the reader parsing steadily through plain conversational filler text.`;
}

function userLine(turn: number): string {
  return JSON.stringify({
    type: 'user',
    uuid: `00000000-0000-4000-9000-${String(turn).padStart(12, '0')}`,
    parentUuid: null,
    sessionId: SESSION_ID,
    timestamp: `2026-07-02T18:00:${String(turn % 60).padStart(2, '0')}.000Z`,
    cwd: workspace,
    version: '2.0.0',
    gitBranch: 'main',
    message: {
      role: 'user',
      content: [{ type: 'text', text: `Continue with block ${String(turn)} of the long-running task.` }],
    },
  });
}

function assistantLine(turn: number): string {
  const sentences: string[] = [];
  for (let index = 0; index < 20; index += 1) sentences.push(fillerSentence(turn, index));
  // Sprinkle heuristic matter so the scan produces real candidates as it would
  // on a live session (every 25th turn carries a decision phrase).
  if (turn % 25 === 0) {
    sentences.push(`We decided to keep block ${String(turn)} deterministic across replays.`);
  }
  return JSON.stringify({
    type: 'assistant',
    uuid: `00000000-0000-4000-a000-${String(turn).padStart(12, '0')}`,
    parentUuid: null,
    sessionId: SESSION_ID,
    timestamp: `2026-07-02T18:01:${String(turn % 60).padStart(2, '0')}.000Z`,
    cwd: workspace,
    version: '2.0.0',
    gitBranch: 'main',
    message: {
      id: `msg_perf_${String(turn).padStart(6, '0')}`,
      type: 'message',
      role: 'assistant',
      model: MODEL,
      content: [{ type: 'text', text: sentences.join(' ') }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: {
        input_tokens: 2000,
        cache_creation_input_tokens: 3000,
        cache_read_input_tokens: 64_000 + turn, // grows per turn, stays green (~35%)
        output_tokens: 1000,
      },
    },
  });
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'baton-performance-'));
  workspace = join(root, 'ws-huge');
  mkdirSync(workspace, { recursive: true });
  claudeDir = join(root, 'claude');
  const projectDir = join(claudeDir, 'projects', workspace.replaceAll('/', '-'));
  mkdirSync(projectDir, { recursive: true });
  transcriptPath = join(projectDir, `${SESSION_ID}.jsonl`);

  // Deterministic generation up to ≥ 10 MB (chunked appends keep memory flat).
  const lines: string[] = [];
  let bytes = 0;
  writeFileSync(transcriptPath, '');
  while (bytes < TARGET_BYTES) {
    turnCount += 1;
    const chunk = `${userLine(turnCount)}\n${assistantLine(turnCount)}\n`;
    lines.push(chunk);
    bytes += Buffer.byteLength(chunk);
    if (lines.length >= 500) {
      appendFileSync(transcriptPath, lines.join(''));
      lines.length = 0;
    }
  }
  if (lines.length > 0) appendFileSync(transcriptPath, lines.join(''));
}, 60_000);

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('performance goals (plan Technical Context)', () => {
  it('scans the 10 MB transcript with the full rule registry in < 5 s', { timeout: 30_000 }, async () => {
    expect(statSync(transcriptPath).size).toBeGreaterThanOrEqual(TARGET_BYTES);

    const source = createClaudeCodeSessionSource({ claudeDir });
    const session = await source.resolveSession({ workspace });
    if (session === null) throw new Error('expected the generated session to resolve');

    const startedAt = performance.now();
    const blocks = await source.contentForScan(session);
    const candidates = scanContent({ sessionId: session.id, blocks, rules: HEURISTIC_RULES });
    const fingerprint = scanFingerprint(candidates);
    const elapsedMs = performance.now() - startedAt;

    expect(blocks.length).toBeGreaterThanOrEqual(2 * turnCount - 1);
    expect(candidates.length).toBeGreaterThan(0); // the sprinkled decision phrases
    expect(fingerprint).toMatch(/^[0-9a-f]{6}$/);
    expect(elapsedMs).toBeLessThan(5000);
  });

  it(
    'refreshes the reading ≤ 10 s after new activity on the 10 MB transcript (FR-001)',
    { timeout: 90_000 },
    async () => {
      const child: ChildProcessWithoutNullStreams = spawn(
        process.execPath,
        ['--import', 'tsx', cliEntry, 'context', 'watch', '--json', '--interval', '1', '--workspace', workspace],
        { cwd: repoRoot, env: { ...process.env, BATON_CLAUDE_DIR: claudeDir } },
      );
      const events: { reading?: { tokensUsed: number } }[] = [];
      const waiters: { predicate: (event: unknown) => boolean; fulfill: () => void }[] = [];
      const rl = createInterface({ input: child.stdout });
      rl.on('line', (line) => {
        if (line.trim() === '') return;
        const event = JSON.parse(line) as { reading?: { tokensUsed: number } };
        events.push(event);
        for (let index = waiters.length - 1; index >= 0; index -= 1) {
          const waiter = waiters[index];
          if (waiter !== undefined && waiter.predicate(event)) {
            waiters.splice(index, 1);
            waiter.fulfill();
          }
        }
      });
      const waitFor = (predicate: (event: unknown) => boolean, timeoutMs: number): Promise<void> =>
        new Promise((fulfill, reject) => {
          if (events.some(predicate)) {
            fulfill();
            return;
          }
          const timer = setTimeout(() => {
            reject(new Error(`no matching event within ${String(timeoutMs)}ms`));
          }, timeoutMs);
          waiters.push({
            predicate,
            fulfill: () => {
              clearTimeout(timer);
              fulfill();
            },
          });
        });

      try {
        // Initial reading of the 10 MB transcript (cold start excluded from FR-001).
        await waitFor(
          (event) => (event as { event?: string }).event === 'reading',
          60_000,
        );

        // New session activity: one appended turn with a fresh usage total.
        const newTotal = 2000 + 3000 + 90_000 + 1000; // 96,000 tokens
        const appendedAt = performance.now();
        appendFileSync(
          transcriptPath,
          `${JSON.stringify({
            type: 'assistant',
            uuid: 'ffffffff-ffff-4fff-9fff-ffffffffffff',
            parentUuid: null,
            sessionId: SESSION_ID,
            timestamp: '2026-07-02T19:00:00.000Z',
            cwd: workspace,
            version: '2.0.0',
            gitBranch: 'main',
            message: {
              id: 'msg_perf_refresh',
              type: 'message',
              role: 'assistant',
              model: MODEL,
              content: [{ type: 'text', text: 'Fresh activity lands on the big transcript.' }],
              stop_reason: 'end_turn',
              stop_sequence: null,
              usage: {
                input_tokens: 2000,
                cache_creation_input_tokens: 3000,
                cache_read_input_tokens: 90_000,
                output_tokens: 1000,
              },
            },
          })}\n`,
        );

        await waitFor(
          (event) =>
            (event as { reading?: { tokensUsed?: number } }).reading?.tokensUsed === newTotal,
          10_000, // the FR-001 guarantee itself
        );
        expect(performance.now() - appendedAt).toBeLessThanOrEqual(10_000);
      } finally {
        const exited = new Promise((fulfill) => child.once('exit', fulfill));
        child.kill('SIGINT');
        await exited;
      }
    },
  );
});
