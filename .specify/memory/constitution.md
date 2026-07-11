<!--
Sync Impact Report
==================
Version change: 1.0.0 → 1.0.1 (PATCH — non-semantic wording)
Change: project title renamed "Cielo SDD CLI Constitution" → "Baton Constitution",
  following the 2026-07-03 decision to drop the internal "cielo" brand from all tool
  naming (binary `baton`, config `baton.config.json`, workspace dir `.baton/`,
  npm package `baton-cli`). No principle, constraint, or governance content changed.
Modified principles: none
Added/Removed sections: none
Templates status: no template references the project title — ✅ no updates required;
  feature artifacts under specs/001-session-context-monitor/ updated in the same change
Follow-up TODOs: none
(Previous report — v1.0.0 initial ratification, 2026-07-02: all five principles,
Operational Constraints, and Development Workflow sections created from template;
all dependent templates verified compatible.)
-->

# Baton Constitution

## Core Principles

### I. Context Efficiency Is the Product

The CLI exists to keep the model at peak performance by managing session context. Session
context usage MUST be continuously measurable and surfaced to the user via the traffic-light
indicator defined in Operational Constraints. Every feature MUST be evaluated for its impact
on the context budget: a feature that pushes data into the model's context MUST justify that
cost against a retrieval-based alternative. When in doubt, retrieval wins over dumping.

**Rationale**: Degraded model performance from context saturation is the core problem this
tool solves; a feature that worsens it contradicts the product's reason to exist.

### II. Advise, Never Decide

The tool recommends; the user decides. Context actions — saving an artifact, compacting the
conversation, starting a new session — MUST be presented as recommendations with an explicit
rationale (which zone, which signal, which heuristic fired). The CLI MUST NOT silently
discard, compact, summarize, or persist session data. Any lossy or destructive operation on
session content REQUIRES explicit user confirmation.

**Rationale**: Only the user knows which session data is truly valuable to their work; the
tool's job is to make that judgment easy and well-informed, not to make it for them.

### III. Spec-Kit First, Adapter-Ready Core

Version 1 targets spec-kit with high cohesion, and that focus MUST NOT leak into the core.
Framework-specific knowledge (file layouts, artifact names, workflow phases) MUST live behind
an adapter interface; the core — context monitor, heuristics engine, artifact store, MCP
server — MUST be framework-agnostic. Supporting Kiro or another SDD framework later MUST
require only a new adapter, never core changes. Hard-coding spec-kit paths or conventions
outside the spec-kit adapter is a constitution violation.

**Rationale**: Deep spec-kit integration ships value now; the adapter seam keeps that speed
from becoming lock-in when Kiro and other frameworks are added.

### IV. Specs Stay Foregrounded

The active specification and its task state MUST remain visible to both the user and the
model for the whole session — the user never loses sight of the task they are working on.
The MCP server is the canonical channel through which the model retrieves current spec and
task state, and it MUST serve targeted, on-demand slices rather than whole-document dumps
(honoring Principle I). The concrete foregrounding mechanism (tools, resources, prompts,
notifications, or a combination) is a per-feature design decision made in the plan phase —
the obligation that specs stay foregrounded is not.

**Rationale**: SDD fails when the executing model drifts from the spec; keeping spec state
pinned and cheaply retrievable is what makes the workflow trustworthy.

### V. CLI-First With MCP Parity

Every capability MUST be operable from the CLI: arguments and stdin in, results on stdout,
errors on stderr, with both human-readable and JSON output formats. Every capability that is
meaningful to a model MUST also be exposed via MCP tools/resources. CLI and MCP are two
faces of one shared core library — parallel implementations of the same behavior are
forbidden.

**Rationale**: A single core keeps CLI and MCP behavior from diverging, and text I/O keeps
every feature scriptable, testable, and debuggable.

## Operational Constraints

**Traffic-light zones** — the canonical thresholds, defined once in configuration and
consumed everywhere (defaults below; user-configurable, but defaults MUST NOT drift across
the codebase):

| Zone   | Context usage | Signal                     | Guidance                                                                 |
|--------|---------------|----------------------------|--------------------------------------------------------------------------|
| Green  | 0–40%         | Keep prompting             | Normal operation                                                          |
| Yellow | 40–60%        | Favor retrieval over dumps | Prefer targeted retrieval; warn against pasting large documents           |
| Orange | 60–75%        | Compact recommended        | Surface artifact-save candidates; recommend compacting the conversation   |
| Red    | ≥75%          | New session suggested      | Generate a handoff summary; recommend starting a fresh session            |

**Heuristics**: Artifact-candidate detection (verb/phrase analysis and related techniques)
MUST be deterministic, unit-testable, and explainable — every recommendation names the rule
or signal that produced it. Opaque scoring with no traceable cause is not acceptable.

**Artifacts**: Saved artifacts and handoff summaries MUST be plain, portable files inside
the workspace (inspectable, diffable, editable by hand). No proprietary or binary formats
for user-facing session data.

## Development Workflow

**Dogfooding**: This project is built with the SDD workflow it serves. Every feature MUST
pass through specify → clarify → plan → tasks → implement using the spec-kit tooling in this
repository.

**Constitution gate**: The Constitution Check in each plan.md MUST evaluate the design
against Principles I–V. Violations MUST be recorded in Complexity Tracking with a
justification and a rejected simpler alternative, or the design MUST be revised.

**Testing discipline**: Threshold logic, heuristics, and adapter contracts MUST have tests
written before implementation (their correctness is the product's credibility). Other code
SHOULD follow test-first; deviations are flagged in review.

**Simplicity**: Start with the simplest mechanism that satisfies a principle (YAGNI).
Additional framework adapters beyond spec-kit are out of scope until the spec-kit path is
proven end-to-end.

## Governance

This constitution supersedes all other practices in this repository. Anyone proposing work
that conflicts with it MUST either change the work or amend the constitution first.

**Amendments**: An amendment is a change to this file submitted with a Sync Impact Report
(prepended as the leading HTML comment), a semantic version bump, and updates to any
dependent templates. Versioning policy:

- **MAJOR**: Backward-incompatible governance changes — removing or redefining a principle.
- **MINOR**: New principle or section added, or materially expanded guidance.
- **PATCH**: Clarifications, wording, and typo fixes with no semantic change.

**Compliance review**: `/speckit-plan` enforces the Constitution Check gate before design;
`/speckit-analyze` verifies cross-artifact consistency after task generation; code review
verifies that implementations honor the principles (especially II's confirmation requirement
and III's adapter boundary). Runtime development guidance lives in `CLAUDE.md`, which points
to the current plan.

**Version**: 1.0.1 | **Ratified**: 2026-07-02 | **Last Amended**: 2026-07-03
