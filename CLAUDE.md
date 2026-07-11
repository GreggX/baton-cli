<!-- SPECKIT START -->
For additional context about technologies to be used, project structure,
shell commands, and other important information, read the current plan:
`specs/001-session-context-monitor/plan.md`

- Active feature: Session Context Monitor (`specs/001-session-context-monitor/`)
- Stack: TypeScript (strict) on Node ≥ 22, commander, Ink + React (terminal UI only),
  zod (schemas/config/JSON contracts), chokidar, vitest
- Constitution: `.specify/memory/constitution.md` — advisory-only (never mutate session
  data), deterministic/explainable heuristics, `src/core/` must not import from
  `src/adapters/` or `src/cli/`
- Open obligation: MCP parity for the monitor's six capabilities —
  `specs/mcp-parity-obligation.md` (must be satisfied by the future MCP-server feature)
<!-- SPECKIT END -->
