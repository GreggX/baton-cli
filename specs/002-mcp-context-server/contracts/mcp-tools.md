# MCP Tool Contract: baton context server

**Feature**: [../spec.md](../spec.md) | **Data model**: [../data-model.md](../data-model.md) |
**Pays**: [../../mcp-parity-obligation.md](../../mcp-parity-obligation.md)

Server: launched as `baton mcp [--allow-writes] [--workspace <path>]` (stdio, one
workspace per instance). Conventions:

- Result payloads are the CLI `--json` shapes from feature 001's contract, serialized
  compact — validated against the same zod schemas (FR-003).
- Read tools: side-effect-free, idempotent, read-only annotations, no approval.
- Persisting tools: listed always (parity); execute only under `--allow-writes`
  (operator attestation that the host prompts per request); otherwise return the
  structured Decline. Absence of approval is a no (FR-006).
- Errors: structured tool error naming the problem (`invalid-params`, `no-session`,
  `config-invalid` with the CLI's named violations, …) — never a silent failure.
- Audit: every executed write appends one entry (timestamp, capability, ids/path, gate
  state — no session content) to `.baton/audit.log` (FR-014); declines and read tools
  never write it.
- Descriptions below are canonical: the served strings MUST match verbatim (tested).

---

## `context_status` (read)

**Description (canonical)**: "Read the current context health of this session: zone
(green/yellow/orange/red), usage percentage, and what to do about it. Cheap — check
whenever unsure, and always before pasting large content."

**Params**: none (workspace and active session fixed by the connection; session override
not exposed to the model).

**Result**: the CLI `status --json` shape (`state: ok|unknown`, reading, zone, guidance,
dataAgeSeconds, lastTransition?). Unknown state per FR-008 — reason + last-good age,
never a fabricated zone.

---

## `context_catchup` (read)

**Description (canonical)**: "What changed since you last checked: zone transitions and
pending recommendations, each with its trigger. Returns an explicit empty result when
nothing changed — cheap to call routinely."

**Params**: none. The server keeps a per-connection cursor per session; the first call
returns the current snapshot (current zone + pending recommendations, no history), later
calls return the delta.

**Result**: CatchupReport — `{ sessionId, transitions[], pending[], empty }` with
multi-band collapse and dismissal filtering (FR-009); `empty: true` responses fit the
SC-003 budget.

---

## `context_scan` (read)

**Description (canonical)**: "Deterministically scan this session for passages worth
saving as artifacts (decisions, conclusions, constraints, results, tasks, questions).
Use in orange or red before recommending compaction. Read-only."

**Params**: `{ categories?: ("decision"|"conclusion"|"constraint"|"result"|"task"|"question")[] }`

**Result**: the CLI `scan --json` shape (sessionId, fingerprint, rulesChecked,
candidates with excerpt/span/ruleId). Identical content ⇒ identical candidates and
fingerprint as the CLI (SC-004).

---

## `context_save` (persisting)

**Description (canonical)**: "Request saving scanned candidates as workspace artifacts.
Requires explicit user approval; nothing is written if declined. Propose only candidates
the user would plausibly want kept."

**Params**: `{ candidateIds: string[] }` (min 1; ids from `context_scan`).

**Result**: with writes enabled — the CLI `save --json` shape (`saved: [{candidateId,
path}]`); unknown id ⇒ `invalid-params` error naming the id, nothing partially written.
Without `--allow-writes` — Decline:
`{ "declined": true, "reason": "writes-disabled", "instructions": "Ask the user to run: baton context save <id>… — or restart the server with baton mcp --allow-writes" }`

---

## `context_handoff` (persisting)

**Description (canonical)**: "Request generation of a handoff summary file so a fresh
session can resume this work. Requires explicit user approval. Recommend this in red."

**Params**: none (default output path; the model cannot direct writes elsewhere).

**Result**: with writes enabled — the CLI `handoff --json` shape (`path, sessionId,
artifactCount`), file identical in sections/sources to the CLI's for the same state
(SC-004). Without `--allow-writes` — Decline with the `baton context handoff` CLI
instruction.

---

## `context_config` (read)

**Description (canonical)**: "Read the effective zone thresholds and their source (file
or defaults), including any configuration problems. Read-only."

**Params**: none.

**Result**: the CLI `config --json` report (valid, thresholds, source, errors[] with
key/value/rule) — same named violations, defaults-in-effect semantics (FR-011).

---

## Contract test obligations

1. **Listing & canon** (`mcp-tools.test.ts`): exactly these six tools are listed; served
   descriptions and annotations match this contract verbatim; every result validates
   against its `src/core/` zod schema.
2. **Parity** (`mcp-parity.test.ts`): for each fixture workspace, tool results equal the
   CLI `--json` values — status fields, scan candidates + fingerprint, config report,
   handoff file content (SC-004 / FR-003).
3. **Budget** (`mcp-budget.test.ts`): `context_status` and empty `context_catchup`
   responses ≤ 200 tokens (chars/4); no tool result contains transcript content
   (SC-003 / FR-004).
4. **Write gating** (`mcp-gating.test.ts`): without `--allow-writes`, `context_save` and
   `context_handoff` return Decline and the workspace is byte-identical afterward
   (including no audit entry); with it, saves write exactly the requested candidates and
   each executed write appends exactly one entry to `.baton/audit.log`; read tools never
   write anything under repeated calls (SC-002 / FR-005 / FR-006 / FR-014).
5. **Catch-up replay** (`mcp-tools.test.ts` + `replay.test.ts`): replayed growth across
   40/60/75 yields one collapsed transition per jump; dismissed recommendations excluded;
   second identical call reports `empty: true`.
6. **Obligation closure**: feature close flips `specs/mcp-parity-obligation.md` to
   SATISFIED with all checklist items checked and a link to this feature.
