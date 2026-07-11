# Phase 0 Research: Session Context Monitor

**Feature**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md) | **Date**: 2026-07-02

All Technical Context unknowns raised during planning are resolved below. No
NEEDS CLARIFICATION markers remain.

## R1. Source of context usage data (Claude Code)

- **Decision**: Read the active session's JSONL transcript under
  `~/.claude/projects/<encoded-project-path>/<session-id>.jsonl`. The most recent assistant
  entry's `message.usage` block (`input_tokens` + `cache_read_input_tokens` +
  `cache_creation_input_tokens` + `output_tokens`) is the exact context footprint of the
  latest turn. Usage % = that total ÷ resolved context window. "Active session" = the most
  recently modified transcript for the workspace, overridable via `--session <id>`.
- **Rationale**: Exact numbers straight from the agent's own accounting; passive and
  read-only (Principle II); requires no cooperation from the model mid-session; the same
  transcript access is needed anyway for heuristic scanning (spec Assumptions). The
  session-data root is overridable via the `BATON_CLAUDE_DIR` environment variable
  (default `~/.claude`) — the seam that lets tests and the quickstart run against fixture
  transcripts.
- **Alternatives considered**: (a) Model self-reports via MCP tool call — depends on model
  cooperation, adds context cost, and the MCP server is a sibling feature; rejected for v1.
  (b) Wrapping/proxying the agent process — invasive, fragile, violates read-only posture.
  (c) Manual user entry — defeats the purpose.
- **Risk noted**: transcript schema is undocumented/unversioned; mitigated by tolerant
  parsing (zod `.passthrough()`, skip malformed lines), fixture-based integration tests,
  and the estimation fallback (R4) when usage fields are absent.

## R2. Context window resolution per model

- **Decision**: Static map in the Claude Code adapter from model id (present on transcript
  entries) → context window size (e.g., 200k default class, 1M extended class). Unknown
  model id → assume the conservative 200k default and mark the reading **estimated**
  (FR-013). Map is data, overridable in `baton.config.json`.
- **Rationale**: Window size is not in the transcript; a small conservative map with an
  "estimate" label satisfies FR-011/FR-013 without network calls.
- **Alternatives considered**: querying a provider API (network dependency, offline
  constraint violated); hardcoding a single 200k constant (wrong for extended-context
  models, unlabeled inaccuracy).

## R3. Live terminal view

- **Decision**: Ink (React renderer for terminals) for `watch` mode: traffic-light widget,
  percentage, transition banners, and the interactive candidate-review list. Non-interactive
  commands print plain text / `--json` without Ink.
- **Rationale**: The user's stack lists React "if needed" — Ink is the terminal-native way
  to use it; declarative re-rendering fits a continuously updating gauge; interactive
  accept/reject flows (FR-009) come nearly free with `ink-select-input`-style components.
- **Alternatives considered**: raw ANSI escape rendering (fast but hand-rolled state/
  diffing, error-prone); blessed/blessed-contrib (unmaintained); full web UI (out of scope,
  violates CLI-first simplicity).

## R4. Token estimation fallback

- **Decision**: When usage fields are missing/unparseable, estimate tokens as
  `ceil(chars / 4)` over reconstructed conversation content, always labeled `estimated`.
  Pure function in `core/`, no tokenizer dependency. The divisor is a named constant
  validated against a calibration corpus whose true token counts are stamped offline with
  a real tokenizer (SC-007 accuracy test); if calibration shows drift, adjust the
  constant — never the criterion.
- **Rationale**: chars/4 is the industry rule-of-thumb for English/code, deterministic,
  dependency-free, and honest when labeled (FR-013, SC-007 targets ±10 points at 95%).
- **Alternatives considered**: bundling a real tokenizer (large dep, model-specific,
  still approximate for another vendor's models); no fallback (violates FR-011's usefulness
  in degraded states).

## R5. Session file watching

- **Decision**: chokidar watching the resolved transcript path (and session directory for
  rollover to a new session id), 500ms debounce; 5s polling fallback where FS events are
  unreliable. Meets the ≤10s refresh (FR-001) with margin.
- **Rationale**: Battle-tested cross-platform wrapper over fs events; handles macOS FSEvents
  quirks and atomic-write rename patterns that raw `fs.watch` mishandles.
- **Alternatives considered**: raw `fs.watch` (platform inconsistencies, rename-tracking
  bugs); pure polling (simpler but wastes IO and worst-case latency doubles).

## R6. CLI framework and command surface

- **Decision**: commander with a `context` command group on the `baton` binary:
  `status`, `watch`, `scan`, `save`, `handoff`, `config`. Global `--json` for machine
  output; stdout = results, stderr = diagnostics; exit codes per contract.
- **Rationale**: commander is minimal, typed, ubiquitous; subcommand group leaves room for
  sibling features (`baton specs …`, `baton mcp …`) on one binary (Principle V).
- **Alternatives considered**: yargs (heavier API), oclif (framework lock-in and codegen
  overkill for 6 commands), citty (younger ecosystem).

## R7. Configuration handling

