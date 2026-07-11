# Quickstart: Session Context Monitor

**Feature**: [spec.md](./spec.md) | **Contracts**: [contracts/cli-interface.md](./contracts/cli-interface.md)

Validation/run guide — proves the feature works end-to-end. Implementation details live in
plan.md and tasks.md.

## Prerequisites

- Node.js ≥ 22 (24 LTS recommended), npm (or pnpm)
- macOS or Linux terminal
- No network needed; everything runs locally

## Setup

```bash
npm install
npm run build          # tsc → dist/
npm test               # vitest: unit + integration + contract suites
npm link               # exposes the `baton` binary locally (optional)
export BATON_CLAUDE_DIR=tests/fixtures/claude   # point the adapter at fixture transcripts
```

Fixtures in `tests/fixtures/` are synthetic Claude Code transcripts laid out under the
fixture session root `tests/fixtures/claude/projects/<encoded-ws>/`; with `BATON_CLAUDE_DIR`
exported, the scenarios below run against them via `--workspace`/`--session` — no live
agent session is required.

## Validation scenarios

Each scenario maps to spec acceptance criteria (US = user story, AS = acceptance scenario).

### 1. Zone reading on demand (US1-AS1/AS2)

```bash
baton context status --workspace tests/fixtures/ws-green --json
# expect: "zone": "green", pct ≈ 25, "precision": "exact", exit 0
baton context status --workspace tests/fixtures/ws-yellow --json
# expect: "zone": "yellow", pct ≈ 45
```

### 2. Unknown state, never fake green (US1-AS4, FR-011)

```bash
baton context status --workspace tests/fixtures/ws-empty --json; echo "exit=$?"
# expect: "state": "unknown" with reason, no zone fabricated, exit=3
```

### 3. Live transitions, single event per boundary (US2-AS1..4, FR-005)

```bash
baton context watch --workspace tests/fixtures/ws-growing --json > events.ndjson &
scripts/fixtures/append-turns.sh tests/fixtures/ws-growing   # replays turns 35%→68%
kill %1
grep '"event":"zone_transition"' events.ndjson
# expect: one attach transition (unknown→green), then exactly ONE escalation with
#         "to":"orange" — the skip-level jump collapses, no yellow event
```

### 4. Dismissal anti-nag and re-arm (US2-AS5, FR-014)

In an interactive `watch` on `ws-orange`: dismiss the compact recommendation (`d`), confirm
it does not reappear while usage stays in orange; replay turns crossing 75% and confirm the
red-zone recommendation appears. State persists in `.baton/state.json`.

### 5. Candidate scan: explainability + determinism (US3-AS1/AS3/AS4, FR-008/FR-012)

```bash
baton context scan --workspace tests/fixtures/ws-decisions --json > scan1.json
baton context scan --workspace tests/fixtures/ws-decisions --json > scan2.json
diff scan1.json scan2.json && echo "deterministic ✓"
# expect: candidate for "we decided to use the adapter approach" labeled ruleId decision.*,
#         with span; diff is empty
baton context scan --workspace tests/fixtures/ws-no-matches
# expect: explicit "No candidates found", categories listed, exit 0
```

### 6. Save only what the user accepted (US3-AS2, FR-009, SC-004)

```bash
baton context save c-<id1> c-<id2> --workspace tests/fixtures/ws-decisions --json
ls tests/fixtures/ws-decisions/.baton/artifacts/
# expect: exactly two Markdown files with provenance frontmatter; nothing else written
```

### 7. Handoff summary (US4-AS1/AS3, FR-010)

```bash
baton context handoff --workspace tests/fixtures/ws-red --json
# expect: .baton/handoff/<ts>-handoff.md with Decisions / Task state / Open questions /
#         Artifacts sections, each derived item naming its source (rule + turn, or artifact
#         path); works from any zone (also run on ws-green)
```

### 8. Config validation with named errors (FR-003)

```bash
baton context config validate --workspace tests/fixtures/ws-bad-config --json; echo "exit=$?"
# expect: valid=false, error names key `thresholds.orange` and the violated ordering rule, exit=2
baton context status --workspace tests/fixtures/ws-bad-config
# expect: warning on stderr, reading computed with DEFAULT thresholds, exit 0
```

### 9. Read-only guarantee (FR-007)

```bash
shasum tests/fixtures/claude/projects/*/*.jsonl > before.sum
# run scenarios 1–8 and 10, then:
shasum -c before.sum
# expect: all OK — session data never modified
# (regenerate fixtures first for a clean baseline: append-turns.sh is fixture tooling that
#  rewrites transcripts by design; tests/integration/read-only.test.ts proves the
#  baton-only guarantee automatically)
```

### 10. Proactive save suggestions in orange (US3-AS5, FR-015)

```bash
baton context watch --workspace tests/fixtures/ws-decisions --json > events.ndjson &
scripts/fixtures/append-turns.sh tests/fixtures/ws-decisions   # replays turns into orange
kill %1
grep '"kind":"save_candidate"' events.ndjson
# expect: one recommendation per matching passage, each with a rule_match trigger (ruleId,
#         candidateId); nothing new written under .baton/ except state.json
```

## Expected outcome

All ten scenarios pass ⇒ US1–US4 acceptance criteria and the constitution gates (advisory-
only, explainable, deterministic, single-config thresholds) are demonstrated end-to-end.
`npm test` covers the same assertions automatically in `tests/contract/` and
`tests/integration/`.
