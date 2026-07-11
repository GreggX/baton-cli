// T037 — Contract test for `baton context watch` transition events (US2,
// contracts/cli-interface.md "baton context watch" + contract obligation 4):
//   - a multi-band jump emits EXACTLY ONE zone_transition, naming the final zone
//     only (FR-005), followed by exactly one recommendation whose guidance names
//     every threshold crossed (FR-006)
//   - dismissed recommendations are not re-emitted while the zone is unchanged
//     (FR-014), and a persisted lastZone gives restart continuity (no duplicate
//     transition when the watch restarts inside the same zone)
//   - every NDJSON line validates against the zod schemas in src/core/
//   - the only unprompted write is the tool's own .baton/state.json
// Fixtures are generated into an isolated temp root so parallel files never clash.
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { SESSION_IDS, generateFixtures } from '../../scripts/fixtures/generate-fixtures.js';
import {
  watchEventSchema,
  watchReadingEventSchema,
  watchRecommendationEventSchema,
  watchTransitionEventSchema,
} from '../../src/core/monitor/reader.js';
import { dismiss, zoneRecommendationId } from '../../src/core/monitor/recommendations.js';
import { emptyMonitorState, saveMonitorState } from '../../src/core/monitor/state.js';
import { monitorStateSchema } from '../../src/core/monitor/types.js';
import { ZONE_GUIDANCE } from '../../src/core/monitor/zones.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const cliEntry = join(repoRoot, 'src', 'cli', 'index.ts');

let fixtureRoot: string;
let claudeDir: string;
const ws = (name: string): string => join(fixtureRoot, 'tests', 'fixtures', name);

beforeAll(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'baton-watch-events-contract-'));
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

interface UsageTotals {
  input: number;
  cacheCreation: number;
  cacheRead: number;
  output: number;
}

