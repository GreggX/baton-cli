---

description: "Task list for Session Context Monitor implementation"
---

# Tasks: Session Context Monitor

**Input**: Design documents from `/specs/001-session-context-monitor/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/cli-interface.md, quickstart.md

**Tests**: INCLUDED where the constitution mandates test-first (threshold logic, heuristics,
adapter contracts — Development Workflow / Testing discipline) and for the contract-test
obligations in contracts/cli-interface.md. Test tasks precede their implementations and MUST
fail before the implementation task starts.

**Organization**: Tasks are grouped by user story to enable independent implementation and
testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies on incomplete tasks)
- **[Story]**: Which user story this task belongs to (US1, US2, US3, US4)
- Include exact file paths in descriptions

## Path Conventions

Single project at repository root per plan.md: `src/core/` (agent-agnostic library),
`src/adapters/claude-code/` (only place with agent-specific knowledge), `src/cli/`
(commands + Ink UI), `src/lib/` (shared utils), `tests/{unit,integration,contract,fixtures}`.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Project initialization and basic structure

- [x] T001 Initialize package.json (`baton-cli`, `bin: { baton }`, `"type": "module"`, engines node ≥22, scripts: build/test/lint) and strict tsconfig.json at repository root
- [x] T002 Install runtime deps (commander, ink, react, zod, chokidar) and dev deps (typescript, vitest, tsx, @types/node, @types/react, eslint, prettier, ink-testing-library) via npm
- [x] T003 [P] Configure vitest.config.ts with three projects mapping to tests/unit, tests/integration, tests/contract
- [x] T004 [P] Configure ESLint + Prettier (eslint.config.js, .prettierrc) for strict TS + React/Ink
- [x] T005 [P] Create directory skeleton per plan.md: src/core/{monitor,heuristics,artifacts,handoff,config}, src/adapters/claude-code, src/cli/{commands,ui}, src/lib, tests/{unit,integration,contract,fixtures}, scripts/fixtures

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core schemas, zone math, adapter, and CLI shell that every user story builds on

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

- [x] T006 [P] Architecture boundary test asserting no file in src/core imports from src/adapters or src/cli (constitution Principle III) in tests/unit/architecture.test.ts
- [x] T007 [P] Unit tests (write first, must fail) for threshold config: defaults 40/60/75, ordering refinement `0 < yellow < orange < red ≤ 100`, named error per violated key/rule, fallback-to-defaults behavior in tests/unit/config.test.ts
- [x] T008 [P] Unit tests (write first, must fail) for zone classification: boundary values (39.9→green, 40→yellow, 60→orange, 75→red, 100→red), custom thresholds in tests/unit/zones.test.ts
- [x] T009 [P] Unit tests (write first, must fail) for chars/4 token estimation determinism and edge cases (empty, unicode) in tests/unit/estimate.test.ts
- [x] T010 [P] Zod threshold schema + config loader (baton.config.json; absent file → defaults; invalid → ConfigError list naming key/value/rule, continue on defaults per FR-003) in src/core/config/schema.ts and src/core/config/loader.ts
- [x] T011 [P] Zod monitor entity schemas per data-model.md (SessionRef, UsageReading, ReadingUnavailable, ZoneTransition, Recommendation, Trigger discriminated union, MonitorState) in src/core/monitor/types.ts
- [x] T012 [P] Zod heuristics/artifact entity schemas (HeuristicRule, ArtifactCandidate, Artifact frontmatter, HandoffSummary sections) in src/core/heuristics/types.ts
- [x] T013 Zone classification pure function `(pct, thresholds) → Zone` + canonical guidance table (constitution Operational Constraints) in src/core/monitor/zones.ts — makes T008 pass
- [x] T014 [P] Token estimation util `estimateTokens(text): number` (ceil(chars / DIVISOR), divisor a named constant defaulting to 4, calibrated by the SC-007 accuracy test T055) in src/lib/estimate.ts — makes T009 pass
- [x] T015 SessionSource port interface (resolveSession, currentReading, contentForScan, subscribe-to-changes) consumed by core, implemented by adapters, in src/core/monitor/session-source.ts
- [x] T016 [P] Synthetic fixture workspaces with Claude Code-shaped JSONL transcripts (ws-green ≈25%, ws-yellow ≈45%, ws-orange ≈68%, ws-red ≈80% (with task/question phrases for handoff derivation), ws-growing, ws-empty, ws-decisions (decision/conclusion phrases, replayable into orange), ws-no-matches, ws-bad-config) in tests/fixtures/, transcripts under the fixture session root tests/fixtures/claude/projects/<encoded-ws>/ consumed via `BATON_CLAUDE_DIR`, plus replay script scripts/fixtures/append-turns.sh
- [x] T017 Integration tests (write first, must fail) for Claude Code adapter against fixtures: usage extraction from latest assistant `message.usage`, model→window map, unknown model → estimated, missing usage → chars/4 fallback labeled estimated, malformed JSONL lines skipped, most-recent-transcript discovery + `--session` override in tests/integration/claude-code-adapter.test.ts
- [x] T018 Claude Code adapter session discovery: session-data root from `BATON_CLAUDE_DIR` env var (default `~/.claude`), `projects/<encoded-path>` resolution, newest-transcript selection, session id override, lastActivityAt in src/adapters/claude-code/discovery.ts
- [x] T019 Claude Code adapter transcript reader: tolerant JSONL tail-parse (zod passthrough), usage extraction, model→window map (config-overridable), estimation fallback → UsageReading|ReadingUnavailable in src/adapters/claude-code/transcript.ts — makes T017 pass
- [x] T020 CLI entry: commander program `baton` with `context` command group, global flags (--json, --session, --workspace), stdout/stderr separation helpers, exit-code map (0/1/2/3 per contracts) in src/cli/index.ts and src/cli/output.ts
- [x] T021 [P] Contract test for `baton context config show|validate`: JSON shape, valid=false with named errors, exit 2 on validate-invalid, tolerated-fallback path keeps exit 0 in tests/contract/config.test.ts
- [x] T022 `config` command (show effective thresholds + source; validate with per-violation key/value/rule output) in src/cli/commands/config.ts — makes T021 pass

**Checkpoint**: Foundation ready — user story implementation can now begin

---

## Phase 3: User Story 1 - Always-Visible Context Health Signal (Priority: P1) 🎯 MVP

**Goal**: Traffic-light zone + percentage visible on demand (`status`) and live (`watch`),
with honest unknown/estimated states.

**Independent Test**: Run `status`/`watch` against fixture workspaces — correct zone/pct for
ws-green/ws-yellow, explicit unknown (exit 3) for ws-empty, live flip green→yellow ≤10s on
fixture append (quickstart scenarios 1–3 partial).

### Tests for User Story 1 (constitution/contract obligations) ⚠️ write first, must fail

- [x] T023 [P] [US1] Contract test for `baton context status`: ok/estimated/unknown JSON shapes, exit 0 vs 3, pure-JSON stdout with warnings on stderr in tests/contract/status.test.ts

### Implementation for User Story 1

- [x] T024 [US1] Reading pipeline service: SessionSource → UsageReading|ReadingUnavailable + zone classification + data-age computation in src/core/monitor/reader.ts
- [x] T025 [US1] `status` command: human output (glyph, zone, pct, precision label, tokens/window, data age) and --json per contract in src/cli/commands/status.ts — makes T023 pass
- [x] T026 [US1] Session file watching: chokidar on transcript + directory (session rollover), 500ms debounce, 5s polling fallback, emits change events to SessionSource.subscribe in src/adapters/claude-code/watcher.ts
- [x] T027 [P] [US1] Ink TrafficLight component (zone glyph/color, pct, precision, data age) in src/cli/ui/TrafficLight.tsx
- [x] T028 [US1] `watch` command: TTY → Ink live view; non-TTY/--json → NDJSON `reading` events; --interval (default 5, min 1, max 10 per FR-001 — out-of-range exits 2); SIGINT exit 0 in src/cli/commands/watch.ts
- [x] T029 [US1] Integration test: append turns to ws-growing fixture, assert displayed zone flips green→yellow within 10s and unknown state for ws-empty never fabricates a zone in tests/integration/watch.test.ts

**Checkpoint**: User Story 1 fully functional — quickstart scenarios 1–2 pass end-to-end

---

## Phase 4: User Story 2 - Zone-Appropriate Guidance on Transitions (Priority: P2)

**Goal**: One explainable notification per zone change with correct guidance, anti-nag
dismissals that re-arm on zone exit/escalation, multi-band jumps collapsed to final zone.

**Independent Test**: Replay ws-growing across 40/60/75 boundaries — exactly one event per
transition with correct guidance and trigger; dismiss in orange → silent until red
(quickstart scenarios 3–4).

### Tests for User Story 2 (write first, must fail)

- [x] T030 [P] [US2] Unit tests for transition detection: boundary crossings both directions, multi-band collapse to final zone only (FR-005), unknown→zone, restart continuity from persisted lastZone in tests/unit/transitions.test.ts
- [x] T031 [P] [US2] Unit tests for recommendation lifecycle: deterministic ids, pending→accepted/dismissed, no re-issue while same zone (FR-014), re-arm on zone exit and on escalation in tests/unit/recommendations.test.ts

### Implementation for User Story 2

- [x] T032 [US2] Zone transition detector comparing consecutive readings (+persisted lastZone) → ZoneTransition with direction in src/core/monitor/transitions.ts — makes T030 pass
- [x] T033 [US2] Recommendation engine: kind per zone (favor_retrieval/compact/new_session), guidance text embedding trigger explanation (FR-006), dismissal bookkeeping API in src/core/monitor/recommendations.ts — makes T031 pass
- [x] T034 [US2] MonitorState persistence: `.baton/state.json` read/write, per-session keying, corrupt/missing → empty state in src/core/monitor/state.ts
- [x] T035 [US2] Wire transitions + recommendations into `watch` (NDJSON `zone_transition`/`recommendation` events, Ink updates) and `status` lastTransition field in src/cli/commands/watch.ts and src/cli/commands/status.ts
- [x] T036 [P] [US2] Ink TransitionBanner + pending-recommendation list with `d` dismiss / `enter` act keybindings in src/cli/ui/TransitionBanner.tsx
- [x] T037 [US2] Contract test: multi-band jump emits exactly one zone_transition; dismissed recommendation not re-emitted while zone unchanged; NDJSON lines validate against zod schemas in tests/contract/watch-events.test.ts

**Checkpoint**: User Stories 1 AND 2 work independently — quickstart scenarios 3–4 pass

---

## Phase 5: User Story 3 - Artifact Candidate Identification (Priority: P2)

**Goal**: Deterministic verb/phrase rules surface save-worthy passages with named rules and
spans; user accepts/rejects individually; only accepted candidates are written.

**Independent Test**: `scan` ws-decisions → expected candidates with rule ids and spans,
byte-identical across runs; `scan` ws-no-matches → explicit empty result; `save` writes only
accepted files (quickstart scenarios 5–6).

### Tests for User Story 3 (constitution-mandated, write first, must fail)

- [x] T038 [P] [US3] Unit tests for scanner: determinism (two runs deep-equal AND byte-identical serialized), per-category rule matching, sentence-bound excerpts, correct line spans, stable candidate ids `hash(sessionId, ruleId, span)` in tests/unit/heuristics.test.ts

### Implementation for User Story 3

- [x] T039 [US3] Initial heuristic rule registry: 10–14 rules across decision/conclusion/constraint/result/task/question categories with ids like `decision.agreed-to`, `question.should-we`, descriptions, case-insensitive patterns in src/core/heuristics/rules.ts
- [x] T040 [US3] Deterministic scanner pure function `(content, rules) → ArtifactCandidate[]` (sentence split, span tracking, order-stable, no IO) in src/core/heuristics/scanner.ts — makes T038 pass
- [x] T041 [US3] Adapter content extraction: user+assistant text with transcript line spans for scanning in src/adapters/claude-code/content.ts
- [x] T042 [P] [US3] Contract test for `baton context scan`: JSON shape with rulesChecked, --category filter, explicit empty result (exit 0), byte-identical determinism across two runs in tests/contract/scan.test.ts
- [x] T043 [US3] `scan` command: human list + --json per contract (incl. deterministic scan `fingerprint`), "No candidates found" with categories checked in src/cli/commands/scan.ts — makes T042 pass
- [x] T044 [US3] Artifact store: accepted-only writes to `.baton/artifacts/<ts>-<ruleId>-<slug>.md` with provenance frontmatter (sessionId, ruleId, category, span, savedAt); no partial writes in src/core/artifacts/store.ts
- [x] T045 [P] [US3] Ink CandidateReview component: per-candidate accept/reject with excerpt + rule description in src/cli/ui/CandidateReview.tsx
- [x] T046 [US3] `save` command: interactive TTY review + explicit `save <candidate-id>…` mode, unknown id → exit 2 with id on stderr, --json saved paths in src/cli/commands/save.ts
- [x] T047 [US3] Contract test for `save`: only accepted candidates written, rejected leave no file (SC-004), unknown-id exit 2, --json shape in tests/contract/save.test.ts

### Proactive suggestions for User Story 3 (FR-015; depends on US2's transition machinery)

- [x] T048 [P] [US3] Unit tests (write first, must fail) for the proactive suggestion engine: entering orange/red triggers a scan, one save_candidate recommendation per candidate with rule_match trigger {ruleId, candidateId}, per-candidate dismissal honored (FR-014), saved/dismissed candidates never re-offered, new candidates from later in-zone activity surfaced, nothing written in tests/unit/proactive.test.ts
- [x] T049 [US3] Proactive suggestion engine: on escalation into orange/red and on refresh while in those zones, run the scanner over session content, filter out candidates already dismissed (MonitorState) or already saved (artifact frontmatter provenance), emit per-candidate save_candidate recommendations in src/core/heuristics/proactive.ts; wire into watch NDJSON events and the Ink pending list (aggregated display) in src/cli/commands/watch.ts — makes T048 pass

**Checkpoint**: Stories 1–3 independently functional — quickstart scenarios 5–6 and 10 pass

---

## Phase 6: User Story 4 - Handoff Summary (Priority: P3)

**Goal**: On request (recommended in red), produce a plain Markdown handoff file with
decisions, task state, and artifact references — available from any zone.

**Independent Test**: `handoff` on ws-red with saved artifacts → file with all sections and
artifact links; also succeeds on ws-green (quickstart scenario 7).

### Tests for User Story 4 (write first, must fail)

- [x] T050 [P] [US4] Integration test: handoff on ws-red produces Markdown with Decisions/Current task state/Saved artifacts/Open questions sections referencing fixture artifacts, every derived item naming its source (rule id + span, or artifact path); works from green; --out override respected in tests/integration/handoff.test.ts

### Implementation for User Story 4

- [x] T051 [US4] HandoffSummary assembly: derive decisions from saved artifacts + decision-rule matches, current task state from most recent user requests + task-category rule matches (behind a TaskStateSource port with transcript inference as the default implementation), open questions from question-category rule matches — every item carrying its source (rule id + span, or artifact path) — into the sections model in src/core/handoff/summary.ts
- [x] T052 [US4] `handoff` command: default `.baton/handoff/<ts>-handoff.md`, --out, --json `{path, sessionId, artifactCount}`, --yes; interactive TTY shows the derived draft for confirm/cancel (optional $EDITOR edit) before the single write, non-TTY/--json/--yes writes the draft directly; explicit-invocation-only in src/cli/commands/handoff.ts — makes T050 pass

**Checkpoint**: All user stories independently functional

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Constitution guarantees, performance, docs, end-to-end validation

- [x] T053 [P] Read-only guarantee test: checksum all fixture transcripts, run full command sweep (status/watch/scan/save/handoff/config), assert checksums unchanged AND that the only unprompted write anywhere in the workspace is the tool's own state file .baton/state.json (FR-007, SC-004) in tests/integration/read-only.test.ts
- [x] T054 [P] Performance test: 10MB generated transcript scans in <5s; reading refresh ≤10s after append (FR-001, plan Performance Goals) in tests/integration/performance.test.ts
- [x] T055 [P] Estimation accuracy test (SC-007): create calibration fixtures in tests/fixtures/calibration/ — transcript turns carrying exact `message.usage` truth values over mixed content (prose, code, JSON), truth stamped at fixture-generation time with a real tokenizer so runtime stays tokenizer-free; run the estimation path with usage fields ignored and assert estimated usage falls within 10 percentage points of exact for ≥95% of samples; on failure calibrate the divisor constant in src/lib/estimate.ts — never weaken the criterion — in tests/integration/estimate-accuracy.test.ts
- [x] T056 Run all 10 quickstart.md scenarios end-to-end via `npm link`; fix any drift between docs and behavior
- [x] T057 [P] README.md: install, command reference, baton.config.json thresholds, zones table, artifact/handoff file locations
- [x] T058 Trigger-wording audit: every recommendation/notification names its zone/threshold or rule id (FR-006, SC-003) — review src/core/monitor/recommendations.ts, src/core/heuristics/proactive.ts, and src/core/heuristics/rules.ts output strings

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — start immediately
- **Foundational (Phase 2)**: Depends on Setup — BLOCKS all user stories
- **US1 (Phase 3)**: Depends on Foundational (T015 SessionSource, T018–T019 adapter, T020 CLI shell)
- **US2 (Phase 4)**: Depends on Foundational + US1's watch/status commands (T028, T025) for wiring task T035; core tasks T030–T034 only need Foundational
- **US3 (Phase 5)**: T038–T047 depend on Foundational only — parallel with US2; the proactive pair T048–T049 additionally needs US2's transition machinery (T032–T035)
- **US4 (Phase 6)**: Depends on Foundational; consumes US3's artifact store (T044) for artifact references
- **Polish (Phase 7)**: Depends on all desired user stories

### User Story Dependencies

- **US1 (P1)**: Foundational only — MVP
- **US2 (P2)**: Foundational; T035 touches US1's command files (sequential with US1)
- **US3 (P2)**: Foundational; scan/save core (T038–T047) independent of US1/US2 — parallelizable; proactive suggestions (T048–T049) after US2 core (T032–T035)
- **US4 (P3)**: Foundational + T044 (artifact store) for links; independently testable via fixtures

### Within Each User Story

- Tests written first and failing before implementation (mandated for T007–T009, T017, T030–T031, T038, T048; applied to all included tests)
- Schemas/types → core services → adapter pieces → commands → UI wiring
- Story complete (checkpoint green) before moving to next priority

### Parallel Opportunities

- Setup: T003, T004, T005 after T001–T002
- Foundational: T006–T009 together; T010–T012 together; T014, T016, T021 alongside neighbors
- After Foundational: US2 core (T030–T034) and US3's scan/save tasks (T038–T047) can proceed in parallel by different contributors; T048–T049 after US2 core; US4 after T044
- Polish: T053, T054, T055, T057 in parallel

---

## Parallel Example: User Story 3

```bash
# Write the failing tests first:
Task: "T038 Unit tests for scanner determinism in tests/unit/heuristics.test.ts"
Task: "T042 Contract test for scan command in tests/contract/scan.test.ts"

