# Obligation: MCP Parity for Session Context Monitor Capabilities

**Status**: OPEN — must be satisfied by the MCP-server feature's spec before any release
claiming constitution Principle V compliance.

**Source**: Constitution v1.0.1, Principle V (CLI-First With MCP Parity). Deferral
recorded in [001-session-context-monitor/plan.md](001-session-context-monitor/plan.md),
Complexity Tracking ("Principle V parity debt").

## What the future MCP-server feature MUST satisfy

Expose every capability below over MCP by importing the same `src/core/` library and
validating with the same zod schemas as the CLI. `src/core/` is the single source of
truth — a parallel implementation is a constitution violation, not a shortcut.

| CLI capability | Contract | MCP surface owed |
|---|---|---|
| `baton context status` | [cli-interface.md](001-session-context-monitor/contracts/cli-interface.md) | tool/resource returning the status JSON shape |
| `baton context watch` | " | transition/recommendation event delivery (mechanism decided in the MCP feature's plan) |
| `baton context scan` | " | tool returning the scan JSON shape |
| `baton context save` | " | tool accepting candidate ids — explicit user confirmation preserved (Principle II) |
| `baton context handoff` | " | tool producing the handoff summary — explicit request only |
| `baton context config` | " | tool/resource returning effective thresholds + validation results |

## Acceptance for closing this obligation

- [ ] The MCP feature's spec references this file and enumerates all six capabilities
- [ ] Implementation imports `src/core/` (no re-implementation; the architecture boundary
      test is extended to cover the MCP surface)
- [ ] MCP outputs validate against the same zod schemas as the CLI `--json` contracts
- [ ] Principle II preserved: no MCP tool performs a lossy or persisting action without an
      explicitly user-confirmed request
- [ ] This file's Status is flipped to SATISFIED with a link to the closing feature

Created 2026-07-03 during `/speckit-analyze` remediation (finding C1).
