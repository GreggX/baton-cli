# Implementation Plan: MCP Context Server

**Branch**: `002-mcp-context-server` | **Date**: 2026-07-11 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/002-mcp-context-server/spec.md`

**Note**: This template is filled in by the `/speckit-plan` command. See `.specify/templates/plan-template.md` for the execution workflow.

## Summary

Expose the six Session Context Monitor capabilities to the model over MCP, paying the
Principle V parity debt tracked in `specs/mcp-parity-obligation.md`. A new thin
presentation layer (`src/mcp/`, peer of `src/cli/`) registers six tools on the official
MCP TypeScript SDK over stdio, launched as `baton mcp` on the existing binary. All
behavior comes from the existing `src/core/` + adapter — same zod schemas, same values as
the CLI. Read tools (status, catch-up, scan, config) are side-effect-free and token-lean
(≤200-token routine responses); persisting tools (save, handoff) execute only when the
operator started the server with `--allow-writes` (attesting their host prompts per
request) and otherwise decline with CLI instructions. Catch-up is computed by
deterministic replay of the transcript's usage history since the caller's cursor — no
background loop — honoring dismissals shared with the CLI through `.baton/state.json`.

## Technical Context

**Language/Version**: TypeScript 6 (strict) on Node.js ≥ 22 — unchanged from feature 001

**Primary Dependencies**: existing (commander, zod 4, chokidar) + `@modelcontextprotocol/sdk`
(official TypeScript SDK, 1.29.0 current) for server, stdio transport, and in-memory
test client. No Ink in this layer — the MCP surface has no TTY.

**Storage**: nothing new. Reads transcripts via the existing adapter; writes only through
the existing artifact store and handoff generator; shares `.baton/state.json` (dismissals,
lastZone) with the CLI — writes to it become atomic (temp file + rename) for FR-013.
New: an append-only `.baton/audit.log` records every executed MCP write (FR-014);
declines and read tools never touch it.

**Testing**: vitest; MCP client ↔ server over the SDK's in-memory transport for contract
tests; parity tests diff tool results against CLI `--json` on the same fixtures;
token-budget assertions on routine responses.

**Target Platform**: local subprocess of the agent host (stdio), macOS/Linux; no network
listener of any kind (FR-012)

**Project Type**: single project — new `src/mcp/` presentation layer over the existing core

**Performance Goals**: status tool answers < 2s (SC-001, trivially met by on-demand file
read); routine responses ≤ 200 tokens of agent-visible content (SC-003, ≈800 chars via
the chars/4 rule, asserted in contract tests)

**Constraints**: read tools MUST be side-effect-free and idempotent; persisting tools
MUST be gated (host approval + `--allow-writes` attestation, decline otherwise); values
MUST equal CLI values for identical state (FR-003); local-only; session data strictly
read-only (constitution)

**Scale/Scope**: 6 tools, 1 workspace per server instance, cursors for a handful of
concurrent client connections; ~5 new source files + 1 CLI command

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| # | Principle | Gate evaluation | Status |
|---|-----------|-----------------|--------|
| I | Context Efficiency Is the Product | Every tool returns targeted slices; SC-003 caps routine responses at 200 tokens, enforced by contract test; no tool can return transcript bulk (FR-004). Tool descriptions steer the model toward cheap checks (FR-010). | ✅ PASS |
| II | Advise, Never Decide | Read tools have zero side effects. Persisting tools require per-request user approval via the host prompt, are enabled only under the operator's `--allow-writes` attestation, and decline with CLI instructions otherwise (FR-006). Absence of approval is a no. The server never acts on its own — it has no background writes at all, and every executed write leaves a local audit entry (FR-014). | ✅ PASS |
| III | Spec-Kit First, Adapter-Ready Core | `src/mcp/` consumes `src/core/` + the adapter exactly like `src/cli/` does; no agent-specific knowledge added outside `src/adapters/`. The architecture boundary test extends to assert `src/core/` imports nothing from `src/mcp/`. | ✅ PASS |
| IV | Specs Stay Foregrounded | Out of scope here (feature 003), but this server is the canonical channel Principle IV names — 003 will register its capabilities on this same server. No conflict. | ✅ PASS (n/a) |
| V | CLI-First With MCP Parity | This feature IS the parity payment: all six capabilities on one shared core, same zod schemas, values diffed against the CLI in tests. Closing flips `specs/mcp-parity-obligation.md` to SATISFIED (FR-002, SC-007). | ✅ PASS |

**Post-Phase-1 re-check** (after data-model.md, contracts/, quickstart.md): design
artifacts introduce no new violations — the catch-up replay is a pure core function
(III), tool contracts embed the canonical when-to-use descriptions and budgets (I),
and the write-gating matrix in the contract makes II's decline path testable. Gates
remain ✅ PASS.

## Project Structure

### Documentation (this feature)

```text
specs/002-mcp-context-server/
├── plan.md              # This file (/speckit-plan command output)
├── research.md          # Phase 0 output (/speckit-plan command)
├── data-model.md        # Phase 1 output (/speckit-plan command)
├── quickstart.md        # Phase 1 output (/speckit-plan command)
├── contracts/           # Phase 1 output (/speckit-plan command)
│   └── mcp-tools.md
└── tasks.md             # Phase 2 output (/speckit-tasks command - NOT created by /speckit-plan)
```

### Source Code (repository root)

```text
src/
├── core/
│   └── monitor/
│       └── replay.ts            # NEW: pure usage-history → transitions replay (catch-up math)
├── mcp/                         # NEW presentation layer (peer of src/cli/)
│   ├── server.ts                # SDK server wiring: registration, stdio transport, lifecycle
│   ├── registry.ts              # capability table: names, canonical descriptions, annotations
│   ├── tools.ts                 # six tool handlers (thin over core)
│   ├── cursors.ts               # per-connection CheckCursor bookkeeping (in-memory)
│   └── gating.ts                # --allow-writes gate + decline responses + audit writer
└── cli/
    └── commands/
        └── mcp.ts               # NEW: `baton mcp [--allow-writes]` launcher on the same binary

tests/
├── unit/replay.test.ts          # replay determinism, multi-band collapse, torn-tail tolerance
├── integration/mcp-stdio.test.ts  # real subprocess handshake, <2s latency, no listening sockets
└── contract/
    ├── helpers/mcp-harness.ts   # in-memory client↔server harness over fixture workspaces
    ├── mcp-tools.test.ts        # six tools listed, schemas validate, descriptions canonical
    ├── mcp-parity.test.ts       # tool values ≡ CLI --json values on same fixtures (SC-004)
    ├── mcp-budget.test.ts       # routine responses ≤200 tokens; no bulk content (SC-003)
    └── mcp-gating.test.ts       # write-gating matrix + audit entries (SC-002, FR-014)
```

**Structure Decision**: `src/mcp/` mirrors `src/cli/` as a second thin face over the same
core (Principle V); the only new core code is the pure replay function, placed in
`src/core/monitor/` so any future surface (push notifications, 003) reuses it. The
existing dependency-boundary test grows one assertion: `src/core/` never imports
`src/mcp/`.

## Complexity Tracking

> **Fill ONLY if Constitution Check has violations that must be justified**

No violations — table intentionally empty. Note: on feature close, flip
`specs/mcp-parity-obligation.md` status to SATISFIED with a link back to this feature
(tracked as a task; the obligation's acceptance checklist is the closing gate).
