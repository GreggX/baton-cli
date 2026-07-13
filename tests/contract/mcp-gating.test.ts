// Feature 002 T019 — US3 write-gating matrix (contracts/mcp-tools.md obligation 4,
// SC-002 / FR-005 / FR-006 / FR-014; quickstart scenario 6):
//   - WITHOUT --allow-writes, context_save returns the structured Decline —
//     `declined: true`, reason `writes-disabled`, the EXACT CLI instruction from
//     the contract — and the workspace (fixture root, session data included) is
//     byte-identical afterward, INCLUDING no `.baton/audit.log` entry;
//   - WITH the flag, saving two candidate ids writes exactly those two artifacts
//     with provenance frontmatter AND appends exactly ONE audit entry for the one
//     executed write — timestamp, capability, candidate ids, gate state, and no
//     session content anywhere in the log (FR-014);
//   - an unknown candidate id → structured `invalid-params` error NAMING the id,
//     with nothing written (no artifact, no audit entry) even when a known id
//     rides in the same batch — nothing partially written;
//   - repeated read-tool calls (status, catch-up, scan, config) write nothing
//     anywhere (FR-005 — their no-write guarantee is byte-exact).
//
// Feature 002 T023 — US4 context_handoff gating (quickstart scenario 7):
//   - WITHOUT --allow-writes the handoff request returns the structured Decline
//     with the `baton context handoff` CLI instruction and the whole tree stays
//     byte-identical — no handoff file, NO audit entry;
//   - WITH the flag it writes exactly ONE file at the DEFAULT `.baton/handoff/`
//     path (the model cannot direct writes elsewhere), returns the CLI handoff
//     shape (path + sessionId + artifactCount), and appends exactly ONE audit
//     entry — timestamp, capability, output path, gate state, and no session
//     content anywhere in the log (FR-014).
//
// Byte-identity is proven the same way feature 001's read-only sweep proves it:
// sha256 checksums over EVERY file under the harness's temp fixture root
// (workspaces + the BATON_CLAUDE_DIR session data) before and after each call.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';
import { SESSION_IDS } from '../../scripts/fixtures/generate-fixtures.js';
import { createToolHandlers } from '../../src/mcp/tools.js';
import type { McpHarness } from './helpers/mcp-harness.js';
import { startMcpHarness } from './helpers/mcp-harness.js';

// The canonical Decline for a gated context_save — contracts/mcp-tools.md VERBATIM.
const SAVE_DECLINE = {
  declined: true,
  reason: 'writes-disabled',
  instructions:
    'Ask the user to run: baton context save <id>… — or restart the server with baton mcp --allow-writes',
};

// The canonical Decline for a gated context_handoff — same pattern, its own CLI command.
const HANDOFF_DECLINE = {
  declined: true,
  reason: 'writes-disabled',
  instructions:
    'Ask the user to run: baton context handoff — or restart the server with baton mcp --allow-writes',
};

/** Workspace-relative audit log location (FR-014, data-model.md AuditEntry). */
const AUDIT_LOG = join('.baton', 'audit.log');

let harness: McpHarness | null = null;

afterEach(async () => {
  if (harness !== null) {
    await harness.close();
    harness = null;
  }
});

async function start(workspace: string, allowWrites: boolean): Promise<McpHarness> {
  harness = await startMcpHarness({
    workspace,
    allowWrites,
    handlers: createToolHandlers(),
  });
  return harness;
}

// ── Result helpers ────────────────────────────────────────────────────────────

function textOf(result: CallToolResult): string {
  const first = result.content[0];
  if (first === undefined || first.type !== 'text') {
    throw new Error('expected a text content block');
  }
  return first.text;
}

/** Parse a NON-error tool result's compact JSON payload. */
function payloadOf(result: CallToolResult): unknown {
  expect(result.isError ?? false).toBe(false);
  return JSON.parse(textOf(result));
}

