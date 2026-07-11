# baton — Session Context Monitor

A traffic-light monitor for coding-agent session context. `baton` passively
observes a Claude Code session's transcript data, reports context usage as a
percentage of the model's context window, classifies it into
green/yellow/orange/red zones, notifies on zone transitions with explainable
guidance, surfaces artifact-save candidates via deterministic heuristic rules,
and generates handoff summaries.

`baton` is **advisory only**: it never compacts, summarizes, or otherwise
alters session data. Session transcripts are strictly read-only input. The only
file it ever writes without an explicit user action is its own bookkeeping
state, `.baton/state.json` (ids, zone names, timestamps — never session
content). Everything else (artifacts, handoff summaries) is written only after
you explicitly accept it.

## Requirements

- Node.js ≥ 22 (24 LTS recommended)
- macOS or Linux terminal
- No network access needed — everything runs locally

## Install

```bash
npm install
npm run build     # tsc → dist/
npm test          # vitest: unit + integration + contract suites
npm link          # exposes the `baton` binary on your PATH
```

By default the monitor reads Claude Code session data from `~/.claude`. Point
it somewhere else (e.g. the test fixtures) with:

```bash
export BATON_CLAUDE_DIR=tests/fixtures/claude
```

Transcripts are resolved at `$BATON_CLAUDE_DIR/projects/<encoded workspace path>/`.

## Command reference

All commands live under the `context` group and share three global options:
`--json` (machine-readable output), `--session <id>` (override active-session
resolution), `--workspace <path>` (default: current directory).

| Command | What it does |
|---|---|
| `baton context status` | Current zone and percentage, on demand. One-line statusline: zone glyph, pct, bar, tokens, sparkline, ETA, precision label, data age. `--ascii` renders a plain fallback chip. |
| `baton context watch` | Continuously updating live view. Interactive TTY: full pane with meter, history, forecast, transition banners, pending advisories (`d` dismiss, `enter` act, `q` quit). Non-TTY or `--json`: NDJSON event stream (`reading`, `zone_transition`, `recommendation`, `reading_unavailable`). `--interval <seconds>` tunes the polling fallback (default 5, min 1, max 10). |
| `baton context scan` | Surface artifact-save candidates via the deterministic rule registry. `--category <c>` filters (decision, conclusion, constraint, result, task, question; repeatable). Identical content always yields identical results (the output ends with a `fingerprint`). Read-only — never writes. |
| `baton context save [ids…]` | Persist accepted candidates as Markdown artifacts. With explicit candidate ids, every id is validated before anything is written; without ids in a TTY, an interactive accept/reject review runs. Only accepted candidates are written. |
| `baton context handoff` | Generate a handoff summary (Decisions, Current task state, Saved artifacts, Open questions — every item annotated with its source). Interactive TTY shows the draft for confirm/cancel/`$EDITOR` edit before the single write; `--yes` or `--json` writes directly; `--out <path>` overrides the location. Never auto-generated. |
| `baton context config show` | Effective thresholds and their source (file or defaults). |
| `baton context config validate` | Validate `baton.config.json`; each violation names the key, value, and violated rule. Exit 2 when invalid. |

Exit codes: `0` success (including estimated readings and empty scan results),
`1` unexpected runtime error, `2` invalid invocation, `3` no session / reading
unavailable. An invalid config file is never fatal outside `config validate`:
the violation is named on stderr and defaults stay in effect.

## Zones

Usage percentage is classified with three thresholds (defaults 40/60/75):

| Zone | Range (defaults) | Glyph | Guidance |
|---|---|---|---|
| green | 0% – <40% | `●` | Runway restored — keep prompting freely. |
| yellow | 40% – <60% | `◆` | Favor targeted retrieval over pasting whole documents. |
| orange | 60% – <75% | `▲` | Review artifact candidates, then compact the conversation. |
| red | ≥75% | `■` | Start a fresh session from a handoff summary. |

Zone identity is always readable from the glyph alone (colorblind-safe).
When no reading is producible, the monitor reports an explicit unknown state
(`◌`) — it never fabricates a zone. Readings derived from inferred inputs
(unknown model, missing usage accounting) are visibly labeled `estimated`.

Every notification and recommendation names its trigger: the zone and
threshold(s) crossed, or the heuristic rule that matched. Dismissed advisories
(`d` in watch) stay quiet while the session remains in the same zone and re-arm
at the next boundary; dismissed save suggestions are never re-offered.

## Configuration — `baton.config.json`

Optional, at the workspace root. Thresholds must satisfy
`0 < yellow < orange < red ≤ 100`:

```json
{
  "thresholds": { "yellow": 40, "orange": 60, "red": 75 }
}
```

Missing file → defaults (40/60/75). Invalid file → each violation is named on
stderr and the defaults stay in effect; nothing crashes.

## Files baton writes (and when)

| Path | Written when |
|---|---|
| `.baton/state.json` | Automatically (the only unprompted write): per-session last observed zone + dismissal bookkeeping. Never contains session content. |
| `.baton/artifacts/<timestamp>-<ruleId>-<slug>.md` | Only when you accept a candidate (`save`). Provenance header: session, turn, rule, matched phrase, verbatim excerpt. |
| `.baton/handoff/<timestamp>-handoff.md` | Only when you run `handoff` (and confirm, in a TTY). Plain Markdown with sourced sections and a Resume checklist. |

Session data under `$BATON_CLAUDE_DIR` is never modified — an integration test
(`tests/integration/read-only.test.ts`) checksums every fixture transcript
across a full command sweep to prove it.

## Development

```bash
npm test          # all suites (vitest)
npm run build     # strict TypeScript → dist/
npm run lint      # eslint
npx tsx scripts/fixtures/generate-fixtures.ts      # regenerate fixture transcripts
npx tsx scripts/fixtures/generate-calibration.ts   # regenerate SC-007 calibration corpus
```

Architecture (constitution-enforced): `src/core/` is the framework-agnostic
library (zone math, heuristics, artifacts, handoff, config schemas) and never
imports from `src/adapters/` or `src/cli/`; `src/adapters/claude-code/` is the
only place with agent-specific knowledge; `src/cli/` is a thin
commander + Ink presentation layer. Heuristics and scanning are deterministic —
no clock, no randomness, no network in the scan path.
