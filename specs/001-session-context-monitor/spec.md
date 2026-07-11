# Feature Specification: Session Context Monitor

**Feature Branch**: `001-session-context-monitor`

**Created**: 2026-07-02

**Status**: In implementation (UI per `design/design-notes.md`)

**Input**: User description: "the session context monitor feature"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Always-Visible Context Health Signal (Priority: P1)

A developer working through a long spec-driven development session with their coding agent
wants to know, at a glance, how full the model's context is. The monitor shows a
traffic-light indicator — green, yellow, orange, or red — together with the current usage
percentage, so the developer always knows whether they can keep prompting freely or need to
change how they work.

**Why this priority**: Every other behavior of this feature (guidance, artifact
candidates, handoff summaries) depends on knowing the current zone. A visible, trustworthy
usage signal is the minimum viable product on its own — even with nothing else built, it
lets users self-manage their sessions.

**Independent Test**: Can be fully tested by running a session whose context usage is known
and confirming the monitor reports the correct percentage and zone, both on demand and in a
continuously updating view.

**Acceptance Scenarios**:

1. **Given** an active session at 25% context usage, **When** the user checks the monitor,
   **Then** it shows the green zone with the current percentage.
2. **Given** an active session at 45% usage, **When** the user checks the monitor, **Then**
   it shows the yellow zone with the current percentage.
3. **Given** a session whose usage grows from 38% to 42% while the live view is open,
   **When** the threshold is crossed, **Then** the displayed zone changes from green to
   yellow without the user having to re-ask.
4. **Given** usage data that cannot be determined, **When** the user checks the monitor,
   **Then** it shows an explicit "unknown" state — never a default green.

---

### User Story 2 - Zone-Appropriate Guidance on Transitions (Priority: P2)

When the session crosses a zone boundary, the developer is notified of the new zone and
receives guidance appropriate to it: in yellow, favor targeted retrieval over pasting large
documents; in orange, consider compacting the conversation; in red, consider starting a new
session. Every notification names the zone and threshold that triggered it, and all guidance
is advisory — the tool never takes any of these actions itself.

**Why this priority**: The zones only create value when they change user behavior at the
right moment. Unprompted, well-timed, explainable guidance is what turns a passive gauge
into a coach.

**Independent Test**: Can be tested by driving a session's usage across each boundary
(40%, 60%, 75%) and confirming exactly one notification per transition, carrying the
correct zone, percentage, and guidance text.

**Acceptance Scenarios**:

1. **Given** a session in green, **When** usage crosses 40%, **Then** the user is notified
   they are now in yellow with guidance to favor retrieval over dumping large content.
2. **Given** a session in yellow, **When** usage crosses 60%, **Then** the user is notified
   they are now in orange with a recommendation to review artifact candidates and compact.
3. **Given** a session in orange, **When** usage crosses 75%, **Then** the user is notified
   they are now in red with a recommendation to start a fresh session from a handoff
   summary.
4. **Given** a large paste moves usage from 35% to 68% in one step, **When** the monitor
   updates, **Then** the user receives a single notification for the final zone (orange),
   not a burst of intermediate warnings.
5. **Given** the user dismisses an orange-zone recommendation, **When** usage stays inside
   orange, **Then** the same recommendation is not repeated; **When** usage later enters
   red, **Then** the red-zone recommendation is issued.
6. **Given** the user compacts their conversation and usage drops from 68% to 30%,
   **When** the monitor updates, **Then** the zone returns to green and the change is
   visible to the user.

---

### User Story 3 - Artifact Candidate Identification Before Compaction (Priority: P2)