- **Decision**: Single `baton.config.json` at workspace root, parsed and validated with zod;
  thresholds default to 40/60/75 when file or keys are absent. Validation failures name the
  offending key and rule, then fall back to defaults (FR-003). Refinements enforce
  `0 < yellow < orange < red ≤ 100`.
- **Rationale**: One source of truth for thresholds (constitution Operational Constraints);
  zod gives typed config + human-readable error messages from one schema.
- **Alternatives considered**: cosmiconfig multi-location lookup (violates "defined once",
  harder to reason about); env vars (poor discoverability, no structure).

## R8. Heuristic rule engine

- **Decision**: Declarative rule registry: each rule = `{ id, category, description,
  patterns }` where patterns are case-insensitive literal phrases / anchored regexes over
  sentence-split transcript text (user + assistant messages). Categories: `decision`
  ("we decided", "agreed to", "going with"), `conclusion` ("root cause", "turns out",
  "confirmed that"), `constraint` ("must not", "requires", "blocked by"), `result`
  ("produced", "generated", "final version"). Scanner is a pure function
  `(content, rules) → candidates`, order-stable, no IO — determinism (FR-012) is a unit
  test: same input twice ⇒ deep-equal output. Each candidate carries excerpt, transcript
  line span, and rule id (FR-006/FR-008).
- **Rationale**: Explainable-by-construction (candidate names its rule); pure function makes
  the constitution's determinism requirement trivially testable; declarative rules let users
  eventually add their own without code changes.
- **Alternatives considered**: LLM-based salience scoring (non-deterministic, context cost,
  violates constitution's explainability rule); TF-IDF/embedding ranking (opaque scores —
  fails "names the rule that fired"); could be layered later *behind* rule-based results as
  an ordering hint, never as the filter.

## R9. Docker

- **Decision**: Not used in v1. Revisit only for CI reproducibility if needed.
- **Rationale**: The tool must read `~/.claude` and the user's workspace on the host;
  containerizing adds mount/permission friction for zero user value in a local CLI.
- **Alternatives considered**: dev-container for contributor onboarding — deferred, not a
  feature requirement.

## R10. React beyond Ink

- **Decision**: React is used exclusively through Ink in `src/cli/ui/`. No DOM/web renderer.
- **Rationale**: Matches "react (if needed)" — needed only for the terminal UI; anything
  more violates YAGNI and CLI-first.
- **Alternatives considered**: none warranted.

## R11. Transition notification delivery

- **Decision**: v1 delivers notifications where the user is looking: the `watch` live view
  renders a transition banner (with zone, %, guidance, trigger), and `watch --json` emits an
  NDJSON `zone_transition` event per transition for scripting/statusline integration.
  `status` always shows current zone + last transition. Dismissals persist in
  `.baton/state.json` keyed by session id + zone (FR-014).
- **Rationale**: Satisfies FR-005/SC-002 without OS-level notification dependencies; the
  NDJSON stream is the seam for future OS toasts or statusline plugins.
- **Alternatives considered**: node-notifier OS notifications (nice-to-have, platform
  quirks, deferred as a follow-up feature); terminal bell only (not explainable).

## R12. Binary name

- **Decision**: `baton` (package `baton-cli`), with this feature under `baton context`.
  Workspace data lives in `.baton/`; configuration in `baton.config.json`.
- **Rationale**: Named for the tool's purpose rather than an internal brand: the
  conductor's baton (conducting the SDD workflow) and the relay baton (handing a session
  off to the next one). One product-level binary so later features (specs foregrounding,
  MCP server) join as `baton specs` / `baton mcp` rather than spawning parallel CLIs.
- **Alternatives considered**: `cielo` (original working name — rejected 2026-07-03 as an
  internal org reference); `sdd` (generic, collision-prone); `sema`, `steward`, `keep`
  (strong purpose-fit candidates, narrower coverage of the two pillars); `speckit` (not
  ours).

## R13. Handoff task-state derivation

- **Decision**: Layered. Baseline is deterministic transcript inference: current task
  state from the most recent user requests plus `task`-category rule matches; open
  questions from `question`-category rule matches (two new categories in the same registry
  as R8). In a TTY the derived draft is shown for confirm/edit before the single write;
  non-TTY, `--json`, or `--yes` writes the draft directly. Core exposes a `TaskStateSource`
  port; the transcript inferrer is its default implementation.
- **Rationale**: A transcript never announces the current task, so something must derive
  it. Reusing the R8 rule engine keeps derivation deterministic and explainable — every
  summary line names its rule and location (FR-006). The TTY review gives the user the
  last word on their own handoff (Principle II). The port lets the future SDD-framework
  adapter supply authoritative task state from feature task lists without core changes
  (Principle III).
- **Alternatives considered**: interactive-only prompting (breaks non-TTY/JSON parity);
  reading spec-kit artifacts now (perfect fidelity for SDD workspaces, but the framework
  adapter belongs to the spec-foregrounding sibling feature — premature scope and an early
  Principle III seam); LLM summarization (non-deterministic, violates the constitution's
  explainability rule).
