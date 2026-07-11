// T055 — Calibration fixture generator (SC-007 estimation accuracy).
//
// Builds transcripts under tests/fixtures/calibration/ whose assistant turns
// carry EXACT `message.usage` truth values over mixed content (prose, code,
// JSON). The truth values come from a REAL BPE tokenizer (gpt-tokenizer,
// cl100k_base) — never from chars/DIVISOR — stamped here at fixture-generation
// time so the runtime estimation path stays tokenizer-free: the tokenizer is a
// devDependency imported ONLY by this script.
//
// Determinism: all content comes from fixed word/snippet banks driven by a
// seeded PRNG (mulberry32) — re-running the script reproduces every byte.
//
// Each sample gets a per-sample context window sized so the exact usage
// percentage spans a realistic 20–90% range across the corpus; the accuracy
// test (tests/integration/estimate-accuracy.test.ts) compares the estimated
// percentage (chars/DIVISOR over the reconstructed conversation) against the
// exact percentage (stamped truth) and enforces SC-007: within 10 percentage
// points for ≥ 95% of samples.
//
// Regenerate with: npx tsx scripts/fixtures/generate-calibration.ts
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { encode } from 'gpt-tokenizer/encoding/cl100k_base';
import { fixtureRepoRoot } from './generate-fixtures.js';

export const CALIBRATION_RELATIVE_DIR = join('tests', 'fixtures', 'calibration');
export const CALIBRATION_ENCODING = 'cl100k_base';

// ── Deterministic PRNG ────────────────────────────────────────────────────────

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rng: () => number, items: readonly T[]): T {
  const item = items[Math.floor(rng() * items.length)];
  if (item === undefined) throw new Error('empty bank');
  return item;
}