interface ScanReportLike {
  candidates: { id: string; ruleId: string; excerpt: string }[];
}

/** Scan the harness workspace over MCP and return its candidates (read-only). */
async function scanCandidates(h: McpHarness): Promise<ScanReportLike['candidates']> {
  const report = payloadOf(await h.callTool('context_scan')) as ScanReportLike;
  return report.candidates;
}

// ── Filesystem snapshotting (byte-identity, as in feature 001's T053) ─────────

/** Map of root-relative path → sha256 of the file's bytes, whole tree. */
function checksumTree(root: string): Map<string, string> {
  const sums = new Map<string, string>();
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) {
        sums.set(
          relative(root, path),
          createHash('sha256').update(readFileSync(path)).digest('hex'),
        );
      }
    }
  };
  visit(root);
  return sums;
}

/** Paths present in `after` but not in `before` (the writes of a step). */
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

/** Assert the whole tree is byte-identical: nothing new, nothing touched. */
function expectTreeByteIdentical(
  before: Map<string, string>,
  after: Map<string, string>,
): void {
  expectPreexistingUntouched(before, after);
  expect(newFiles(before, after)).toEqual([]);
}

// ── The matrix ────────────────────────────────────────────────────────────────

describe('context_save without --allow-writes (T019, FR-006/SC-002)', () => {
  it('returns the structured Decline with reason and the exact CLI instruction', async () => {
    const h = await start('ws-decisions', false);
    const result = await h.callTool('context_save', {
      candidateIds: ['c-000000000000'],
    });
    // The Decline is a structured RESULT, not a protocol error (contract).
    expect(result.isError ?? false).toBe(false);
    expect(payloadOf(result)).toEqual(SAVE_DECLINE);
  });

  it('leaves the workspace byte-identical — no artifact, no audit entry, nothing (FR-014)', async () => {
    const h = await start('ws-decisions', false);
    // Real candidate ids from a real scan: the decline must not depend on the
    // request being nonsensical — a perfectly valid request is still declined.
    const candidates = await scanCandidates(h);
    expect(candidates.length).toBeGreaterThanOrEqual(2);
    const ids = candidates.slice(0, 2).map((candidate) => candidate.id);

    const before = checksumTree(h.fixtureRoot);
    const declined = await h.callTool('context_save', { candidateIds: ids });
    expect(payloadOf(declined)).toEqual(SAVE_DECLINE);

    const after = checksumTree(h.fixtureRoot);
    expectTreeByteIdentical(before, after);
    expect(existsSync(join(h.workspace, AUDIT_LOG))).toBe(false); // declines never audit
  });
});

