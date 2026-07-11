# Design Notes: Context Monitor UI

**Source**: Claude Design project "CLI Context health monitor"
(`https://claude.ai/design/p/9ab08ade-bfd1-429d-a7a1-b84c16dcd827`, file
`Context Monitor Options.dc.html`, vendored alongside these notes). The mockups use the
working name `ctxmon`; everything ships as `baton context …`. These notes distill the
design into an implementable UI spec — where the design and the feature spec overlap, the
spec's FRs govern; the design governs look, copy, and layout.

## Design tokens (Tokyo Night, JetBrains Mono context)

| Token | Value |
|---|---|
| zone green | `#9ece6a`, glyph `●` |
| zone yellow | `#e0af68`, glyph `◆` |
| zone orange | `#ff9e64`, glyph `▲` |
| zone red | `#f7768e`, glyph `■` |
| unknown/stale | `#565f89`, glyph `◌`, dashed borders |
| text / muted / faint | `#c0caf5` / `#565f89` / `#3b4261` |
| accent blue / purple / teal / cyan | `#7aa2f7` / `#bb9af7` / `#73daca` / `#2ac3de` |

**Shape is the primary channel** (colorblind-safe): zone is always readable from the glyph
alone. Map to terminal ANSI: green/yellow/red = standard; orange = bright yellow/208;
grays = dim. Truecolor terminals get the hex values.

## Canonical strings & formulas

- **Usage bar**: 22 cells inside `▕…▏`; fill `█` with eighth-block partial
  (`▏▎▍▌▋▊▉█`); remainder `·` (U+00B7). Example: `▕██████████▍···········▏`
- **Sparkline** (statusline): last 12 samples, ramp `▁▂▃▄▅▆▇█`
- **ASCII fallback** (`--ascii` / non-UTF terminals): `ctx [##########......] 47% Y`
  (16 cells `#`/`.`, pct, zone initial; unknown = `(ctx -- ?)`)
- **Tokens**: `94.2k/200k` (one decimal on used, integer window)
- **Burn**: `+1.2%/turn avg` (slope over recent readings)
- **ETA**: `~11 turns→red` · `burn stable` · `handoff now` (when in red)
- **Forecast**: `red in ~4 turns (≈7 min at current burn)` ·
  `usage stable — keep prompting freely` · `RED — capture a handoff summary now`
- **Zone guidance copy** (the FR-005/T013 guidance table):
  - yellow: `Favor targeted retrieval over pasting whole documents.`
  - orange: `Review artifact candidates, then compact the conversation.`
  - red: `Start a fresh session from a handoff summary.`
  - green (recovery/de-escalation): `Runway restored — keep prompting freely.`
- **Transition banner**: title `▲ ENTERED ORANGE` / `● BACK IN GREEN`; subtitle
  `crossed 40% & 60% · now 68%` (multi-band collapse names every threshold crossed) or
  `compaction 78% → 30%` on drops; footer
  `advisory — nothing runs by itself · d dismiss · re-arms at the next boundary`
- **Event log** (in watch, newest first, keep 4): `◆ YELLOW @ 43% · crossed 40%`

## Chosen treatments → implementation