/** A Claude Code-shaped assistant turn carrying exact usage accounting. */
function assistantTurn(
  sessionId: string,
  cwd: string,
  timestamp: string,
  text: string,
  usage: UsageTotals,
): string {
  return JSON.stringify({
    type: 'assistant',
    uuid: `eeeeeeee-eeee-4eee-8eee-${timestamp.replaceAll(/\D/g, '').slice(-12).padStart(12, '0')}`,
    parentUuid: null,
    sessionId,
    timestamp,
    cwd,
    version: '2.0.0',
    gitBranch: 'main',
    message: {
      id: `msg_contract_${timestamp.replaceAll(/\D/g, '')}`,
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-4-5',
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: {
        input_tokens: usage.input,
        cache_creation_input_tokens: usage.cacheCreation,
        cache_read_input_tokens: usage.cacheRead,
        output_tokens: usage.output,
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
    ['--import', 'tsx', cliEntry, 'context', 'watch', '--json', '--interval', '1', '--workspace', workspace],
    { cwd: repoRoot, env: { ...process.env, BATON_CLAUDE_DIR: claudeDir } },
  );

  const events: unknown[] = [];
  const waiters: {
    predicate: (event: unknown) => boolean;
    fulfill: (event: unknown) => void;
  }[] = [];
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

function eventName(event: unknown): string | null {
  if (typeof event === 'object' && event !== null && 'event' in event) {
    const name = (event as { event: unknown }).event;
    return typeof name === 'string' ? name : null;
  }
  return null;
}

function transitionTo(event: unknown): string | null {
  if (eventName(event) !== 'zone_transition') return null;
  return (event as { transition: { to: string } }).transition.to;
}

function recommendationKind(event: unknown): string | null {
  if (eventName(event) !== 'recommendation') return null;
  return (event as { recommendation: { kind: string } }).recommendation.kind;
}

function readingPct(event: unknown): number | null {
  if (eventName(event) !== 'reading') return null;
  return (event as { reading: { pct: number } }).reading.pct;
}

describe('baton context watch — zone transition events (US2 contract)', () => {
  it(
    'multi-band jump emits exactly one zone_transition (final zone) + one recommendation',
    { timeout: 60_000 },
    async () => {
      const workspace = ws('ws-growing');
      const watch = startWatch(workspace);

      // Initial reading: ws-growing sits at 35% → green.
      const first = await watch.waitForEvent((event) => readingPct(event) === 35, 20_000);
      const sessionId = watchReadingEventSchema.parse(first).reading.sessionId;

      // Attach: the first classification is a transition from "unknown".
      const attach = await watch.waitForEvent(
        (event) => eventName(event) === 'zone_transition',
        10_000,
      );
      const attachEvent = watchTransitionEventSchema.parse(attach);
      expect(attachEvent.transition.from).toBe('unknown');
      expect(attachEvent.transition.to).toBe('green');

      // Multi-band jump: 35% → 68% crosses 40% AND 60% in one reading (FR-005).
      appendFileSync(
        transcriptPath(workspace),
        `${assistantTurn(sessionId, workspace, '2026-07-02T19:30:00.000Z', 'The session context grew sharply across two boundaries.', { input: 5000, cacheCreation: 6000, cacheRead: 124_000, output: 1000 })}\n`,
      );

      const jump = await watch.waitForEvent((event) => transitionTo(event) === 'orange', 10_000);
      const jumpEvent = watchTransitionEventSchema.parse(jump);
      expect(jumpEvent.transition.from).toBe('green'); // final zone only — no yellow event
      expect(jumpEvent.transition.direction).toBe('escalation');
      expect(jumpEvent.transition.reading.pct).toBeCloseTo(68, 9);
      expect(jumpEvent.guidance).toBe(ZONE_GUIDANCE.orange);

      const rec = await watch.waitForEvent(
        (event) => eventName(event) === 'recommendation',
        10_000,
      );
      const recEvent = watchRecommendationEventSchema.parse(rec);
      expect(recEvent.recommendation.kind).toBe('compact');
      expect(recEvent.recommendation.state).toBe('pending');
      expect(recEvent.recommendation.trigger.kind).toBe('zone_transition');
      expect(recEvent.recommendation.guidance).toContain('crossed 40% & 60%'); // names EVERY threshold
      expect(recEvent.recommendation.guidance).toContain(ZONE_GUIDANCE.orange);

      // Reading events precede their transition, which precedes its recommendation.
      const orangeReadingIndex = watch.events.findIndex((event) => readingPct(event) === 68);
      expect(orangeReadingIndex).toBeGreaterThanOrEqual(0);
      expect(orangeReadingIndex).toBeLessThan(watch.events.indexOf(jump));
      expect(watch.events.indexOf(jump)).toBeLessThan(watch.events.indexOf(rec));

      // Further growth INSIDE orange: one notice per crossing — nothing new fires.
      appendFileSync(
        transcriptPath(workspace),
        `${assistantTurn(sessionId, workspace, '2026-07-02T19:31:00.000Z', 'Still working inside the same zone.', { input: 5000, cacheCreation: 6000, cacheRead: 128_000, output: 1000 })}\n`,
      );
      await watch.waitForEvent((event) => readingPct(event) === 70, 10_000);

      const transitions = watch.events.filter((event) => eventName(event) === 'zone_transition');
      expect(transitions).toHaveLength(2); // attach (unknown→green) + the single jump
      expect(transitions.filter((event) => transitionTo(event) === 'orange')).toHaveLength(1);
      expect(watch.events.filter((event) => eventName(event) === 'recommendation')).toHaveLength(1);

      // Obligation: every NDJSON line validates against the shared zod schemas.
      for (const event of watch.events) watchEventSchema.parse(event);

      expect(await watch.stop()).toBe(0);

      // The persisted zone — the tool's only unprompted write — enables restarts.
      const statePath = join(workspace, '.baton', 'state.json');
      expect(existsSync(statePath)).toBe(true);
      const state = monitorStateSchema.parse(JSON.parse(readFileSync(statePath, 'utf8')));
      expect(state.sessionId).toBe(sessionId);
      expect(state.lastZone).toBe('orange');
    },
  );

  it(
    'restart continuity + dismissal: no re-emission while the zone is unchanged (FR-014)',
    { timeout: 60_000 },
    async () => {
      const workspace = ws('ws-decisions');
      const sessionId = SESSION_IDS.decisions;

      // The session is already in orange (68%) and the user dismissed the compact
      // advisory during an earlier watch run (persisted lastZone + dismissal).
      appendFileSync(
        transcriptPath(workspace),
        `${assistantTurn(sessionId, workspace, '2026-07-02T19:30:00.000Z', 'Design discussion folded into the session context.', { input: 5200, cacheCreation: 6300, cacheRead: 123_500, output: 1000 })}\n`,
      );
      saveMonitorState(
        workspace,
        dismiss(
          { ...emptyMonitorState(sessionId), lastZone: 'orange' },
          zoneRecommendationId(sessionId, 'orange'),
          'orange',
          '2026-07-02T19:30:30.000Z',
        ),
      );

      const watch = startWatch(workspace);
      await watch.waitForEvent((event) => readingPct(event) === 68, 20_000);

      // Growth that stays inside orange: still no transition, no recommendation.
      appendFileSync(
        transcriptPath(workspace),
        `${assistantTurn(sessionId, workspace, '2026-07-02T19:31:00.000Z', 'Continuing inside the same zone after the restart.', { input: 5000, cacheCreation: 7000, cacheRead: 131_000, output: 1000 })}\n`,
      );
      await watch.waitForEvent((event) => readingPct(event) === 72, 10_000);
      expect(
        watch.events.filter((event) => eventName(event) === 'zone_transition'),
      ).toHaveLength(0); // restart continuity: persisted lastZone, no duplicate notice
      expect(
        watch.events.filter(
          (event) =>
            eventName(event) === 'recommendation' &&
            recommendationKind(event) !== 'save_candidate',
        ),
      ).toHaveLength(0); // dismissed zone advisory not re-emitted while zone unchanged

      // FR-015 (contract obligation 6): inside orange the automatic read-only
      // scan offers each matching candidate EXACTLY once — one save_candidate
      // recommendation per candidate with a rule_match trigger, and no
      // re-emission on the in-zone refresh that followed.
      const saveOffers = watch.events.filter(
        (event) => recommendationKind(event) === 'save_candidate',
      );
      expect(saveOffers.length).toBeGreaterThan(0); // ws-decisions carries decision phrases
      const offeredCandidateIds = saveOffers.map((event) => {
        const parsed = watchRecommendationEventSchema.parse(event);
        expect(parsed.recommendation.state).toBe('pending');
        expect(parsed.recommendation.trigger.kind).toBe('rule_match');
        return parsed.recommendation.trigger.kind === 'rule_match'
          ? parsed.recommendation.trigger.candidateId
          : '';
      });
      expect(new Set(offeredCandidateIds).size).toBe(offeredCandidateIds.length);

      // Escalation into red re-arms and notifies again.
      appendFileSync(
        transcriptPath(workspace),
        `${assistantTurn(sessionId, workspace, '2026-07-02T19:32:00.000Z', 'The context footprint crossed into red.', { input: 4000, cacheCreation: 7000, cacheRead: 148_000, output: 1000 })}\n`,
      );
      const red = await watch.waitForEvent((event) => transitionTo(event) === 'red', 10_000);
      const redEvent = watchTransitionEventSchema.parse(red);
      expect(redEvent.transition.from).toBe('orange');
      expect(redEvent.transition.direction).toBe('escalation');
      expect(redEvent.guidance).toBe(ZONE_GUIDANCE.red);

      const rec = await watch.waitForEvent(
        (event) => recommendationKind(event) === 'new_session',
        10_000,
      );
      const recEvent = watchRecommendationEventSchema.parse(rec);
      expect(recEvent.recommendation.kind).toBe('new_session');
      expect(recEvent.recommendation.guidance).toContain('crossed 75%');

      // Already-offered candidates are not re-emitted after the escalation
      // either — still one save_candidate per candidate for the whole run.
      expect(
        watch.events.filter((event) => recommendationKind(event) === 'save_candidate'),
      ).toHaveLength(saveOffers.length);

      for (const event of watch.events) watchEventSchema.parse(event);
      expect(await watch.stop()).toBe(0);

      // Escalating out of orange re-armed (pruned) the orange dismissal.
      const state = monitorStateSchema.parse(
        JSON.parse(readFileSync(join(workspace, '.baton', 'state.json'), 'utf8')),
      );
      expect(state.lastZone).toBe('red');
      expect(state.dismissals).toEqual([]);
    },
  );
});
