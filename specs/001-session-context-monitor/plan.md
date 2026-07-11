# Implementation Plan: Session Context Monitor

**Branch**: `001-session-context-monitor` | **Date**: 2026-07-02 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/001-session-context-monitor/spec.md`

**Note**: This template is filled in by the `/speckit-plan` command. See `.specify/templates/plan-template.md` for the execution workflow.

## Summary

Build the traffic-light session context monitor: a TypeScript CLI that passively observes a
Claude Code session's transcript data, computes context usage as a percentage of the model's
context window, classifies it into green/yellow/orange/red zones (40/60/75 defaults from the
constitution, user-configurable), notifies on zone transitions with explainable guidance,
surfaces artifact-save candidates via deterministic verb/phrase heuristic rules, and
generates handoff summaries — all advisory, never acting on session data without explicit
user confirmation. Architecture is a framework-agnostic core library with a Claude Code
session adapter and a thin CLI (Ink-based live view), so the future MCP server feature can
expose the same core without parallel implementations.

## Technical Context

**Language/Version**: TypeScript 5.x (strict mode) on Node.js ≥ 22 (24 LTS recommended)

**Primary Dependencies**: commander (CLI parsing), Ink + React (live terminal view only),
zod (config/schema validation and JSON output contracts), chokidar (session file watching)

**Storage**: Plain files in the workspace — `baton.config.json` (thresholds, zod-validated),
`.baton/artifacts/` (accepted artifacts, Markdown), `.baton/handoff/` (handoff summaries,
Markdown), `.baton/state.json` (recommendation dismissal state per session). Session data
itself is read-only input (Claude Code JSONL transcripts under `~/.claude/projects/`).

**Testing**: vitest (unit, integration against fixture transcripts, CLI contract tests)

**Target Platform**: macOS and Linux terminals; local-only, no network access

**Project Type**: Single-project CLI (core library + adapters + CLI entry)

**Performance Goals**: usage reading refreshed ≤ 10s after new session activity (FR-001,
via file-watch events, ≤ 5s polling fallback); transition notification ≤ 10s (SC-002);
heuristic scan of a 10 MB transcript completes in < 5s

**Constraints**: session data strictly read-only (never mutate agent files); estimates
visibly labeled (FR-013); no lossy/persisting action without explicit confirmation (FR-007);
deterministic heuristics — no randomness, no LLM calls in the scan path (FR-012);
offline-capable, zero network calls

**Scale/Scope**: single user, one monitored session at a time, transcripts up to ~200k
tokens / tens of MB; 6 CLI subcommands; initial rule set of ~10–14 heuristic rules in 6
categories (decision, conclusion, constraint, result, task, question)

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| # | Principle | Gate evaluation | Status |
|---|-----------|-----------------|--------|
| I | Context Efficiency Is the Product | Monitor observes passively and pushes nothing into model context; usage is measurable and surfaced continuously (status/watch). Thresholds defined once in `baton.config.json`, consumed everywhere. | ✅ PASS |
| II | Advise, Never Decide | All zone guidance is advisory text; artifact saves and handoff writes require explicit accept per candidate/request (FR-007, FR-009); dismissal state honored (FR-014). No code path mutates or compacts session data. | ✅ PASS |
| III | Spec-Kit First, Adapter-Ready Core | Agent-specific knowledge (JSONL layout, usage fields, model→window map) isolated in `src/adapters/claude-code/` behind the `SessionSource` interface; `src/core/` has zero Claude Code imports (enforced by dependency-lint test). | ✅ PASS |
| IV | Specs Stay Foregrounded | Out of this feature's scope (sibling MCP/foregrounding feature); nothing here conflicts with it. | ✅ PASS (n/a) |
| V | CLI-First With MCP Parity | All behavior lives in `src/core/` + adapters as a library; CLI commands are thin wrappers with `--json` output validated by the same zod schemas the future MCP server will reuse. MCP exposure itself ships with the dedicated MCP feature over this same core — no parallel implementation is created. | ✅ PASS (with note) |

**Post-Phase-1 re-check** (after data-model.md, contracts/, quickstart.md): design artifacts
introduce no new violations — contracts are zod-schema'd CLI commands (V), data model keeps
adapter types out of core entities (III), and every lossy operation in the contracts requires
an explicit user action (II). Gates remain ✅ PASS.

## Project Structure

### Documentation (this feature)

```text
specs/001-session-context-monitor/
├── plan.md              # This file (/speckit-plan command output)
├── research.md          # Phase 0 output (/speckit-plan command)
├── data-model.md        # Phase 1 output (/speckit-plan command)
├── quickstart.md        # Phase 1 output (/speckit-plan command)
├── contracts/           # Phase 1 output (/speckit-plan command)
│   └── cli-interface.md
└── tasks.md             # Phase 2 output (/speckit-tasks command - NOT created by /speckit-plan)
```

### Source Code (repository root)

```text
src/
├── core/                        # framework- and agent-agnostic (no adapter imports)
│   ├── monitor/                 # UsageReading, Zone classification, ZoneTransition,
│   │                            #   Recommendation lifecycle (pending/accepted/dismissed, re-arm)
│   ├── heuristics/              # HeuristicRule registry, deterministic scanner,
│   │                            #   ArtifactCandidate production
│   ├── artifacts/               # candidate → workspace file persistence (Markdown)
│   ├── handoff/                 # HandoffSummary assembly + rendering
│   └── config/                  # zod schemas: thresholds, rules config; validation errors
├── adapters/
│   └── claude-code/             # SessionSource impl: session discovery, JSONL tail-parse,
│                                #   usage extraction, token estimation fallback, model→window map
├── cli/
│   ├── commands/                # status, watch, scan, save, handoff, config
│   └── ui/                      # Ink components: TrafficLight, TransitionBanner, CandidateReview
└── lib/                         # shared utils: token estimate, safe file IO, time

tests/
├── unit/                        # zone math, threshold validation, rule determinism, estimation
├── integration/                 # adapter vs fixture JSONL transcripts; artifact/handoff writes
├── contract/                    # CLI --json outputs validate against contracts/ schemas
└── fixtures/                    # synthetic Claude Code transcripts (small/large/edge cases)
```

**Structure Decision**: Single package, layered by constitutional boundary: `core/` is the
shared library (Principle V), `adapters/claude-code/` is the only place agent-specific
knowledge may live (Principle III), `cli/` is a thin presentation layer. A dependency test
asserts `core/` never imports from `adapters/` or `cli/`.

## Complexity Tracking

> **Fill ONLY if Constitution Check has violations that must be justified**

No violations — table intentionally empty. One tracked obligation (not a violation):
**Principle V parity debt** — the MCP surface for this feature's six capabilities (status,
watch, scan, save, handoff, config) ships with the dedicated MCP-server feature, which MUST
import the same `src/core/` library and expose the same zod schemas defined by this plan's
contracts. Parity for these commands is owed before any release that claims Principle V
compliance, and the MCP-server feature's spec MUST reference this obligation when it is
created. The obligation is materialized as a stub that feature must satisfy:
[`specs/mcp-parity-obligation.md`](../mcp-parity-obligation.md).
