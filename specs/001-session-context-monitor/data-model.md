# Data Model: Session Context Monitor

**Feature**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md) | **Date**: 2026-07-02

All entities live in `src/core/` as zod schemas + inferred TypeScript types (single source
of truth for runtime validation, CLI `--json` contracts, and the future MCP surface).
Adapter-specific types (transcript line shapes) stay in `src/adapters/claude-code/` and
never leak into these entities (Principle III).

## SessionRef

The monitored session, as core sees it (adapter resolves it).

| Field | Type | Rules |
|---|---|---|
| id | string | non-empty; adapter-native session identifier |
| workspace | string | absolute path of the project the session belongs to |
| modelId | string \| null | as reported by session data; null → window estimated |
| lastActivityAt | ISO datetime | drives staleness display (FR-011) |

## UsageReading

Point-in-time measurement. Immutable.

| Field | Type | Rules |
|---|---|---|
| sessionId | string | FK → SessionRef.id |
| tokensUsed | int ≥ 0 | from usage accounting, or estimated (R4) |
| contextWindow | int > 0 | from model map (R2) |
| pct | number 0–100 | derived: `min(100, tokensUsed / contextWindow × 100)` |
| precision | `"exact"` \| `"estimated"` | `estimated` whenever any input was inferred (FR-013) |
| timestamp | ISO datetime | when measured |

**Unknown state**: absence of a producible reading is modeled as `ReadingUnavailable
{ sessionId, reason, lastGoodReading: UsageReading | null }` — never a fake reading (FR-011).

## ZoneThresholds (configuration)

| Field | Type | Rules |
|---|---|---|
| yellow | number | default 40 |
| orange | number | default 60 |
| red | number | default 75 |

**Validation** (FR-003): `0 < yellow < orange < red ≤ 100`; violation → `ConfigError`
naming key + rule; system continues on defaults. Green is implicit: `[0, yellow)`.

## Zone