function intBetween(rng: () => number, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

// ── Content banks (fixed — determinism) ───────────────────────────────────────

/**
 * Bank of realistic developer-conversation sentences (natural word-length
 * distribution, punctuation, numbers) — synthetic word salads tokenize far too
 * cheaply and would bias the calibration corpus.
 */
const SENTENCES = [
  'The reader tail-parses the transcript, extracts the latest usage block, and classifies the percentage into a zone.',
  "It looks like the debounce isn't applied on the first change event, so we see two refreshes back to back.",
  'After the second pass I checked the numbers again and they line up with what the profiler reported yesterday.',
  'Can you walk me through how the polling fallback interacts with the file watcher when both fire at once?',
  "That's a fair point, but I'd rather keep the pure function small and push the IO out to the caller.",
  'The 500ms debounce was chosen so a burst of writes coalesces into one refresh without breaching the 10s budget.',
  'We should double-check whether the config loader falls back to defaults when the JSON file is malformed.',
  'Running it locally, the first refresh takes about 120ms and subsequent ones are closer to 40ms.',
  'My worry is that a very long line could blow up the parser, so the tolerant path needs a test for that too.',
  'If the model id is unknown we assume a conservative 200k window and label the reading as estimated.',
  'The user asked for a quick summary of what changed since the last review, so I listed the three commits.',
  'Honestly the simplest fix is to sort the entries before hashing them, which makes the output stable.',
  'There is one more edge case: an empty transcript file should produce an explicit unavailable state, not a zero.',
  'Once the threshold ordering is validated, everything downstream can trust yellow < orange < red.',
  'I measured the scan on a 10MB file and it finished in well under a second on this laptop.',
  'Remember that the state file only holds ids, zone names, and timestamps — never any conversation text.',
  'For the demo we pointed the tool at fixture data, so nothing touches a real session on disk.',
  'The banner quiets itself after about six seconds, but the event log keeps the last four entries around.',
  'You could also express that as a reduce, but the loop reads more clearly and profiles identically.',
  'A dismissed notice stays quiet while the zone is unchanged and re-arms as soon as a boundary is crossed.',
  'When the percentage jumped from 35 to 68 in one turn, only the final zone produced a notification.',
  'Let me re-run the suite with the new fixture and paste the failing assertion if anything breaks.',
  'The slug is derived from the matched phrase, lowercased, with anything non-alphanumeric collapsed to dashes.',
  'In practice the cache read tokens dominate the total, so the estimate has to include them as well.',
  'That naming feels off to me; maybe call it resolveContextWindow so the intent is obvious at the call site.',
  'We agreed earlier that stdout carries results and stderr carries progress, so the JSON stays parseable.',
  'The retry loop backs off at 1, 2, and 4 seconds before giving up and reporting the source as stale.',
  'One thing to verify: does the watcher survive the transcript being replaced atomically by a rename?',
  'Overall this looks good to me — a couple of nits inline, nothing blocking the merge.',
  'The fixture replays four turns, and the third one deliberately crosses two thresholds at once.',
] as const;

const IDENTIFIERS = [
  'reading', 'window', 'zone', 'threshold', 'candidate', 'artifact', 'summary',
  'watcher', 'adapter', 'session', 'transcript', 'usage', 'estimate', 'config',
];

/** Realistic conversational prose of roughly `targetChars` characters. */
function prose(rng: () => number, targetChars: number): string {
  const sentences: string[] = [];
  let chars = 0;
  while (chars < targetChars) {
    const sentence = pick(rng, SENTENCES);
    sentences.push(sentence);
    chars += sentence.length + 1;
  }
  return sentences.join(' ');
}

/** TypeScript-looking snippet of roughly `targetChars` characters. */
function code(rng: () => number, targetChars: number): string {
  const lines: string[] = ['```ts'];
  let chars = 0;
  let index = 0;
  while (chars < targetChars) {
    const name = pick(rng, IDENTIFIERS);
    const other = pick(rng, IDENTIFIERS);
    const constant = intBetween(rng, 2, 97);
    const fn = [
      `export function ${name}For${String(index)}(input: string): number {`,
      `  const ${other}Parts = input.split('\\n').filter((line) => line !== '');`,
      `  const total = ${other}Parts.length * ${String(constant)};`,
      `  return Math.min(total, ${String(constant * 100)});`,
      `}`,
    ].join('\n');
    lines.push(fn);
    chars += fn.length + 1;
    index += 1;
  }
  lines.push('```');
  return lines.join('\n');
}

/** Pretty-printed JSON blob of roughly `targetChars` characters. */
function jsonBlob(rng: () => number, targetChars: number): string {
  const entries: Record<string, unknown> = {};
  let index = 0;
  // Grow the object until its serialization reaches the target size.
  for (;;) {
    const key = `${pick(rng, IDENTIFIERS)}_${String(index)}`;
    entries[key] = {
      id: `${pick(rng, IDENTIFIERS)}-${String(intBetween(rng, 100, 999))}`,
      enabled: rng() > 0.5,
      weight: intBetween(rng, 1, 100),
      tags: [pick(rng, IDENTIFIERS), pick(rng, IDENTIFIERS), pick(rng, IDENTIFIERS)],
    };
    index += 1;
    if (JSON.stringify(entries, null, 2).length >= targetChars) break;
  }
  return `\`\`\`json\n${JSON.stringify(entries, null, 2)}\n\`\`\``;
}

// ── Sample construction ───────────────────────────────────────────────────────

interface MixWeights {
  prose: number;
  codeW: number;
  json: number;
}

interface SampleSpec {
  id: string;
  seed: number;
  /** total assistant content size in characters (approximate) */
  chars: number;
  mix: MixWeights;
  /** exact usage percentage this sample should sit at (window derived from it) */
  targetPct: number;
}

/**
 * 40 samples: realistic prose-dominant conversations with code and JSON mixed
 * in at varying proportions, spread across 20–90% usage. Two deliberately
 * extreme mixes (pure prose, JSON-heavy) sit at moderate usage, as they do in
 * practice (dense JSON dumps rarely fill a whole context window).
 */
function buildSpecs(): SampleSpec[] {
  const mixes: MixWeights[] = [
    { prose: 0.7, codeW: 0.2, json: 0.1 },
    { prose: 0.55, codeW: 0.3, json: 0.15 },
    { prose: 0.45, codeW: 0.35, json: 0.2 },
    { prose: 0.6, codeW: 0.25, json: 0.15 },
    { prose: 0.5, codeW: 0.35, json: 0.15 },
    { prose: 0.4, codeW: 0.35, json: 0.25 },
  ];
  const pcts = [20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80, 85, 90];
  const specs: SampleSpec[] = [];
  for (let index = 0; index < 38; index += 1) {
    const mix = mixes[index % mixes.length];
    const targetPct = pcts[index % pcts.length];
    if (mix === undefined || targetPct === undefined) throw new Error('unreachable');
    specs.push({
      id: `cal-${String(index + 1).padStart(2, '0')}`,
      seed: 0xbeef + index * 7919,
      chars: 8000 + (index % 7) * 5000,
      mix,
      targetPct,
    });
  }
  // Extreme-but-realistic outliers at moderate usage:
  specs.push({
    id: 'cal-39',
    seed: 0xfeed,
    chars: 20_000,
    mix: { prose: 1, codeW: 0, json: 0 },
    targetPct: 30,
  });
  specs.push({
    id: 'cal-40',
    seed: 0xf00d,
    chars: 20_000,
    mix: { prose: 0.2, codeW: 0.2, json: 0.6 },
    targetPct: 25,
  });
  return specs;
}

const MODEL = 'claude-sonnet-4-5';

function sessionIdFor(index: number): string {
  const stamp = String(index + 1).padStart(12, '0');
  return `ca11b0a7-0000-4000-8000-${stamp}`;
}

interface GeneratedSample {
  id: string;
  file: string;
  sessionId: string;
  contextWindow: number;
  exactTokens: number;
  exactPct: number;
  chars: number;
}

function generateSample(spec: SampleSpec, index: number, outDir: string): GeneratedSample {
  const rng = mulberry32(spec.seed);
  const sessionId = sessionIdFor(index);
  const workspace = `/calibration/${spec.id}`;

  // Conversation: 4 user/assistant exchanges; assistant turns carry the bulk.
  const perTurn = Math.ceil(spec.chars / 4);
  const texts: { role: 'user' | 'assistant'; text: string }[] = [];
  for (let turn = 0; turn < 4; turn += 1) {
    texts.push({ role: 'user', text: prose(rng, intBetween(rng, 80, 220)) });
    const parts: string[] = [];
    if (spec.mix.prose > 0) parts.push(prose(rng, Math.round(perTurn * spec.mix.prose)));
    if (spec.mix.codeW > 0) parts.push(code(rng, Math.round(perTurn * spec.mix.codeW)));
    if (spec.mix.json > 0) parts.push(jsonBlob(rng, Math.round(perTurn * spec.mix.json)));
    texts.push({ role: 'assistant', text: parts.join('\n\n') });
  }

  // Truth: cumulative cl100k tokens of the reconstructed conversation — the
  // exact same reconstruction the estimation fallback performs (join('\n')).
  const lines: string[] = [];
  const seen: string[] = [];
  let counter = 0;
  for (const { role, text } of texts) {
    seen.push(text);
    counter += 1;
    const timestamp = `2026-07-02T17:${String(10 + counter).padStart(2, '0')}:00.000Z`;
    if (role === 'user') {
      lines.push(
        JSON.stringify({
          type: 'user',
          uuid: `${sessionId.slice(0, 24)}${String(counter).padStart(12, '0')}`,
          parentUuid: null,
          sessionId,
          timestamp,
          cwd: workspace,
          version: '2.0.0',
          gitBranch: 'main',
          message: { role: 'user', content: [{ type: 'text', text }] },
        }),
      );
    } else {
      const cumulative = encode(seen.join('\n')).length; // REAL tokenizer truth
      const outputTokens = Math.min(encode(text).length, cumulative - 1);
      lines.push(
        JSON.stringify({
          type: 'assistant',
          uuid: `${sessionId.slice(0, 24)}${String(counter).padStart(12, '0')}`,
          parentUuid: null,
          sessionId,
          timestamp,
          cwd: workspace,
          version: '2.0.0',
          gitBranch: 'main',
          message: {
            id: `msg_calibration_${spec.id}_${String(counter)}`,
            type: 'message',
            role: 'assistant',
            model: MODEL,
            content: [{ type: 'text', text }],
            stop_reason: 'end_turn',
            stop_sequence: null,
            usage: {
              input_tokens: cumulative - outputTokens,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
              output_tokens: outputTokens,
            },
          },
        }),
      );
    }
  }

  const reconstructed = seen.join('\n');
  const exactTokens = encode(reconstructed).length;
  const contextWindow = Math.max(exactTokens + 1, Math.round((exactTokens * 100) / spec.targetPct));
  const file = `${spec.id}.jsonl`;
  writeFileSync(join(outDir, file), `${lines.join('\n')}\n`);

  return {
    id: spec.id,
    file,
    sessionId,
    contextWindow,
    exactTokens,
    exactPct: (exactTokens / contextWindow) * 100,
    chars: reconstructed.length,
  };
}

/** (Re)generate the calibration corpus + manifest deterministically. */
export function generateCalibrationFixtures(repoRoot: string = fixtureRepoRoot()): void {
  const outDir = join(repoRoot, CALIBRATION_RELATIVE_DIR);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  const samples = buildSpecs().map((spec, index) => generateSample(spec, index, outDir));
  const manifest = {
    generator: 'scripts/fixtures/generate-calibration.ts',
    truthTokenizer: `gpt-tokenizer (${CALIBRATION_ENCODING})`,
    note:
      'exact usage truth stamped at fixture-generation time with a real BPE tokenizer; ' +
      'the runtime estimation path stays tokenizer-free (SC-007, T055)',
    samples,
  };
  writeFileSync(join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  // Generation-time report (stderr): estimator error per sample at DIVISOR=4.
  for (const sample of samples) {
    const estimated = Math.ceil(sample.chars / 4);
    const estPct = (estimated / sample.contextWindow) * 100;
    const diff = Math.abs(estPct - sample.exactPct);
    console.error(
      `${sample.id}: exact ${String(sample.exactTokens)} tok (${sample.exactPct.toFixed(1)}%) · ` +
        `est ${String(estimated)} tok (${estPct.toFixed(1)}%) · diff ${diff.toFixed(2)} pts`,
    );
  }
}

// CLI entry: `npx tsx scripts/fixtures/generate-calibration.ts`
import { fileURLToPath } from 'node:url';
import { resolve as resolvePath } from 'node:path';
if (process.argv[1] !== undefined) {
  const invoked = resolvePath(process.argv[1]);
  const self = fileURLToPath(import.meta.url);
  if (invoked === self) {
    generateCalibrationFixtures();
    console.error('calibration fixtures generated under tests/fixtures/calibration');
  }
}
