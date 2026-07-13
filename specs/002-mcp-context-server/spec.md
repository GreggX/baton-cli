# Feature Specification: MCP Context Server

**Feature Branch**: `002-mcp-context-server`

**Created**: 2026-07-11

**Status**: Draft

**Input**: User description: "the MCP server exposing the context monitor capabilities to the model"

**Closes obligation**: [specs/mcp-parity-obligation.md](../mcp-parity-obligation.md) —
constitution Principle V parity debt for the six Session Context Monitor capabilities.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - The Agent Reads Its Own Context Health (Priority: P1)

A developer connects the monitor to their coding agent once; from then on, in any session
in that workspace, the agent itself can ask "how full is my context?" and receive the same
truthful answer the traffic light gives the human: zone, percentage, exact-or-estimated,
and the guidance for that zone. The agent uses this to self-regulate — preferring targeted
retrieval in yellow, proposing artifact review in orange, suggesting a handoff in red —
without the developer having to relay what the statusline says.

**Why this priority**: This is the loop-closer of the product vision: the monitor was
built to keep the model at top performance, but until the model can see the gauge, only
the human can act on it. A connected agent that can check its own health is the minimum
version of every other behavior in this feature.

**Independent Test**: Can be fully tested by connecting an MCP-capable agent (or test
client) to the server over fixture session data and confirming the health capability
returns the correct zone/percentage/guidance for green, yellow, and unknown fixtures.

**Acceptance Scenarios**:

1. **Given** a connected agent in a workspace whose session sits at 45% usage, **When**
   the agent requests context health, **Then** it receives yellow, the percentage, the
   exact/estimated label, and the yellow-zone guidance in one compact response.
2. **Given** a workspace with no readable session data, **When** the agent requests
   context health, **Then** it receives an explicit unknown state with the reason and the
   age of the last good reading — never a fabricated zone.
3. **Given** a developer who has never used the server, **When** they follow the setup
   instructions, **Then** the agent's capability list shows the monitor capabilities in a
   single configuration step, with descriptions that tell the agent when to use them.
4. **Given** the same session state, **When** health is read through the agent capability
   and through the CLI, **Then** the two report identical values (zone, percentage,
   precision, guidance).

---

### User Story 2 - The Agent Catches Up on Transitions and Advice (Priority: P2)

Between an agent's checks, the session may have crossed zone boundaries and the monitor
may have issued recommendations. The agent can ask "what changed since I last looked?" and
receive the transitions and currently pending recommendations — each carrying its trigger
(zone and threshold crossed, or matching rule) — so guidance reaches the model even when
no human is watching a live view. Recommendations the user already dismissed are not
re-surfaced.

**Why this priority**: Zone-appropriate guidance only changes model behavior if the model
learns about it at the right moment; catch-up semantics make the advice reach the agent
without requiring a continuously open human view.

**Independent Test**: Replay a fixture session across the 40/60/75 boundaries, have the
agent check twice, and confirm the second check reports exactly the transitions that
occurred between the checks plus pending (non-dismissed) recommendations, each naming its
trigger.

**Acceptance Scenarios**:

1. **Given** an agent that last checked in green, **When** the session jumps to 68% and
   the agent checks again, **Then** it receives one transition to orange (multi-band jump
   collapsed) and the pending compact recommendation with its trigger.
2. **Given** a recommendation the user dismissed, **When** the agent catches up, **Then**
   that recommendation is not included while the session remains in the same zone.
3. **Given** no changes since the last check, **When** the agent catches up, **Then** it
   receives an explicit empty result, cheap enough to poll routinely.

---

### User Story 3 - The Agent Proposes Saves, the User Decides (Priority: P2)

In orange or red, the agent can run the deterministic artifact scan and see the same
candidates the human would: excerpt, location, and the named rule that flagged each one.
When the agent believes a candidate is worth keeping, it requests the save; the write
happens only after the user explicitly approves the action. Rejected or unapproved
requests write nothing.

**Why this priority**: This turns the model from a consumer of advice into an active
curator of its own context — the heart of "help decide what is worth keeping" — while
keeping the user as the only authority over what lands in their workspace.

