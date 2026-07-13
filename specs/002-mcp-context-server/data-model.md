# Data Model: MCP Context Server

**Feature**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md) | **Date**: 2026-07-11

This feature adds no new monitoring semantics — zones, readings, recommendations,
candidates, and dismissals are feature 001's entities, reused via their existing zod
schemas in `src/core/`. The entities below are the serving layer's own.

## Capability

One exposed tool. Registered from a static table so contracts and tests can audit it.

| Field | Type | Rules |
|---|---|---|
| name | string | `context_status` \| `context_catchup` \| `context_scan` \| `context_save` \| `context_handoff` \| `context_config` — 1:1 with the parity obligation |
| description | string | canonical, includes the when-to-use clause (FR-010); MUST equal the contract text verbatim (tested) |
| classification | `"read"` \| `"persisting"` | read ⇒ side-effect-free, idempotent, no approval; persisting ⇒ write-gated (FR-005/FR-006) |
| annotations | object | read tools: read-only + idempotent hints; persisting tools: non-read-only so hosts prompt |
| resultSchema | ref | the corresponding CLI `--json` zod schema from `src/core/` (FR-003 — one shape, two surfaces) |

## Connection

One agent host attached to one workspace-scoped server instance.

| Field | Type | Rules |
|---|---|---|
| workspace | string | absolute path; fixed at server start (cwd or `--workspace`) |
| allowWrites | boolean | operator attestation from `--allow-writes`; immutable for the instance lifetime |
| cursors | Map sessionId → CheckCursor | in-memory only; dies with the connection |

## CheckCursor

Where a connection's catch-up last left off, per session.

| Field | Type | Rules |
|---|---|---|
| sessionId | string | feature 001 SessionRef.id |
| position | int ≥ 0 | index of the last usage-bearing transcript entry already reported |
| lastZone | Zone name \| `"unknown"` | zone at that position (replay resumes from here) |

**Lifecycle**: created on a connection's first `context_catchup` for a session (first call
returns the current snapshot, not history); advanced on every subsequent call; never
persisted — cursors are per-connection ephemera (research R4).

## CatchupReport

The answer to "what changed since I last checked?".

| Field | Type | Rules |
|---|---|---|
| sessionId | string | |
| transitions | ZoneTransition[] | derived by replay (below); multi-band jumps collapsed to one transition each (FR-009) |
| pending | Recommendation[] | currently pending only — user-dismissed ones excluded while the zone is unchanged (FR-009) |
| empty | boolean | true ⇒ transitions and pending are both empty; the whole report stays within the SC-003 budget |

## Replay (derivation rules — pure function, `src/core/monitor/replay.ts`)

`(usageHistory, thresholds, fromCursor) → { transitions, toCursor }`

- Input is the transcript's per-entry usage series from the cursor position forward —
  already available from the adapter; no new observation state.
- Each consecutive pair classifies through feature 001's zone function; a zone change
  emits one ZoneTransition carrying the reading that caused it; entries within one zone
  emit nothing.
- Invariants (unit-tested): deterministic — same history + same cursor ⇒ identical
  report; multi-band jumps collapse to the final zone; no transition is ever fabricated
  from estimated-vs-exact flapping alone; unknown states produce no zone claim.

## WriteGate

The Principle II enforcement for persisting capabilities (research R3).

| Field | Type | Rules |
|---|---|---|
| allowWrites | boolean | from Connection; false ⇒ persisting tools return Decline, never execute |
| approval | external | per-request user approval is the host's tool prompt; the server treats invocation-under-attestation as approved, and absence of the attestation as denial |

**Decline** (returned by persisting tools when gated):

| Field | Type | Rules |
|---|---|---|
| declined | true | literal |
| reason | string | e.g. `writes-disabled` |
| instructions | string | the exact CLI command that performs the same action, plus how to enable (`baton mcp --allow-writes`) |

## AuditEntry (persisted, append-only, `.baton/audit.log`)

One line per executed persisting operation (FR-014) — the traceability record of what
the agent wrote and when. It records invocations-under-attestation; the approval itself
happens in the host and is not observable by the server.

| Field | Type | Rules |
|---|---|---|
| timestamp | ISO datetime | when the write completed |
| capability | `"context_save"` \| `"context_handoff"` | |
| detail | object | candidateIds[] for saves; output path for handoffs |
| written | string[] | workspace paths created |
| gate | `"allow-writes"` | the gate state that admitted the write |

**Invariants**: contains no session content (ids, paths, timestamps only — the same
exemption discipline as MonitorState); written ONLY when a persisting capability
executes — declines and read tools never touch it, keeping their byte-identical
no-write guarantees testable (FR-005, T019).

## Relationships

```text
Connection 1 ──▶ 6 Capability (static registry)
Connection 1 ──▶ * CheckCursor (per session, in-memory)
context_catchup ──▶ Replay ──▶ CatchupReport (dismissals filtered via feature 001 MonitorState)
context_save / context_handoff ──▶ WriteGate ──▶ feature 001 artifact store / handoff generator
Executed write ──▶ AuditEntry (append-only .baton/audit.log; declines/reads never write it)
All result shapes ──▶ feature 001 zod schemas (single source of truth, FR-003)
```