describe('context_save with --allow-writes (T019, FR-006/FR-014)', () => {
  it('saving two candidate ids writes exactly those two artifacts with provenance + ONE audit entry', async () => {
    const h = await start('ws-decisions', true);
    const candidates = await scanCandidates(h);
    expect(candidates.length).toBeGreaterThanOrEqual(2);
    const chosen = candidates.slice(0, 2);
    const ids = chosen.map((candidate) => candidate.id);

    const before = checksumTree(h.fixtureRoot);
    const payload = payloadOf(await h.callTool('context_save', { candidateIds: ids })) as {
      saved: { candidateId: string; path: string }[];
    };

    // The CLI save --json shape: exactly the two requested candidates, in order.
    expect(payload.saved.map((entry) => entry.candidateId)).toEqual(ids);
    expect(payload.saved).toHaveLength(2);
    for (const entry of payload.saved) {
      expect(entry.path.startsWith(join('.baton', 'artifacts'))).toBe(true);
    }

    // Exactly those two artifacts + the one audit log appeared — nothing else,
    // and nothing preexisting (session data included) was touched.
    const after = checksumTree(h.fixtureRoot);
    expectPreexistingUntouched(before, after);
    const wsRelative = relative(h.fixtureRoot, h.workspace);
    expect(newFiles(before, after).sort()).toEqual(
      [
        ...payload.saved.map((entry) => join(wsRelative, entry.path)),
        join(wsRelative, AUDIT_LOG),
      ].sort(),
    );

    // Each written artifact carries its provenance frontmatter (FR-007).
    for (const [index, entry] of payload.saved.entries()) {
      const content = readFileSync(join(h.workspace, entry.path), 'utf8');
      expect(content).toContain(`sessionId: ${SESSION_IDS.decisions}`);
      expect(content).toContain(`ruleId: ${chosen[index]?.ruleId ?? ''}`);
      expect(content).toContain('savedAt: ');
      expect(content).toContain('span:');
    }

    // FR-014: exactly ONE entry for the one executed write — plain-text JSON line
    // with timestamp, capability, candidate ids, written paths, and gate state.
    const auditText = readFileSync(join(h.workspace, AUDIT_LOG), 'utf8');
    const lines = auditText.trim().split('\n');
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0] ?? '') as Record<string, unknown>;
    expect(entry['capability']).toBe('context_save');
    expect(entry['gate']).toBe('allow-writes');
    expect(entry['detail']).toEqual({ candidateIds: ids });
    expect(entry['written']).toEqual(payload.saved.map((saved) => saved.path));
    expect(Number.isNaN(Date.parse(entry['timestamp'] as string))).toBe(false);
    // No session content in the audit log — ids, paths, timestamps only.
    for (const candidate of candidates) {
      expect(auditText).not.toContain(candidate.excerpt);
    }
  });

  it('a second executed save appends a second entry — one entry per executed write', async () => {
    const h = await start('ws-decisions', true);
    const candidates = await scanCandidates(h);
    const first = candidates[0];
    const second = candidates[1];
    if (first === undefined || second === undefined) {
      throw new Error('expected at least two ws-decisions candidates');
    }
    payloadOf(await h.callTool('context_save', { candidateIds: [first.id] }));
    payloadOf(await h.callTool('context_save', { candidateIds: [second.id] }));
    const lines = readFileSync(join(h.workspace, AUDIT_LOG), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2); // append-only: one line per executed write
    const entries = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(entries[0]?.['detail']).toEqual({ candidateIds: [first.id] });
    expect(entries[1]?.['detail']).toEqual({ candidateIds: [second.id] });
  });

  it('unknown candidate id → invalid-params NAMING the id; nothing written, not even for the known id', async () => {
    const h = await start('ws-decisions', true);
    const candidates = await scanCandidates(h);
    const known = candidates[0];
    if (known === undefined) throw new Error('expected ws-decisions candidates');
    const unknownId = 'c-feedfacecafe';

    const before = checksumTree(h.fixtureRoot);
    const result = await h.callTool('context_save', {
      candidateIds: [known.id, unknownId],
    });
    expect(result.isError).toBe(true); // structured tool error, never silent
    const payload = JSON.parse(textOf(result)) as Record<string, unknown>;
    expect(payload['error']).toBe('invalid-params');
    expect(payload['reason']).toContain(unknownId); // names the offending id

    // Nothing partially written: no artifact for the known id, no audit entry.
    const after = checksumTree(h.fixtureRoot);
    expectTreeByteIdentical(before, after);
    expect(existsSync(join(h.workspace, AUDIT_LOG))).toBe(false);
  });
});

describe('context_handoff without --allow-writes (T023, FR-006/SC-002)', () => {
  it('returns the structured Decline with reason and the exact CLI instruction', async () => {
    const h = await start('ws-red', false);
    const result = await h.callTool('context_handoff');
    // The Decline is a structured RESULT, not a protocol error (contract).
    expect(result.isError ?? false).toBe(false);
    expect(payloadOf(result)).toEqual(HANDOFF_DECLINE);
  });

  it('leaves the workspace byte-identical — no handoff file, no audit entry (FR-014)', async () => {
    const h = await start('ws-red', false);
    const before = checksumTree(h.fixtureRoot);
    const declined = await h.callTool('context_handoff');
    expect(payloadOf(declined)).toEqual(HANDOFF_DECLINE);

    const after = checksumTree(h.fixtureRoot);
    expectTreeByteIdentical(before, after);
    expect(existsSync(join(h.workspace, join('.baton', 'handoff')))).toBe(false);
    expect(existsSync(join(h.workspace, AUDIT_LOG))).toBe(false); // declines never audit
  });
});