| Story | Design | What ships |
|---|---|---|
| US1 `status` | 1a statusline row | one-line: glyph, pct (bold), ZONE, bar, tokens, sparkline, ETA, data age; `--ascii` fallback |
| US1 `watch` (TTY) | 1c watch pane | left: big pct + zone pill, meter with threshold ticks at yellow/orange/red + zone legend, TOKENS, BURN; right: HISTORY columns with threshold guide lines, FORECAST box; footer keys `q` quit · `z` zones · `a` candidates · `h` handoff (+ `d` dismiss) |
| US1 unknown/stale | 5a + 1b/1e | three data states: LIVE (`updated 2s ago`), STALE (dashed border, `⚠ STALE · last good 31s ago →` + demoted last-good reading at 45% opacity + `retrying source…`), UNKNOWN (`◌ --% UNKNOWN`, empty bar, `session ended · last good reading 6m ago`). Never render a zone as live without data (FR-011) |
| US2 transitions | 2a arc + 2b toast | banner appears in watch on each boundary crossing, auto-quiets ~6s, logged to the in-pane event log; dismissed zone stays quiet (`— still orange, no repeat`); recovery is a quiet stamp `● BACK IN GREEN · compaction 78% → 30% · notices re-armed`, not an alert |
| US2 audit | 2b footer log | in-watch `FIRED — NEWEST FIRST · ONE PER CROSSING` list; every entry names zone + threshold (FR-006) |
| US3 `scan` | 3b + 3c | table: # / RULE (colored pill per category + `matched "we decided"`) / EXCERPT·SOURCE (match bolded, `turn 12 · assistant`) / decision; explicit empty state `○ No artifact candidates found.` naming the rules checked; output ends with `fingerprint a3f2c9` |
| US3 `save` review | 3a | one candidate at a time: progress dots (`✓ ✕ ◉ ○`), rule pill, excerpt with underlined match, `on accept → <path>`; keys `[y] accept · [n] reject · [u] undo`; completion box `⏺ REVIEW COMPLETE — 2 accepted · 3 rejected` + written paths; `no files written — nothing was accepted` when all rejected |
| US3 artifact files | 3d | provenance header: `# <Category> — <slug title>` + `- session · turn · timestamp`, `- rule: <id> (matched "…")`, `- saved: accepted by user before compaction`, then the verbatim excerpt as a `>` quote |
| US4 `handoff` | 4a/4b/4d | progress lines while assembling (collecting → task state → decisions/artifacts → verify artifacts on disk `3/3 present` → `+ <path>`); green completion box `⏺ HANDOFF READY`; file sections: header meta (written-at, zone, tokens, turns, `reading this + linked artifacts ≈ 2k tokens`), `## Task state` (`✓ done` / `◐ in progress` / `○ open`), `## Key decisions` (numbered; artifact link or `— captured here (no artifact saved)`), `## Saved artifacts (n/n verified on disk)`, `## Resume` (3 steps); in green add note `○ note: you're in green — a handoff isn't needed yet. Writing it anyway…` |
| Edge: config | 5b | rejection box `✗ invalid thresholds — configuration rejected` with numbered problems (`orange (60) is below yellow (65) — boundaries out of order`) + `nothing changed — defaults in effect: 40 / 60 / 75` |
| Edge: no-nag | 5c | `RED — advisory only` posture: one notice per zone entry; statusline keeps updating (`notice shown once · 5 turns since · repeats 0`) |
| Edge: sessions | 5d | monitor binds to one session at attach; other sessions unmonitored (per spec Assumptions) |

Per FR-010, handoff derived items also carry `[source: …]` annotations (rule id + turn, or
artifact path) — the design's 4b layout plus our provenance requirement.

## Deferred (explicitly out of this implementation)

- **1b turn stamps / 1d prompt chip** — host-shell integrations; the `watch --json` NDJSON
  stream is the seam (research R11). The `(ctx 45 Y)` ASCII chip format is reserved.
- **1e standalone `status --forecast` view** — burn/ETA/forecast ship inside 1a/1c;
  a dedicated projection view is future scope.
- **2d persistent transition ledger** (`log --transitions`) — needs a spec change
  (transition persistence); the in-watch event log covers the audit need for v1.
- **5b `config set` writer** — contract is `config show|validate`; users edit
  `baton.config.json` directly for now.
- **1d Okabe-Ito palette variant** — shape encoding already carries zone identity;
  a palette config option is future scope.

## Contract deltas introduced by the design

- `scan` output gains a deterministic `fingerprint` (stable hash of the candidate list) —
  recorded in contracts/cli-interface.md and T043 (design 3c).
