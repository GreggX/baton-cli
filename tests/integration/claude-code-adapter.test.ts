// T017 — Claude Code adapter integration tests against the T016 fixture workspaces:
// usage extraction from the latest assistant `message.usage`, model→window map,
// unknown model → estimated, missing usage → chars/4 fallback labeled estimated,
// malformed JSONL lines skipped, most-recent-transcript discovery + `--session`
// override, lastActivityAt. Fixtures resolve through the BATON_CLAUDE_DIR root.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  MODELS,
  SESSION_IDS,
  generateFixtures,
} from '../../scripts/fixtures/generate-fixtures.js';
import {
  CLAUDE_DIR_ENV,
  encodeWorkspacePath,
  resolveSession,
} from '../../src/adapters/claude-code/discovery.js';
import {
  DEFAULT_CONTEXT_WINDOW,
  readTranscriptLines,
  readUsage,
} from '../../src/adapters/claude-code/transcript.js';
import { isReadingUnavailable, sessionRefSchema } from '../../src/core/monitor/types.js';
import type { SessionRef } from '../../src/core/monitor/types.js';
import { estimateTokens } from '../../src/lib/estimate.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const fixturesDir = join(repoRoot, 'tests', 'fixtures');
const claudeDir = join(fixturesDir, 'claude');
const ws = (name: string): string => join(fixturesDir, name);

let savedEnv: string | undefined;

beforeAll(() => {
  generateFixtures(repoRoot);
  savedEnv = process.env[CLAUDE_DIR_ENV];
  process.env[CLAUDE_DIR_ENV] = claudeDir;
});

afterAll(() => {
  if (savedEnv === undefined) Reflect.deleteProperty(process.env, CLAUDE_DIR_ENV);
  else process.env[CLAUDE_DIR_ENV] = savedEnv;
});

async function mustResolve(workspace: string, sessionId?: string): Promise<SessionRef> {
  const session = await resolveSession({ workspace, sessionId });
  expect(session).not.toBeNull();
  return session as SessionRef;
}