**Independent Test**: Against a fixture with known matching phrases, have the agent scan
(verify candidates and fingerprint identical to the CLI's), request a save of specific
candidates, approve one and deny another, and confirm exactly the approved artifact
exists on disk.

**Acceptance Scenarios**:

1. **Given** an agent in an orange-zone session with rule-matching content, **When** it
   runs the scan capability, **Then** it receives the same candidate list and fingerprint
   the CLI reports for that content.
2. **Given** an agent requesting to save two candidates, **When** the user approves the
   request, **Then** exactly those two artifacts are written with full provenance, and
   the agent receives the written paths.
3. **Given** an agent requesting a save, **When** the user denies the request, **Then**
   nothing is written and the agent is told the request was declined.
4. **Given** an environment where no user approval step is available, **When** the agent
   requests a save, **Then** the capability declines with instructions for performing the
   save through the CLI — it never writes unapproved.

---

### User Story 4 - The Agent Prepares Its Own Handoff (Priority: P3)

When the session reaches red, the agent — advised by the guidance it can now see — can
request a handoff summary. With the user's approval, the same plain, source-annotated
handoff file the CLI produces is written, and the agent can tell the user "your handoff
is ready; start a fresh session from it."

**Why this priority**: Completes the self-regulation loop end-to-end, but depends on
health, catch-up, and the approval pattern existing first; the CLI already covers this
need manually.

**Independent Test**: Bring a fixture session into red, have the agent request a handoff
with approval, and confirm the produced file matches the CLI's handoff for the same
session (sections, sources, artifact references).

**Acceptance Scenarios**:

1. **Given** an agent in a red-zone session, **When** it requests a handoff and the user
   approves, **Then** the handoff file is written to the workspace and its path is
   returned to the agent.
2. **Given** the same session state, **When** a handoff is generated via the agent and
   via the CLI, **Then** the files carry the same sections, task state, decisions, and
   artifact references.

---

### Edge Cases

- No session exists in the workspace (fresh project, agent's own transcript not yet on
  disk): health returns the explicit unknown state with reason; nothing errors.
- The monitored session is the very session making the request: reads are safe on a
  transcript that is mid-write; partially written entries are tolerated and never crash a
  reading.
- Two agent sessions are active in the same workspace: attribution follows the same
  most-recent-activity rule as the CLI (documented limitation); values are never blended
  across sessions.
- The agent polls health rapidly: responses stay cheap and correct; repeated identical
  checks return identical values (no side effects from reading).
- The user runs CLI commands while the server is connected: both surfaces observe the
  same state without corrupting it; a dismissal in one surface is honored by the other.
- The server is started outside any workspace or against an unreadable data root: it
  reports a clear configuration error rather than serving fabricated data.
- The agent requests a persisting action mid-way through the user being away: the request
  waits for or fails to approval; absence of approval NEVER becomes an implicit yes.
- The agent host reconnects (e.g., after a restart): catch-up positions are scoped to a
  connection, so the first check on a new connection returns the current snapshot rather
  than the delta since the old connection's last check — by design; nothing is lost
  except delta granularity.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST provide a server the developer can connect to an
  MCP-capable agent host with a single configuration step, scoped to one workspace: all
  capabilities operate on the session data of the workspace the server was started for.
- **FR-002**: The server MUST expose all six monitor capabilities enumerated in the
  parity obligation ([mcp-parity-obligation.md](../mcp-parity-obligation.md)): context
  health (status), transition/recommendation catch-up (watch's advisory surface), artifact
  scan, artifact save, handoff generation, and configuration inspection. Closing this
  feature MUST flip the obligation's status to SATISFIED.
- **FR-003**: For identical session state, every value the server reports (zone,
  percentage, precision, guidance, candidates, fingerprint, handoff content, thresholds)
  MUST be identical in meaning to what the CLI reports — one behavior, two surfaces.
- **FR-004**: Responses returned to the agent MUST be compact, targeted slices: no
  capability may return session transcripts or other bulk content, and routine responses
  (health, catch-up) MUST stay within a small fixed size budget (SC-003) so checking is
  always cheap for the model.
- **FR-005**: Read capabilities (health, catch-up, scan, configuration) MUST be free of
  side effects on session data and workspace content, require no approval, and remain
  safe under repeated calls. Tool-internal bookkeeping follows the same exemption as
  feature 001's FR-007.
- **FR-006**: Persisting capabilities (artifact save, handoff generation) MUST NOT write
  anything without an explicit user approval of that specific request. Where the host
  environment provides no user approval step, the capability MUST decline and point to
  the CLI equivalent. Absence of approval is always a no.
- **FR-007**: Every recommendation, transition, and candidate delivered to the agent MUST
  carry its trigger (zone and threshold crossed, or rule identifier) — explainability
  travels across surfaces unchanged.
- **FR-008**: When usage cannot be determined, the server MUST report the explicit
  unknown/stale state with reason and age of the last good reading; it MUST never deliver
  a zone it cannot substantiate to the agent.
- **FR-009**: Catch-up MUST report the transitions that occurred since the requesting
  agent's previous check and the currently pending recommendations, honoring dismissals
  (a user-dismissed recommendation is not re-delivered while the session stays in that
  zone) and multi-band collapse (one transition per jump).
- **FR-010**: Each exposed capability MUST carry a description that tells the agent when
  to use it (e.g., check health before large pastes; scan when orange), since the
  descriptions are the agent's only standing instructions for self-regulation.
- **FR-011**: Invalid requests MUST produce a structured error naming the problem;
  invalid workspace configuration MUST surface the same named threshold violations as the
  CLI, with defaults in effect.
- **FR-012**: The server MUST operate entirely locally: no session data, readings, or
  derived content may leave the machine; the only communication is with the locally
  connected agent host.
- **FR-013**: Concurrent use of the CLI and the server against the same workspace MUST
  be safe: shared bookkeeping state is never corrupted, and an action taken on one
  surface (e.g., a dismissal or a save) is reflected by the other.
- **FR-014**: Every persisting operation the server executes MUST append a local audit
  entry — timestamp, capability, what was written (candidate ids or file path), and the
  gate state that admitted it — to the tool's own bookkeeping area in the workspace,
  readable as plain text. Audit entries MUST contain no session content and never leave
  the machine. Declined requests and read capabilities MUST NOT produce audit entries,
  so their no-write guarantees remain byte-exact.

### Key Entities

- **Capability**: One of the six exposed monitor functions, with a name, an
  agent-facing description (when to use it), read-only vs persisting classification, and
  a response shape shared with the CLI.
- **Catch-up Report**: The answer to "what changed?": transitions since the agent's
  previous check plus currently pending recommendations, each with trigger; explicitly
  empty when nothing changed.
- **Check Cursor**: The marker of an agent's last catch-up, from which the next delta is
  computed.
- **Approval**: The user's explicit yes/no to one specific persisting request (which
  candidates, which handoff); scoped to that request only, never standing.
- **Connection**: One agent host attached to one workspace-scoped server instance;
  defines the session-attribution boundary.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A connected agent can obtain current zone, percentage, and guidance in
  under 2 seconds from asking, in 100% of checks against available session data.
- **SC-002**: Zero writes occur while the write gate is closed, and zero writes occur
  from denied or unanswered requests; with the gate open, every write corresponds to a
  host-mediated per-request tool approval and leaves exactly one local audit entry
  (FR-014) — verifiable by diffing the workspace and the audit log around the gating
  matrix.
- **SC-003**: Routine responses (health, empty catch-up) fit within 200 tokens of
  agent-visible content in 100% of cases; no capability response ever includes bulk
  session content.
- **SC-004**: For identical session state, agent-surface and CLI-surface values match in
  100% of sampled comparisons (zone, percentage, candidates, fingerprint, handoff
  sections).
- **SC-005**: A developer can go from "server never configured" to "agent lists the
  monitor capabilities" in under 5 minutes using only the setup documentation.
- **SC-006**: In moderated trials, agents connected to the server propose a
  context-preserving action (retrieval preference, artifact save, or handoff) before the
  user asks for one in at least half of sessions that reach orange or red.
- **SC-007**: The parity obligation's acceptance checklist is fully satisfied and its
  status flipped to SATISFIED at feature close.

## Assumptions

- The agent host's per-request tool approval prompt (standard in MCP-capable coding
  agents) constitutes the explicit user confirmation required by constitution
  Principle II for persisting actions; hosts running without such prompts get the
  declining behavior of FR-006. The approval requirement is about the user consenting to
  the specific write, not about which UI renders the prompt.
- Delivery to the agent is pull-based: the agent asks (health, catch-up) rather than
  being pushed live events; the CLI's live watch view remains the human's real-time
  surface. Push delivery may be added later without changing these requirements.
- Session attribution uses feature 001's active-session rule (most recent activity in the
  workspace), including its documented multi-session limitation.
- The server reuses the monitor's single behavior source; this spec introduces no new
  monitoring semantics — zones, thresholds, rules, dismissal and re-arm behavior are all
  as specified in feature 001.
- Spec foregrounding (keeping the active SDD spec/tasks in front of the model) is
  deliberately OUT of scope: it is the next feature, which will build on this server.
- One server instance serves one workspace; multiple workspaces mean multiple instances
  (matching how agent hosts launch project-scoped servers).