When the session is in the orange zone (or beyond), the developer can ask the monitor to
scan the session content for information worth preserving before a compaction: decisions
made, conclusions reached, constraints discovered, produced results. Each candidate is
shown with the excerpt, where in the session it came from, and the named rule that flagged
it (for example, a decision-language rule matching phrases like "we decided" or "agreed
to"). The developer accepts or rejects each candidate individually; accepted ones are saved
as plain, readable files in the workspace. During a live monitoring view the developer does
not even have to ask: entering the orange or red zone triggers the scan automatically (a
read-only operation), and each matching passage is offered as an individually dismissible
save suggestion.

**Why this priority**: This is the heart of the feature's promise — helping the user make
good decisions about *which* data to save so the model keeps performing after a compaction.
It ranks with guidance (P2) but depends on the zones (P1) existing first.

**Independent Test**: Can be tested by feeding a prepared session transcript containing
known decision/outcome phrases, confirming the expected candidates are surfaced with the
correct rule names, and confirming only accepted candidates are written to the workspace.

**Acceptance Scenarios**:

1. **Given** a session in orange containing the phrase "we decided to use the adapter
   approach", **When** the user requests artifact candidates, **Then** that passage is
   surfaced as a candidate labeled with the rule that matched it.
2. **Given** a list of surfaced candidates, **When** the user accepts two and rejects the
   rest, **Then** exactly the two accepted candidates are saved as plain readable files in
   the workspace, and nothing else is written.
3. **Given** a session with no content matching any rule, **When** the user requests
   candidates, **Then** the monitor explicitly reports that no candidates were found rather
   than staying silent.
4. **Given** the same session content scanned twice, **When** results are compared,
   **Then** the candidate lists are identical (deterministic behavior).
5. **Given** a live monitoring view on a session whose usage crosses into orange and whose
   content matches heuristic rules, **When** the zone transition occurs, **Then** each
   matching passage is proactively offered as a save-candidate suggestion naming its rule,
   and no file is written unless the user accepts a suggestion.

---

### User Story 4 - Handoff Summary for a Fresh Session (Priority: P3)

When the session reaches the red zone (75%+), the developer is advised to start a new
session. On request, the monitor generates a handoff summary — a plain file capturing the
session's key decisions, the current task state, open questions still in the air, and
pointers to the artifacts saved along the way — so the next session starts informed
without inheriting the bloated context.

**Why this priority**: Valuable closer of the loop, but it depends on zones, guidance, and
artifacts existing first, and users can write a manual summary in the meantime.

**Independent Test**: Can be tested by bringing a session with saved artifacts into red,
requesting a handoff summary, and confirming a readable file is produced that references
the session's decisions, open tasks, and saved artifacts.

**Acceptance Scenarios**:

1. **Given** a session in red with three saved artifacts, **When** the user requests a
   handoff summary, **Then** a plain readable file is created in the workspace referencing
   the current task state and all three artifacts.
2. **Given** a handoff summary exists, **When** the user starts a new session using it,
   **Then** they can resume work without re-explaining prior decisions (see SC-006).
3. **Given** a session in green, **When** the user requests a handoff summary anyway,
   **Then** the monitor produces it — the recommendation is zone-driven, but the capability
   is always available.
4. **Given** a generated handoff summary, **When** the user reads it, **Then** every
   derived statement (task state, open question, decision) names its source — the rule and
   session location that produced it, or the artifact it references.

---

### Edge Cases

- Usage data is unavailable or stale (agent session ended, data source unreadable): the
  monitor shows an explicit "unknown"/"stale" state with the age of the last good reading;
  it never presents a zone it cannot substantiate.
- Usage jumps across multiple zones in a single update (large paste or bulk operation):
  one notification for the final zone only.
- Usage decreases (user compacted or trimmed): zone downgrades are shown like upgrades;
  previously dismissed recommendations re-arm so they can fire again on the next escalation.
- User-configured thresholds are invalid (overlapping, out of order, outside 0–100): the
  configuration is rejected with a message naming the problem, and the defaults are used.
- Session content is too small or contains nothing matching any heuristic rule: candidate
  scan reports "no candidates found" with the list of rule categories that were checked.
- The user ignores every recommendation: the monitor keeps reflecting reality (zone and
  percentage) but does not nag — one recommendation per zone entry.
- Two sessions are active on the same machine: the monitor tracks the one session it was
  attached to; monitoring several sessions at once is out of scope for this feature (see
  Assumptions).

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST determine the active session's context usage as a percentage
  of the model's total context capacity, and refresh that reading within 10 seconds of new
  session activity.
- **FR-002**: The system MUST classify usage into four zones with these default boundaries:
  green 0% to <40%, yellow 40% to <60%, orange 60% to <75%, red 75% and above.
- **FR-003**: Zone thresholds MUST be defined in exactly one user-editable configuration;
  the defaults above apply when no configuration exists. Invalid threshold configurations
  MUST be rejected with a message naming the specific problem, falling back to defaults.
- **FR-004**: Users MUST be able to see the current zone and exact percentage both
  on demand (single query) and in a continuously updating live view.
- **FR-005**: The system MUST notify the user each time the session enters a different
  zone, stating the new zone, the current percentage, and the guidance for that zone. When
  one update crosses several boundaries, only the final zone's notification is issued.
  Delivery is scoped to an active monitoring surface: a live view delivers the
  notification immediately, and any later on-demand query reports the most recent
  transition.
- **FR-006**: Every recommendation the system makes MUST name its trigger: the zone and
  threshold crossed, or the heuristic rule that matched. No recommendation may appear
  without a stated reason.
- **FR-007**: The system MUST NOT compact, summarize, delete, or otherwise alter session
  data on its own. All such actions are recommendations only; any user-facing content the
  system writes (artifacts, handoff summaries) is written only after explicit user
  confirmation, and performing the compaction or starting the new session remains the
  user's act in their own tooling. The system MAY maintain its own bookkeeping state
  (last observed zone, dismissal records) automatically, provided that state contains no
  session content and nothing outside the tool's own state file is touched.
- **FR-008**: When requested (and proactively in the orange and red zones, per FR-015),
  the system MUST scan session content and surface artifact candidates using named
  verb/phrase heuristic rules (deterministic per FR-012). Each candidate MUST include the
  matched excerpt, its location in the session, and the rule that flagged it.
- **FR-009**: Users MUST be able to accept or reject each artifact candidate individually.
  Accepted candidates MUST be saved as plain, human-readable files inside the workspace;
  rejected candidates MUST NOT be written anywhere.
- **FR-010**: On request, the system MUST generate a handoff summary as a plain,
  human-readable file in the workspace, covering: key decisions (from saved artifacts and
  decision-rule matches), current task state (derived from the most recent user requests
  and task-language rule matches in the session), open questions (from question-language
  rule matches), and references to artifacts saved during the session. Every derived item
  MUST name its source — the rule that matched and its session location, or the artifact
  it came from (FR-006). In an interactive session the user MAY review and amend the
  draft before the single write; otherwise the derived draft is written as-is. The red
  zone triggers the recommendation, but the capability MUST be available in any zone.
- **FR-011**: When usage cannot be determined, the system MUST present an explicit
  unknown/stale state including the age of the last successful reading. It MUST NOT
  display any zone without data supporting it.
- **FR-012**: Heuristic scanning MUST be deterministic: identical session content MUST
  always produce the identical candidate list.
- **FR-013**: When exact usage figures are unavailable and the system estimates, the
  reading MUST be visibly labeled as an estimate.
- **FR-014**: A recommendation dismissed by the user MUST NOT be repeated while the session
  remains in the same zone; it MUST re-arm when the session leaves and re-enters a zone or
  escalates to a higher zone.
- **FR-015**: While a session is in the orange or red zone, the system MUST proactively
  surface save-candidate recommendations: entering either zone triggers an automatic,
  read-only content scan (no confirmation required, nothing written), and each resulting
  candidate is offered as an individual recommendation carrying its matching rule as the
  trigger (FR-006). Dismissals follow FR-014 per candidate; a candidate already dismissed
  or already saved MUST NOT be re-offered, while new candidates detected from later
  activity in these zones MUST be surfaced within the refresh window of FR-001.

### Key Entities

- **Session**: One working conversation between the developer and their coding agent; the
  thing being monitored. Has an identity, a start time, and a stream of content.
- **Usage Reading**: A point-in-time measurement — percentage of context capacity used,
  timestamp, and whether the value is exact or estimated.
- **Zone**: A named band of usage (green/yellow/orange/red) with lower/upper bounds and
  associated guidance text. Bounds come from one configuration source.
- **Zone Transition**: The event of a session moving from one zone to another; carries the
  prior zone, the new zone, and the reading that caused it. Drives notifications.
- **Recommendation**: A piece of advice issued to the user (favor retrieval, compact,
  new session, save candidate) with its trigger (zone transition or rule match) and its
  state: pending, accepted, or dismissed.
- **Heuristic Rule**: A named, deterministic pattern (verb- or phrase-based) that flags
  session content as save-worthy; has an identifier, a human-readable description, and a
  category (e.g., decision, conclusion, constraint, result, task, question).
- **Artifact Candidate**: A passage of session content flagged by a heuristic rule —
  excerpt, session location, matching rule, and user decision status.
- **Artifact**: A user-accepted candidate persisted as a plain readable file in the
  workspace.
- **Handoff Summary**: A plain readable file capturing key decisions, task state, and
  artifact references, produced to seed a fresh session.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: At any moment during a monitored session, the user can determine the current
  zone and percentage in under 5 seconds.
- **SC-002**: While a monitoring view is active, zone-transition notifications reach the
  user within 10 seconds of usage crossing a boundary; when no view is active, the
  transition is reflected in the next status query.
- **SC-003**: 100% of recommendations display their trigger (zone/threshold or named rule)
  — verifiable by auditing any sample of issued recommendations.
- **SC-004**: Zero actions that alter session data, and zero writes of user-facing content
  (artifacts, handoff summaries), occur without explicit user confirmation, across all
  usage of the feature. Tool-internal bookkeeping (last observed zone, dismissal records)
  is exempt from confirmation, and MUST never contain session content nor alter session
  data.
- **SC-005**: Scanning the same session content repeatedly yields identical candidate
  lists in 100% of runs.
- **SC-006**: A developer starting a new session from a handoff summary can resume work —
  correctly stating the task in progress and decisions already made — within 2 minutes,
  without consulting the old session.
- **SC-007**: When exact usage data exists to compare against, estimated readings fall
  within 10 percentage points of the true value at least 95% of the time.
- **SC-008**: In moderated trials, users judge at least half of surfaced artifact
  candidates as genuinely worth saving (precision floor that keeps review effort
  worthwhile).

## Assumptions

- Context usage is derived by passively observing the coding agent's session data available
  on the local machine; when exact token counts are not exposed, the monitor estimates and
  labels the reading as an estimate (FR-013). The user's own description of the heuristics
  ("based on verbs or phrases") already requires read access to session content, so passive
  observation is treated as the given data source rather than an open question.
- The initial release monitors the coding-agent environment the team uses daily
  (Claude Code); the design keeps agent-specific knowledge separable so other environments
  can follow, per the constitution's adapter principle. Multi-agent support is out of scope
  for this feature.
- One session is monitored at a time. Concurrent multi-session monitoring is out of scope.
- "Compact" and "start a new session" are actions the user performs in their own agent
  tooling. This feature recommends them and prepares supporting material (artifacts,
  handoff summary); it never executes them (constitution Principle II).
- Zone thresholds default to the constitution's canonical values (40/60/75) and are
  user-configurable within validity rules (FR-003).
- Heuristic rules target English-language session content initially; other languages can be
  added as new rules without changing this specification.
- Artifacts and handoff summaries live in the project workspace as plain files, alongside
  (not inside) the session data they were extracted from.
- The traffic-light metaphor uses four zones (the constitution's orange band between
  yellow and red); "traffic light" refers to the escalation metaphor, not a literal
  three-light limit.
