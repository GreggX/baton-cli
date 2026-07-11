# CLI Interface Contract: Session Context Monitor

**Feature**: [../spec.md](../spec.md) | **Data model**: [../data-model.md](../data-model.md)

Binary: `baton`, command group `context`. Conventions (constitution Principle V):

- stdout = results (human-readable by default, machine JSON with `--json`)
- stderr = diagnostics, warnings, progress
- `--json` outputs validate against the zod schemas in `src/core/` (shared with the future
  MCP surface); contract tests assert this
- Exit codes: `0` success (including "estimated" readings and empty scan results),
  `1` unexpected runtime error, `2` invalid invocation (bad args), `3` no session /
  reading unavailable. Invalid *config* is NOT fatal: warning on stderr + defaults (FR-003),
  exit code unaffected.

Global options: `--json`, `--session <id>` (override active-session resolution),
`--workspace <path>` (default: cwd).

Environment: `BATON_CLAUDE_DIR` — root of the agent's session data (default `~/.claude`).
The adapter resolves transcripts at `$BATON_CLAUDE_DIR/projects/<encoded workspace path>/`;
contract tests and the quickstart point it at `tests/fixtures/claude` so `--workspace`
resolves synthetic fixture transcripts instead of live sessions.

---

## `baton context status`

Current zone and percentage, on demand (FR-004, US1).

**stdout (human)**: traffic-light glyph, zone, `pct%`, `exact|estimated` label, tokens/window,
last transition if any, data age.

**stdout (`--json`)**:

```json
{
  "state": "ok",
  "reading": {
    "sessionId": "…", "tokensUsed": 90400, "contextWindow": 200000,
    "pct": 45.2, "precision": "exact", "timestamp": "2026-07-02T18:04:11Z"
  },
  "zone": "yellow",
  "guidance": "Favor targeted retrieval over pasting whole documents.",
  "dataAgeSeconds": 8,
  "lastTransition": { "from": "green", "to": "yellow", "direction": "escalation" }
}
```

**Unknown state** (FR-011): `{ "state": "unknown", "reason": "…", "lastGoodReading": …|null,
"dataAgeSeconds": … }`, exit `3`. Never fabricates a zone.

---

## `baton context watch`

Continuously updating live view (FR-004/FR-005, US1–US2). Interactive TTY: Ink UI with
traffic light, percentage, transition banners, pending recommendations (dismiss with `d`,
act with `enter`). Non-TTY or `--json`: NDJSON event stream, one object per line:

```json
{"event":"reading","reading":{…},"zone":"yellow"}
{"event":"reading_unavailable","unavailable":{"sessionId":"…","reason":"…","lastGoodReading":…}}
{"event":"zone_transition","transition":{"from":"yellow","to":"orange","direction":"escalation","reading":{…}},"guidance":"…"}
{"event":"recommendation","recommendation":{"id":"…","kind":"compact","trigger":{…},"guidance":"…","state":"pending"}}
{"event":"recommendation","recommendation":{"id":"…","kind":"save_candidate","trigger":{"kind":"rule_match","ruleId":"decision.agreed-to","candidateId":"c-8f31…"},"guidance":"…","state":"pending"}}
```

Rules: one `zone_transition` per boundary change, final zone only on multi-band jumps
(FR-005); dismissed recommendations not re-emitted while zone unchanged (FR-014); while in
orange/red, an automatic read-only scan runs on zone entry and on refresh, emitting one
`save_candidate` recommendation per new candidate — candidates already saved or dismissed
are never re-emitted, and the TTY view aggregates pending save suggestions (FR-015);
refresh within 10s of session activity (FR-001). `--interval <seconds>` tunes the polling
fallback (default 5, min 1, max 10 — capped so user tuning cannot breach the FR-001
guarantee; out-of-range values exit `2`). Exit `0` on SIGINT.

---

## `baton context scan`

Surface artifact candidates via heuristic rules (FR-008, US3). Always scans the full
transcript content.

Options: `--category <decision|conclusion|constraint|result|task|question>` (repeatable; default all), `--json`.

**stdout (`--json`)**:

```json
{
  "sessionId": "…",
  "fingerprint": "a3f2c9",
  "rulesChecked": ["decision.agreed-to", "conclusion.root-cause", "…"],
  "candidates": [
    {
      "id": "c-8f31…", "ruleId": "decision.agreed-to", "category": "decision",
      "excerpt": "we decided to use the adapter approach…",
      "span": { "startLine": 412, "endLine": 414 }, "status": "surfaced"
    }
  ]
}
```

Empty result is explicit (spec US3-AS3): human output prints "No candidates found" plus the
categories checked; JSON returns `candidates: []` with `rulesChecked` populated. Exit `0`.
Determinism (FR-012): scanning identical content twice yields byte-identical `candidates`.
The output includes a deterministic `fingerprint` — a stable hash of the candidate list —
so identical rescans are checkable at a glance (design 3c).

---

## `baton context save`

Persist accepted candidates as artifacts (FR-009, US3).

Modes: interactive review (TTY, Ink list — accept/reject per candidate) or explicit
`baton context save <candidate-id>…`. `--json` prints written artifacts.

```json
{ "saved": [ { "candidateId": "c-8f31…", "path": ".baton/artifacts/20260702-180500-decision.agreed-to-adapter-approach.md" } ] }
```

Guarantees: only accepted candidates are written; rejected candidates leave no file
(FR-009, SC-004); unknown candidate id → exit `2` with the offending id on stderr; nothing
partially written.

---

## `baton context handoff`

Generate handoff summary (FR-010, US4). Available in any zone; recommended in red.

Options: `--out <path>` (default `.baton/handoff/<timestamp>-handoff.md`), `--json`,
`--yes` (skip the draft review).

Output file: plain Markdown with sections Decisions, Current task state, Saved artifacts
(relative links), Open questions — every derived item annotated with its source (rule id +
transcript location, or artifact path). Interactive TTY: the derived draft is shown for
confirm/cancel (optional $EDITOR edit) before the single write; non-TTY, `--json`, or
`--yes` writes the derived draft directly. `--json`: `{ "path": "…", "sessionId": "…",
"artifactCount": 3 }`. Requires explicit invocation — never auto-generated (FR-007).

---

## `baton context config`

Subcommands: `show` (effective thresholds + source: file/defaults), `validate` (exit `0`
valid, `2` invalid with each violation named: key, value, violated rule — per FR-003).
Both support `--json`:

```json
{ "valid": false, "thresholds": { "yellow": 40, "orange": 60, "red": 75 }, "source": "defaults",
  "errors": [ { "key": "thresholds.orange", "value": 30, "rule": "must be greater than thresholds.yellow (40)" } ] }
```

---

## Contract test obligations (tests/contract/)

1. Every `--json` output above parses and validates against its zod schema.
2. Exit codes match the table for: ok, unknown-state, bad args, unknown candidate id,
   invalid config (`validate` path vs. tolerated-fallback path).
3. stdout/stderr separation: `--json` stdout is pure JSON/NDJSON (parseable end-to-end
   while warnings go to stderr).
4. Multi-band jump produces exactly one `zone_transition` event.
5. Scan determinism: two runs over the same fixture are byte-identical.
6. Driving a fixture into orange during `watch` emits `save_candidate` recommendations
   with `rule_match` triggers for matching content, re-emits none after dismissal or save,
   and writes nothing except the tool state file (FR-015).
