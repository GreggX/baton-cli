<!-- SPECKIT START -->
For additional context about technologies to be used, project structure,
shell commands, and other important information, read the current plan:
`specs/002-mcp-context-server/plan.md`

- Active feature: MCP Context Server (`specs/002-mcp-context-server/`) — exposes the six
  monitor capabilities to the model; feature 001 (Session Context Monitor) is implemented
- Stack: TypeScript (strict) on Node ≥ 22, commander, Ink + React (CLI TUI only),
  @modelcontextprotocol/sdk (stdio), zod (schemas/config/JSON contracts), chokidar, vitest
- Constitution: `.specify/memory/constitution.md` — advisory-only (never mutate session
  data), deterministic/explainable heuristics, `src/core/` must not import from
  `src/adapters/`, `src/cli/`, or `src/mcp/`
- Obligation closed: MCP parity for the monitor's six capabilities —
  `specs/mcp-parity-obligation.md` is SATISFIED (closed by feature 002)
<!-- SPECKIT END -->
