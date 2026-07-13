---

description: "Task list for MCP Context Server implementation"
---

# Tasks: MCP Context Server

**Input**: Design documents from `/specs/002-mcp-context-server/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/mcp-tools.md, quickstart.md; feature 001 implemented (its core, adapter, stores, and fixtures are reused)

**Tests**: INCLUDED — the constitution mandates test-first for monitor logic (the replay
function) and the contract-test obligations in contracts/mcp-tools.md govern the tool
surface. Test tasks precede their implementations and MUST fail before the implementation
task starts.

**Organization**: Tasks are grouped by user story to enable independent implementation and
testing of each story.

**Boundary rule for implementers**: do not modify anything under `specs/` except ticking
checkboxes in this file — with ONE sanctioned exception: T029 explicitly flips
`specs/mcp-parity-obligation.md` to SATISFIED as this feature's closing act.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies on incomplete tasks)
- **[Story]**: Which user story this task belongs to (US1, US2, US3, US4)
- Include exact file paths in descriptions

## Path Conventions

Single project at repository root per plan.md: new `src/mcp/` presentation layer (peer of
`src/cli/`), one new pure function in `src/core/monitor/`, contract tests in
`tests/contract/mcp-*.test.ts`, fixtures reused from feature 001 via `BATON_CLAUDE_DIR`.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Dependency and boundary groundwork on the existing project

- [x] T001 Add `@modelcontextprotocol/sdk` (1.29.x) to dependencies via npm and create the src/mcp/ directory
- [x] T002 [P] Extend the architecture boundary test: src/core must not import from src/mcp; src/mcp must not import from src/cli (launcher direction is cli → mcp only) in tests/unit/architecture.test.ts

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The replay math, state atomicity, capability registry, server shell, and test harness every story builds on

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

- [x] T003 [P] Unit tests (write first, must fail) for catch-up replay: determinism (same history + same cursor ⇒ identical report), multi-band collapse to one transition per jump, no transition fabricated from estimated/exact flapping alone, unknown states claim no zone, cursor advance semantics, and a torn/partial final entry in the input history is tolerated (skipped, never crashes, cursor never advances past an incomplete entry — the self-monitoring mid-write edge case) in tests/unit/replay.test.ts
- [x] T004 Pure replay function `(usageHistory, thresholds, fromCursor) → { transitions, toCursor }` per data-model.md derivation rules in src/core/monitor/replay.ts — makes T003 pass
- [x] T005 [P] Atomic `.baton/state.json` writes (temp file + rename, last-writer-wins; readers tolerate mid-rename absence) in src/core/monitor/state.ts, with concurrency unit test extension (FR-013, research R9) in tests/unit/monitor-state.test.ts
- [x] T006 Capability registry: static table of the six capabilities (names, canonical descriptions verbatim from contracts/mcp-tools.md, read/persisting classification, read-only/idempotent annotations, result-schema refs) in src/mcp/registry.ts
- [x] T007 Server shell: MCP SDK server construction, stdio transport, workspace resolution (cwd or --workspace), `--allow-writes` Connection state, graceful shutdown in src/mcp/server.ts
- [x] T008 `baton mcp [--allow-writes] [--workspace <path>]` launcher command in src/cli/commands/mcp.ts, registered in src/cli/index.ts
- [x] T009 [P] In-memory test harness: helper that pairs the real server with an SDK client over the in-memory transport against a `BATON_CLAUDE_DIR` fixture workspace, returning call/list/close helpers in tests/contract/helpers/mcp-harness.ts

**Checkpoint**: Foundation ready — server starts empty; user story tool registration can begin

---

## Phase 3: User Story 1 - The Agent Reads Its Own Context Health (Priority: P1) 🎯 MVP

**Goal**: One-step connection; `context_status` and `context_config` served with
CLI-identical values, canonical descriptions, honest unknown state, and budget-compliant
responses.

**Independent Test**: Harness against ws-green/ws-yellow/ws-empty fixtures — correct
zone/pct/guidance, unknown with reason, values equal to CLI `--json`, status response
≤200 tokens (quickstart scenarios 1–3, 8 partial).

### Tests for User Story 1 ⚠️ write first, must fail

- [x] T010 [P] [US1] Contract tests for context_status + context_config: both listed with canonical descriptions and read-only annotations; results validate against the core zod schemas; ok/estimated/unknown fixture shapes (unknown carries reason + last-good age, never a zone); server pointed at a nonexistent or unreadable session-data root returns a structured configuration error — never fabricated data (spec edge case) in tests/contract/mcp-tools.test.ts
- [x] T011 [P] [US1] Parity tests: context_status and context_config values equal CLI `--json` output on ws-green, ws-yellow, ws-empty, ws-bad-config fixtures (field-by-field) in tests/contract/mcp-parity.test.ts
- [x] T012 [P] [US1] Budget test: context_status response ≤200 tokens (chars/4 ≈ 800 chars) and contains no transcript content in tests/contract/mcp-budget.test.ts

### Implementation for User Story 1

- [x] T013 [US1] context_status handler: reuse the feature-001 reader pipeline (SessionSource → reading/unavailable + zone + guidance + dataAge), serialize the CLI status shape compact in src/mcp/tools.ts — makes T010–T012 pass for status
- [x] T014 [US1] context_config handler: reuse the config loader/report (effective thresholds, source, named violations, defaults-in-effect) in src/mcp/tools.ts — completes T010/T011 for config

**Checkpoint**: MVP — a connected agent can read its own context health; quickstart 1–3 pass on fixtures

---

## Phase 4: User Story 2 - The Agent Catches Up on Transitions and Advice (Priority: P2)

**Goal**: `context_catchup` returns replayed transitions since the caller's cursor plus
pending recommendations with triggers, honoring dismissals made on either surface;
explicit cheap empty result.

**Independent Test**: First call snapshots; append-turns replay across 40/60/75; second
call reports exactly one collapsed transition + pending recommendation; a CLI-recorded
dismissal is excluded; third call returns `empty: true` within budget (quickstart 4).

### Tests for User Story 2 ⚠️ write first, must fail

- [x] T015 [P] [US2] Contract tests for context_catchup: first-call snapshot (no history), post-replay delta with exactly one collapsed transition + trigger-carrying pending recommendation, dismissal recorded via the CLI surface (state.json) excluded from the next catch-up (cross-surface FR-013 proof), repeat call → `empty: true`, empty response within the SC-003 budget, and pending recommendation payloads validate against the feature-001 Recommendation schema (catch-up has no CLI twin — its parity is inherited through the shared replay function and recommendation engine, asserted here at the schema level) in tests/contract/mcp-tools.test.ts and tests/contract/mcp-budget.test.ts

### Implementation for User Story 2

- [x] T016 [US2] Per-connection CheckCursor bookkeeping (create-on-first-call snapshot semantics, advance per call, in-memory only, per session id) in src/mcp/cursors.ts
- [x] T017 [US2] context_catchup handler: adapter usage history → replay (T004) → transitions; pending recommendations via the feature-001 recommendation engine filtered by persisted dismissals; CatchupReport serialization in src/mcp/tools.ts — makes T015 pass

**Checkpoint**: Stories 1–2 work — advice reaches the model without a human watching

---

## Phase 5: User Story 3 - The Agent Proposes Saves, the User Decides (Priority: P2)

**Goal**: `context_scan` with CLI-identical candidates/fingerprint; `context_save` gated
by the WriteGate — decline-with-instructions by default, writes exactly the approved
candidates under `--allow-writes`.

**Independent Test**: Scan parity on ws-decisions (same fingerprint as CLI); save without
the flag declines and leaves the workspace byte-identical; with the flag, saving two ids
writes exactly two artifacts; unknown id errors with nothing partial (quickstart 5–6).

### Tests for User Story 3 ⚠️ write first, must fail

- [x] T018 [P] [US3] Parity tests for context_scan: candidates and fingerprint equal the CLI's for ws-decisions and ws-no-matches (explicit empty), category filter honored in tests/contract/mcp-parity.test.ts
- [x] T019 [P] [US3] Gating tests: without --allow-writes context_save returns the structured Decline (reason + exact CLI instruction) and the workspace is byte-identical afterward (including no audit entry); with the flag, saving two candidate ids writes exactly those two artifacts with provenance AND appends exactly one `.baton/audit.log` entry per executed write (timestamp, capability, ids, gate state — no session content, FR-014); unknown candidate id → `invalid-params` error naming the id, nothing written; repeated read-tool calls write nothing anywhere in tests/contract/mcp-gating.test.ts

### Implementation for User Story 3

- [x] T020 [US3] context_scan handler: adapter content extraction → feature-001 scanner, CLI scan shape with fingerprint in src/mcp/tools.ts — makes T018 pass
- [x] T021 [US3] WriteGate + Decline responses + audit writer: allowWrites check, decline payload builder with per-capability CLI instructions, and the append-only `.baton/audit.log` entry writer invoked for every executed write (AuditEntry per data-model.md — no session content; never written on decline or by read tools) in src/mcp/gating.ts
- [x] T022 [US3] context_save handler behind the WriteGate: candidate resolution from a fresh scan, feature-001 artifact store (accepted-only, no partial writes), saved-paths result in src/mcp/tools.ts — makes T019 pass

**Checkpoint**: The model can curate its own context with the user as sole authority

---

## Phase 6: User Story 4 - The Agent Prepares Its Own Handoff (Priority: P3)

**Goal**: `context_handoff` behind the same WriteGate produces the CLI-identical handoff
file (default path only) and returns its path.

**Independent Test**: On ws-red with writes enabled, the produced file matches the CLI's
sections/task state/sources; without the flag it declines (quickstart 7).

### Tests for User Story 4 ⚠️ write first, must fail

- [x] T023 [P] [US4] Contract tests for context_handoff: Decline without --allow-writes (no audit entry); with the flag, file sections/task state/`[source: …]` annotations equal the CLI's for the same fixture state, path + artifactCount returned, and one audit entry appended (FR-014) in tests/contract/mcp-gating.test.ts and tests/contract/mcp-parity.test.ts

### Implementation for User Story 4

- [x] T024 [US4] context_handoff handler behind the WriteGate: feature-001 handoff assembly + write (default `.baton/handoff/` path only — the model cannot direct writes elsewhere), CLI handoff shape result in src/mcp/tools.ts — makes T023 pass

**Checkpoint**: All four stories functional — the self-regulation loop closes end-to-end

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Full-surface guarantees, real-transport smoke, docs, and the obligation flip

- [x] T025 [P] Complete listing-and-canon test: exactly the six contract tools are listed, every served description and annotation matches contracts/mcp-tools.md verbatim in tests/contract/mcp-tools.test.ts
- [x] T026 [P] Stdio smoke test: spawn the real `baton mcp` subprocess, perform a protocol handshake with an SDK client over stdio, call context_status against a fixture, assert a valid budgeted response returned in under 2 seconds (SC-001), and assert the server process holds no listening network sockets (FR-012) in tests/integration/mcp-stdio.test.ts
- [x] T027 Run quickstart.md scenarios 1–8 end-to-end (live Claude Code connection where the scenario calls for it); fix any drift between docs and behavior
- [x] T028 [P] README: add the MCP section — setup snippet (`claude mcp add baton -- baton mcp`), six-tool table with descriptions, write-gating explanation (`--allow-writes`) with an explicit warning never to combine `--allow-writes` with an auto-approving host configuration (the flag attests that the host prompts per request) in README.md
- [x] T029 Close the parity obligation: check all five acceptance boxes and flip Status to SATISFIED with a link to this feature in specs/mcp-parity-obligation.md, and update the obligation line in CLAUDE.md (sanctioned specs/ edit — see Boundary rule above)

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — start immediately
- **Foundational (Phase 2)**: Depends on Setup — BLOCKS all user stories (T004 replay needs T003 failing first; T007 server shell needs T006 registry; T009 harness needs T007)
- **US1 (Phase 3)**: Depends on Foundational (registry, server, harness)
- **US2 (Phase 4)**: Depends on Foundational (T004 replay, T005 atomic state) + shares src/mcp/tools.ts with US1 — runs after US1
- **US3 (Phase 5)**: Depends on Foundational; T021 gating.ts is a new file, but handlers share src/mcp/tools.ts — runs after US2
- **US4 (Phase 6)**: Depends on US3's WriteGate (T021)
- **Polish (Phase 7)**: Depends on all stories (T025 needs all six tools registered)

### User Story Dependencies

- **US1 (P1)**: Foundational only — MVP
- **US2 (P2)**: Foundational (replay, cursors); tools.ts sequencing after US1
- **US3 (P2)**: Foundational; introduces the WriteGate used by US4
- **US4 (P3)**: US3's WriteGate; otherwise independent and fixture-testable

### Within Each User Story

- Tests written first and observed failing before implementation (mandated for T003, and applied to all contract tests: T010–T012, T015, T018–T019, T023)
- Registry/gate pieces → handlers → checkpoint green
- Story complete before the next priority starts (shared src/mcp/tools.ts)

### Parallel Opportunities

- Setup: T002 alongside T001
- Foundational: T003 + T005 together; T009 alongside T008 once T007 exists
- Within each story: all its test tasks ([P]) in parallel before implementation
- Polish: T025, T026, T028 in parallel; T029 last (closing act)

---

## Parallel Example: User Story 1

```bash
# Write the failing tests together:
Task: "T010 Contract tests for context_status + context_config in tests/contract/mcp-tools.test.ts"
Task: "T011 Parity tests vs CLI --json in tests/contract/mcp-parity.test.ts"
Task: "T012 Budget test for context_status in tests/contract/mcp-budget.test.ts"