Derived, not stored: `green [0,yellow) | yellow [yellow,orange) | orange [orange,red) |
red [red,100]`. Each zone carries static guidance text (constitution's canonical table).
Classification is a pure function `(pct, thresholds) → Zone`.

## ZoneTransition

| Field | Type | Rules |
|---|---|---|
| sessionId | string | FK → SessionRef.id |
| from | Zone name \| `"unknown"` | zone before the update |
| to | Zone name | zone after the update (final zone only on multi-band jumps, FR-005) |
| direction | `"escalation"` \| `"de-escalation"` | derived from zone order |
| reading | UsageReading | the reading that caused it |

## Recommendation

| Field | Type | Rules |
|---|---|---|
| id | string | deterministic: `hash(sessionId, kind, trigger)` |
| kind | `"favor_retrieval"` \| `"compact"` \| `"new_session"` \| `"save_candidate"` | |
| trigger | Trigger (below) | mandatory — no untriggered recommendations (FR-006) |
| guidance | string | human-readable advice incl. the trigger explanation |
| state | `"pending"` \| `"accepted"` \| `"dismissed"` | |

**Trigger** (discriminated union):
`{ kind: "zone_transition", transition: ZoneTransition }` or
`{ kind: "rule_match", ruleId: string, candidateId: string }`.

**State transitions**:

```text
(zone entered / rule matched) → pending
pending → accepted   (user acts on it)
pending → dismissed  (user declines)
dismissed --[session leaves the zone OR escalates to higher zone]--> re-armed (may become pending again)
```

While `dismissed` and the session stays in the same zone: the same `id` MUST NOT be
re-issued (FR-014). Dismissals persist in MonitorState.

`save_candidate` recommendations are per-candidate: one per ArtifactCandidate id, emitted
automatically while the session is in orange/red (FR-015). Accepting one is the explicit
confirmation that persists its candidate as an Artifact (FR-009); accepting or dismissing
one never affects the others, and a candidate already saved or dismissed is never
re-offered. Presentation MAY aggregate pending save suggestions for display; the model
stays per-candidate.

## HeuristicRule

| Field | Type | Rules |
|---|---|---|
| id | string | unique, stable (e.g., `decision.agreed-to`) |
| category | `"decision"` \| `"conclusion"` \| `"constraint"` \| `"result"` \| `"task"` \| `"question"` | |
| description | string | human-readable, shown with every match (FR-006) |
| patterns | string[] (≥1) | case-insensitive phrases / anchored regex sources |

Registry is ordered; scanning is a pure function — same content + same registry ⇒
identical candidate list, byte for byte (FR-012, SC-005).

## ArtifactCandidate

| Field | Type | Rules |
|---|---|---|
| id | string | deterministic: `hash(sessionId, ruleId, span)` — stable across rescans |
| sessionId | string | FK → SessionRef.id |
| ruleId | string | FK → HeuristicRule.id (FR-008) |
| excerpt | string | matched passage, trimmed to sentence bounds |
| span | { startLine: int, endLine: int } | location in session content (FR-008) |
| status | `"surfaced"` \| `"accepted"` \| `"rejected"` | |

**State transitions**: `surfaced → accepted` (then persisted as Artifact) or
`surfaced → rejected` (never written anywhere, FR-009).

## Artifact

Accepted candidate persisted to the workspace.

| Field | Type | Rules |
|---|---|---|
| path | string | `.baton/artifacts/<timestamp>-<ruleId>-<slug>.md` |
| candidateId | string | provenance |
| frontmatter | object | sessionId, ruleId, category, span, savedAt — plain YAML, human-readable |

## HandoffSummary

| Field | Type | Rules |
|---|---|---|
| path | string | `.baton/handoff/<timestamp>-handoff.md` |
| sessionId | string | source session |
| sections | object | decisions[] {text, source}, taskState {summary, sources[]}, openQuestions[] {text, ruleId, span}, artifactRefs[] (paths) |

Written only on explicit request (FR-010); available in any zone.

**Derivation** (FR-010): decisions from saved Artifacts plus decision-category rule
matches; taskState from the most recent user requests — windowed to the last 3 user turns,
a named constant `TASK_STATE_WINDOW`, so the selection is deterministic and auditable —
plus task-category rule matches; openQuestions from question-category rule matches. Every derived item carries its source
(rule id + span, or artifact path). Core exposes a **TaskStateSource** port whose default
implementation is this transcript inference; an SDD-framework adapter (sibling feature)
MAY later supply authoritative task state (e.g., a feature's task list) without core
changes (Principle III).

## MonitorState (persisted, `.baton/state.json`)

| Field | Type | Rules |
|---|---|---|
| sessionId | string | state is per-session; new session id ⇒ fresh state |
| lastZone | Zone name \| `"unknown"` | for transition detection across process restarts |
| dismissals | { recommendationId, zone, dismissedAt }[] | re-arm bookkeeping (FR-014) |
| dismissedCandidates | { candidateId, dismissedAt }[] (optional) | save-candidate anti-re-offer bookkeeping (FR-015) — candidate dismissals survive zone changes; absent in older state files |

**Invariant**: holds tool bookkeeping only — ids, zone names, timestamps. It MUST never
contain session content; this is what keeps the automatic state write inside the
bookkeeping exemption of FR-007/SC-004.

Corrupt/missing state file ⇒ treated as empty state (transitions re-detected, worst case
one duplicate notification — acceptable, never data loss).

## Relationships

```text
SessionRef 1 ──▶ * UsageReading ──▶ Zone (derived)
UsageReading pair ──▶ ZoneTransition ──▶ Recommendation (trigger)
SessionRef 1 ──▶ * ArtifactCandidate (via HeuristicRule match) ──▶ 0..1 Artifact
SessionRef 1 ──▶ * HandoffSummary
SessionRef 1 ──▶ 1 MonitorState
ZoneThresholds (config, single source) ──▶ Zone classification
```