describe('session discovery (T018)', () => {
  it('resolves the session for a workspace through the BATON_CLAUDE_DIR root', async () => {
    const session = await mustResolve(ws('ws-green'));
    expect(sessionRefSchema.parse(session)).toEqual(session);
    expect(session.id).toBe(SESSION_IDS.green);
    expect(session.workspace).toBe(ws('ws-green'));
    expect(session.modelId).toBe(MODELS.known);
  });

  it('encodes workspace paths the way Claude Code does (absolute path, "/" → "-")', () => {
    expect(encodeWorkspacePath('/Users/dev/proj')).toBe('-Users-dev-proj');
    expect(encodeWorkspacePath(ws('ws-green'))).toBe(ws('ws-green').replaceAll('/', '-'));
  });

  it('picks the most recently active transcript when several sessions exist', async () => {
    // ws-yellow holds four transcripts; the main one carries the newest timestamps.
    const session = await mustResolve(ws('ws-yellow'));
    expect(session.id).toBe(SESSION_IDS.yellow);
  });

  it('honors an explicit session id override instead of the newest transcript', async () => {
    const session = await mustResolve(ws('ws-yellow'), SESSION_IDS.yellowNoUsage);
    expect(session.id).toBe(SESSION_IDS.yellowNoUsage);
    expect(session.workspace).toBe(ws('ws-yellow'));
  });

  it('returns null for an unknown session id override', async () => {
    const session = await resolveSession({
      workspace: ws('ws-yellow'),
      sessionId: 'no-such-session',
    });
    expect(session).toBeNull();
  });

  it('returns null for a workspace with no session data', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'baton-adapter-test-'));
    try {
      expect(await resolveSession({ workspace: dir })).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an explicit claudeDir argument overrides the environment variable', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'baton-adapter-empty-root-'));
    try {
      expect(await resolveSession({ workspace: ws('ws-green'), claudeDir: dir })).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('derives lastActivityAt from the newest transcript entry timestamp', async () => {
    const session = await mustResolve(ws('ws-yellow'));
    expect(new Date(session.lastActivityAt).toISOString()).toBe('2026-07-02T18:10:15.000Z');
  });

  it('resolves a session for the empty transcript (session exists, no content)', async () => {
    const session = await mustResolve(ws('ws-empty'));
    expect(session.id).toBe(SESSION_IDS.empty);
    expect(session.modelId).toBeNull();
  });
});

describe('usage extraction (T019)', () => {
  it('reads the LATEST assistant message.usage — earlier, smaller usage must not win', async () => {
    const session = await mustResolve(ws('ws-yellow'));
    const reading = await readUsage(session);
    expect(isReadingUnavailable(reading)).toBe(false);
    if (isReadingUnavailable(reading)) return;
    expect(reading.sessionId).toBe(SESSION_IDS.yellow);
    // input 3400 + cache_creation 4200 + cache_read 82000 + output 800 = 90,400
    expect(reading.tokensUsed).toBe(90_400);
    expect(reading.contextWindow).toBe(200_000);
    expect(reading.pct).toBeCloseTo(45.2, 9);
    expect(reading.precision).toBe('exact');
    expect(new Date(reading.timestamp).toISOString()).toBe('2026-07-02T18:10:15.000Z');
  });

  it('sums all four usage fields for the green fixture (≈25%)', async () => {
    const session = await mustResolve(ws('ws-green'));
    const reading = await readUsage(session);
    if (isReadingUnavailable(reading)) throw new Error('expected a reading');
    expect(reading.tokensUsed).toBe(50_000);
    expect(reading.pct).toBeCloseTo(25, 9);
    expect(reading.precision).toBe('exact');
  });

  it('produces the expected zone-band percentages for orange (≈68%) and red (≈80%)', async () => {
    const orange = await readUsage(await mustResolve(ws('ws-orange')));
    const red = await readUsage(await mustResolve(ws('ws-red')));
    if (isReadingUnavailable(orange) || isReadingUnavailable(red)) {
      throw new Error('expected readings');
    }
    expect(orange.pct).toBeCloseTo(68, 9);
    expect(red.pct).toBeCloseTo(80, 9);
  });

  it('is deterministic: reading the same transcript twice yields identical results', async () => {
    const session = await mustResolve(ws('ws-yellow'));
    const first = await readUsage(session);
    const second = await readUsage(session);
    expect(second).toEqual(first);
  });
});

describe('model → context window map (T019)', () => {
  it('resolves the extended-context model id to a 1M window, still exact', async () => {
    const session = await mustResolve(ws('ws-yellow'), SESSION_IDS.yellowBigWindow);
    const reading = await readUsage(session);
    if (isReadingUnavailable(reading)) throw new Error('expected a reading');
    expect(session.modelId).toBe(MODELS.bigWindow);
    expect(reading.contextWindow).toBe(1_000_000);
    expect(reading.tokensUsed).toBe(250_000);
    expect(reading.pct).toBeCloseTo(25, 9);
    expect(reading.precision).toBe('exact');
  });

  it('falls back to the conservative 200k default for an unknown model, labeled estimated', async () => {
    const session = await mustResolve(ws('ws-yellow'), SESSION_IDS.yellowUnknownModel);
    const reading = await readUsage(session);
    if (isReadingUnavailable(reading)) throw new Error('expected a reading');
    expect(session.modelId).toBe(MODELS.unknown);
    expect(reading.contextWindow).toBe(DEFAULT_CONTEXT_WINDOW);
    expect(reading.tokensUsed).toBe(50_000);
    expect(reading.precision).toBe('estimated');
  });

  it('honors a caller-supplied model→window override map', async () => {
    const session = await mustResolve(ws('ws-yellow'), SESSION_IDS.yellowUnknownModel);
    const reading = await readUsage(session, {
      modelWindows: { [MODELS.unknown]: 500_000 },
    });
    if (isReadingUnavailable(reading)) throw new Error('expected a reading');
    expect(reading.contextWindow).toBe(500_000);
    expect(reading.precision).toBe('exact');
  });
});

describe('estimation fallback when usage is missing (T019)', () => {
  it('estimates tokens as chars/4 over the reconstructed conversation, labeled estimated', async () => {
    const session = await mustResolve(ws('ws-yellow'), SESSION_IDS.yellowNoUsage);
    const reading = await readUsage(session);
    if (isReadingUnavailable(reading)) throw new Error('expected a reading');

    // Reconstruct the conversation exactly as the adapter must: every user/assistant
    // entry's text blocks, in transcript order, joined with newlines.
    const raw = readFileSync(
      join(
        claudeDir,
        'projects',
        encodeWorkspacePath(ws('ws-yellow')),
        `${SESSION_IDS.yellowNoUsage}.jsonl`,
      ),
      'utf8',
    );
    const texts: string[] = [];
    for (const line of raw.split('\n')) {
      if (line.trim() === '') continue;
      const entry = JSON.parse(line) as {
        type?: string;
        message?: { content?: { type?: string; text?: string }[] };
      };
      if (entry.type !== 'user' && entry.type !== 'assistant') continue;
      for (const block of entry.message?.content ?? []) {
        if (block.type === 'text' && typeof block.text === 'string') texts.push(block.text);
      }
    }
    const expected = estimateTokens(texts.join('\n'));

    expect(expected).toBeGreaterThan(0);
    expect(reading.tokensUsed).toBe(expected);
    expect(reading.precision).toBe('estimated');
    expect(reading.contextWindow).toBe(DEFAULT_CONTEXT_WINDOW);
  });

  it('returns the explicit unavailable state for an empty transcript — never a fake reading', async () => {
    const session = await mustResolve(ws('ws-empty'));
    const result = await readUsage(session);
    expect(isReadingUnavailable(result)).toBe(true);
    if (!isReadingUnavailable(result)) return;
    expect(result.sessionId).toBe(SESSION_IDS.empty);
    expect(result.reason.length).toBeGreaterThan(0);
    expect(result.lastGoodReading).toBeNull();
    expect(result).not.toHaveProperty('pct');
  });
});

describe('tolerant JSONL parsing (T019)', () => {
  it('skips malformed lines but still extracts the exact reading around them', async () => {
    // ws-yellow's main transcript interleaves three malformed lines (raw text,
    // truncated JSON, non-object JSON) between valid entries.
    const session = await mustResolve(ws('ws-yellow'));
    const reading = await readUsage(session);
    if (isReadingUnavailable(reading)) throw new Error('expected a reading');
    expect(reading.tokensUsed).toBe(90_400);
    expect(reading.precision).toBe('exact');
  });

  it('reports skipped line numbers and keeps valid entries with their 1-indexed lines', () => {
    const raw = [
      '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"hi"}]}}',
      'not json at all',
      '{"type":"assistant","message":',
      '42',
      '{"type":"assistant","message":{"role":"assistant","model":"claude-sonnet-4-5","content":[{"type":"text","text":"hello"}],"usage":{"input_tokens":10,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"output_tokens":5}}}',
      '',
    ].join('\n');
    const result = readTranscriptLines(raw);
    expect(result.skippedLines).toEqual([2, 3, 4]);
    expect(result.entries.map((entry) => entry.line)).toEqual([1, 5]);
  });
});
