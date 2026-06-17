# Sub-Agents and Team Agents

## Use Sub-Agents (Task tool) When

- Independent research tasks can run in parallel.
- A specialized agent type matches the work (e.g., debugger, test-engineer, frontend-developer).
- The main context window would be polluted by excessive search results.

## Use Team Agents When

- The task benefits from multiple specialized perspectives.
- Code review, security audit, or test analysis is warranted.

## Use Direct Tools Instead When

- Simple, directed searches — use Grep/Glob directly.
- Single-file edits or tasks under 3 steps.