# Then parallel implementation on different files:
Task: "T039 Rule registry in src/core/heuristics/rules.ts"
Task: "T041 Adapter content extraction in src/adapters/claude-code/content.ts"
Task: "T045 Ink CandidateReview in src/cli/ui/CandidateReview.tsx"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Phase 1: Setup (T001–T005)
2. Phase 2: Foundational (T006–T022) — the bulk of shared risk (adapter, config, zones)
3. Phase 3: US1 (T023–T029)
4. **STOP and VALIDATE**: quickstart scenarios 1–2 against fixtures and a real Claude Code session
5. Demo: a working traffic light is already a usable product

### Incremental Delivery

1. MVP (above) → usable gauge
2. US2 → transitions + guidance + anti-nag (quickstart 3–4)
3. US3 → scan/save with deterministic rules + proactive suggestions (quickstart 5–6, 10)
4. US4 → handoff (quickstart 7)
5. Polish → read-only proof, performance, docs (quickstart 8–9)

---

## Notes

- [P] = different files, no incomplete-task dependencies
- Constitution gates to keep green throughout: core never imports adapters/cli (T006 enforces), session data strictly read-only (T053 proves), every recommendation explains itself (T058 audits)
- Commit after each task or logical group; checkpoints are demo-able states
- Total: 58 tasks — Setup 5, Foundational 17, US1 7, US2 8, US3 12, US4 3, Polish 6