# Then implement sequentially in src/mcp/tools.ts:
Task: "T013 context_status handler"
Task: "T014 context_config handler"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Phase 1: Setup (T001–T002)
2. Phase 2: Foundational (T003–T009) — replay math and server shell are the shared risk
3. Phase 3: US1 (T010–T014)
4. **STOP and VALIDATE**: quickstart scenarios 1–3 against fixtures + a live `claude mcp add`
5. Demo: an agent that can read its own context health is already the product's promise

### Incremental Delivery

1. MVP (above) → self-aware agent
2. US2 → advice reaches the model unprompted (quickstart 4)
3. US3 → model-proposed, user-approved saves (quickstart 5–6)
4. US4 → self-service handoff (quickstart 7)
5. Polish → six-tool canon, stdio smoke, docs, obligation flipped SATISFIED (quickstart 8; T029)

---

## Notes

- [P] = different files, no incomplete-task dependencies
- Constitution gates to keep green: core imports nothing from mcp (T002 enforces), zero unprompted writes — read tools side-effect-free, persisting tools decline by default (T019 proves), every delivered item names its trigger (T015 asserts)
- Feature 001's suite must stay green throughout — no weakening existing tests
- Commit after each task or logical group; checkpoints are demo-able states
- Total: 29 tasks — Setup 2, Foundational 7, US1 5, US2 3, US3 5, US4 2, Polish 5
