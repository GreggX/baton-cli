# Quickstart: MCP Context Server

**Feature**: [spec.md](./spec.md) | **Contracts**: [contracts/mcp-tools.md](./contracts/mcp-tools.md)

Validation/run guide — proves the feature end-to-end. Implementation details live in
plan.md and tasks.md.

## Prerequisites

- Feature 001 built and linked (`npm run build && npm link` → `baton` on PATH)
- An MCP-capable agent host (Claude Code) for the live scenarios; fixture scenarios need
  no live agent
- `export BATON_CLAUDE_DIR=tests/fixtures/claude` for fixture-driven scenarios

## Setup (SC-005 — time this; target < 5 minutes)

```bash
npm run build && npm link
# connect to Claude Code, project scope (the single configuration step):
claude mcp add baton -- baton mcp
# or with writes enabled once you've confirmed your host prompts per tool call:
claude mcp add baton -- baton mcp --allow-writes
```

## Validation scenarios

### 1. Six tools, canonical descriptions (US1-AS3, FR-002/FR-010)

```bash
claude mcp list   # expect: baton connected
# in a session: ask the agent to list its baton tools
# expect: context_status, context_catchup, context_scan, context_save,
#         context_handoff, context_config — descriptions matching the contract verbatim
```

### 2. Health parity with the CLI (US1-AS1/AS4, FR-003)

```bash
baton context status --workspace tests/fixtures/ws-yellow --json > cli.json
# ask the connected agent (server started with --workspace tests/fixtures/ws-yellow)
# to call context_status
# expect: zone yellow, same pct/precision/guidance as cli.json — identical values
```

### 3. Honest unknown (US1-AS2, FR-008)

```bash
# server on tests/fixtures/ws-empty → context_status
# expect: state "unknown" with reason and last-good age — never a fabricated zone
```

### 4. Catch-up across a replayed jump (US2, FR-009)

```bash
# agent calls context_catchup (first call → snapshot, empty transitions)
scripts/fixtures/append-turns.sh tests/fixtures/ws-growing   # 35% → 68%
# agent calls context_catchup again
# expect: exactly ONE transition to orange (multi-band collapsed) + the pending compact
#         recommendation with trigger; a third call → { "empty": true }
```

### 5. Scan parity and fingerprint (US3-AS1, SC-004)

```bash
baton context scan --workspace tests/fixtures/ws-decisions --json | jq .fingerprint
# agent calls context_scan on the same workspace
# expect: same candidates, same fingerprint
```

### 6. Write gating — the Principle II matrix (US3-AS2..4, FR-006, SC-002)

```bash
# server WITHOUT --allow-writes: agent calls context_save
# expect: {"declined":true,"reason":"writes-disabled",…} and no file appears
# server WITH --allow-writes: agent calls context_save for one candidate id
# expect: the host prompts for approval; on approve → exactly that artifact written and
#         one entry appended to .baton/audit.log (timestamp, tool, ids, gate state);
#         on deny → nothing written anywhere, agent told the request was declined
```

### 7. Handoff parity (US4, SC-004)

```bash
baton context handoff --workspace tests/fixtures/ws-red --json --yes
# agent (writes enabled) calls context_handoff on the same fixture state
# expect: file with identical sections/task state/sources; path returned to the agent
```

### 8. Budget check (SC-003, FR-004)

```bash
# capture a context_status response and an empty context_catchup response
# expect: each ≤ ~800 characters (200 tokens by chars/4); no transcript content anywhere
```

### 9. Self-regulation trial (SC-006 — moderated, qualitative)

Work a real session into orange with the server connected: expect the agent, unprompted,
to check status and propose retrieval preference / a scan / a handoff before you ask.
This is a post-close validation activity — deliberately outside T027's automated sweep
(scenarios 1–8); capture observations during real usage to evidence SC-006.

## Expected outcome

Scenarios 1–8 pass ⇒ FR-001–FR-013 demonstrated and the parity obligation's checklist is
closeable; `npm test` covers scenarios 1, 2, 4, 5, 6, 8 automatically via the in-memory
client (tests/contract/mcp-*.test.ts). Scenario 9 evidences SC-006 over real usage.
