# Phase 0 Research: MCP Context Server

**Feature**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md) | **Date**: 2026-07-11

All Technical Context unknowns are resolved below. No NEEDS CLARIFICATION markers remain.

## R1. Protocol implementation & transport

- **Decision**: Official MCP TypeScript SDK (`@modelcontextprotocol/sdk`, 1.29.0 current)
  with the stdio transport, launched by the agent host as a subprocess (`baton mcp`).
- **Rationale**: The SDK handles protocol negotiation, tool registration, schema plumbing
  (zod-native — our schemas drop in), and ships an in-memory transport for tests. Stdio
  keeps FR-012 trivially true: no listener, no port, nothing leaves the machine; hosts
  launch project-scoped servers this way by convention, which also gives us the
  workspace-per-instance model for free (cwd = workspace).
- **Alternatives considered**: hand-rolled JSON-RPC (needless protocol risk);
  HTTP/streamable transport (creates a network surface FR-012 forbids and complicates
  the one-workspace scoping for zero benefit in a local tool).

## R2. Tool surface & naming

- **Decision**: Six tools with a `context_` prefix mapping 1:1 to the parity obligation:
  `context_status`, `context_catchup` (watch's advisory surface), `context_scan`,
  `context_save`, `context_handoff`, `context_config`.
- **Rationale**: Prefix namespaces the monitor so feature 003 can add `specs_*` tools on
  the same server without collision; names are verbs the model already knows from the
  tool descriptions; the mapping table in the obligation file closes cleanly.
- **Alternatives considered**: bare names (`status` — collision-prone across servers);
  one mega-tool with an `action` parameter (hides capabilities from host permission
  systems and tool-level annotations — defeats the approval model).

## R3. Write approval (the Principle II gate)

- **Decision**: Three layers. (1) Read tools are annotated read-only/idempotent; the
  persisting tools (`context_save`, `context_handoff`) carry non-read-only annotations so
  hosts prompt for them. (2) The per-request user approval required by FR-006 is the
  host's tool-approval prompt — the operator consented UI. (3) Persisting tools execute
  only when the server was started with `--allow-writes`, the operator's standing
  attestation that their host mediates approvals; without the flag both tools are still
  listed (parity) but return a structured decline pointing to the exact CLI command.
  Absence of approval is always a no; the server itself performs zero unprompted writes.
- **Rationale**: The server cannot observe the host's UI, so it cannot verify a prompt
  happened; the flag moves that attestation to the human who configures the host —
  per-request consent stays with the host prompt, and environments without prompts are
  safe by default. Listing-but-declining keeps the obligation's "expose all six" honest
  without weakening FR-006.
- **Alternatives considered**: a `confirmed: true` tool parameter (the model can set it —
  gates nothing); hiding persisting tools without the flag (breaks parity listing and
  makes the decline path undiscoverable); elicitation/interactive confirmation through
  the protocol (host support uneven; revisit when ubiquitous).

## R4. Catch-up computation

- **Decision**: Deterministic on-demand replay: `context_catchup` reads the transcript's
  per-turn usage history from the caller's CheckCursor forward, runs it through the
  existing zone classifier, collapses multi-band jumps, and filters recommendations
  against persisted dismissals. Pure function in `src/core/monitor/replay.ts`; no
  background watcher lives in the server.
- **Rationale**: The transcript already contains the full usage history, so transitions
  are derivable, not stateful — replay makes catch-up deterministic and unit-testable
  (same history + same cursor ⇒ same report), keeps the server process passive
  (Principle II: no background activity at all), and reuses zones/transitions code.
- **Alternatives considered**: background chokidar watcher accumulating events (stateful,
  duplicates the CLI watch loop, invites drift between accumulated and derived truth);
  persisting cursors in state.json (cursors are per-connection ephemera; persistence
  would leak one client's read position into another's).

## R5. Response budget enforcement

- **Decision**: Tool results are the CLI's compact `--json` shapes serialized single-line;
  a contract test asserts `context_status` and empty `context_catchup` responses stay
  ≤ 200 tokens (chars/4 rule, ≈800 chars) and that no tool result ever embeds transcript
  content (SC-003/FR-004).
- **Rationale**: The budget is the product promise (a monitor that bloats the context it
  monitors is self-defeating); enforcing it as a test keeps it true as fields accrete.
- **Alternatives considered**: human-readable text results (burns tokens on prose the
  model doesn't need); trusting review instead of tests (budgets rot).

## R6. Tool descriptions as canon

- **Decision**: Each tool's description is a canonical string defined next to the handler
  and quoted verbatim in contracts/mcp-tools.md, including the when-to-use clause
  (e.g. status: "…check before pasting large content"; scan: "…use in orange/red before
  compacting"). A contract test asserts served descriptions equal the contract's.
- **Rationale**: FR-010 — descriptions are the model's only standing self-regulation
  instructions; treating them as tested contract text gives them the same rigor as
  guidance copy in feature 001 (T058 precedent).
- **Alternatives considered**: freeform descriptions (drift, untested); prompts/resources
  for instructions (hosts surface tool descriptions most reliably today).

## R7. Placement on the binary

- **Decision**: `baton mcp [--allow-writes] [--workspace <path>]` as a new top-level
  command launching `src/mcp/server.ts`; `src/mcp/` is a presentation layer peer of
  `src/cli/` (cli → mcp import direction only, for the launcher).
- **Rationale**: One product, one binary (001's R6/R12 reserved `baton mcp` for exactly
  this); hosts configure `command: baton, args: [mcp]` — the SC-005 single step.
- **Alternatives considered**: separate `baton-mcp` binary (two things to install/version);
  running the server inside `watch` (couples the human TTY surface to the host's
  subprocess lifecycle).

## R8. Test strategy

- **Decision**: SDK in-memory transport pairs a real client and the real server in-process
  for contract tests (listing, schemas, descriptions, gating); parity tests run the same
  fixtures through tool calls and CLI `--json` and diff the values (SC-004); replay gets
  pure unit tests; quickstart covers the real stdio path against a live host.
- **Rationale**: In-memory transport exercises the actual protocol without subprocess
  flakiness; parity-by-diff is the cheapest possible enforcement of FR-003's "one
  behavior, two surfaces".
- **Alternatives considered**: spawning the stdio server in every test (slower, flaky
  under CI load — reserved for one smoke test); mocking the SDK (tests would prove
  nothing about the protocol surface).

## R9. Shared-state concurrency (FR-013)

- **Decision**: `.baton/state.json` writes become atomic (write temp file, rename) with
  last-writer-wins semantics; readers tolerate mid-rename absence (existing corrupt→empty
  behavior covers it). Documented as sufficient for the single-user, two-surface reality.
- **Rationale**: CLI and server on one workspace is normal (watch open + agent connected);
  rename-atomicity removes torn writes with one line of code, and the state is
  reconstruction-safe bookkeeping (worst case: one duplicate notification — feature 001's
  documented failure mode).
- **Alternatives considered**: file locking (portability pain, deadlock risk, oversized
  for bookkeeping data); moving state into the server (breaks CLI-only usage).