describe('context_handoff with --allow-writes (T023, FR-006/FR-014)', () => {
  it('writes ONE file at the default path, returns path + sessionId + artifactCount, appends ONE audit entry', async () => {
    const h = await start('ws-red', true);

    const before = checksumTree(h.fixtureRoot);
    const payload = payloadOf(await h.callTool('context_handoff')) as {
      path: string;
      sessionId: string;
      artifactCount: number;
    };

    // The CLI handoff --json shape: the DEFAULT `.baton/handoff/` path only —
    // the model supplied no path and cannot direct the write elsewhere.
    expect(payload.path).toMatch(/^\.baton\/handoff\/\d{8}-\d{6}-handoff\.md$/);
    expect(payload.sessionId).toBe(SESSION_IDS.red);
    expect(payload.artifactCount).toBe(0); // nothing saved beforehand

    // Exactly the one handoff file + the one audit log appeared — nothing else,
    // and nothing preexisting (session data included) was touched.
    const after = checksumTree(h.fixtureRoot);
    expectPreexistingUntouched(before, after);
    const wsRelative = relative(h.fixtureRoot, h.workspace);
    expect(newFiles(before, after).sort()).toEqual(
      [join(wsRelative, payload.path), join(wsRelative, AUDIT_LOG)].sort(),
    );

    // The written file is a real handoff for this session (parity details in T023's
    // mcp-parity cases — here only that the assembly actually ran).
    const content = readFileSync(join(h.workspace, payload.path), 'utf8');
    expect(content).toContain('# Handoff — ws-red · session 44444444');

    // FR-014: exactly ONE entry for the one executed write — plain-text JSON line
    // with timestamp, capability, output path, written paths, and gate state.
    const auditText = readFileSync(join(h.workspace, AUDIT_LOG), 'utf8');
    const lines = auditText.trim().split('\n');
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0] ?? '') as Record<string, unknown>;
    expect(entry['capability']).toBe('context_handoff');
    expect(entry['gate']).toBe('allow-writes');
    expect(entry['detail']).toEqual({ outputPath: payload.path });
    expect(entry['written']).toEqual([payload.path]);
    expect(Number.isNaN(Date.parse(entry['timestamp'] as string))).toBe(false);
    // No session content in the audit log — ids, paths, timestamps only.
    expect(auditText).not.toContain('We decided to route every reading');
    expect(auditText).not.toContain('TODO: handle the empty transcript case');
  });
});

describe('read tools write nothing anywhere (T019, FR-005)', () => {
  it('repeated status/catch-up/scan/config calls leave the whole tree byte-identical', async () => {
    // allowWrites true on purpose: read tools must not write even when the
    // gate would admit writes — the guarantee is theirs, not the gate's.
    const h = await start('ws-decisions', true);
    const before = checksumTree(h.fixtureRoot);
    for (let round = 0; round < 2; round += 1) {
      payloadOf(await h.callTool('context_status'));
      payloadOf(await h.callTool('context_catchup'));
      payloadOf(await h.callTool('context_scan'));
      payloadOf(await h.callTool('context_scan', { categories: ['decision'] }));
      payloadOf(await h.callTool('context_config'));
    }
    const after = checksumTree(h.fixtureRoot);
    expectTreeByteIdentical(before, after);
    expect(existsSync(join(h.workspace, AUDIT_LOG))).toBe(false); // reads never audit
  });
});
