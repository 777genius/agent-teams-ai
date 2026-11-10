# Chat visualizations

Renderer-only feature for OpenUI and existing Mermaid message fences. Production UI
imports `renderer/index.ts`; shared preview/search callers import `contracts/index.ts`.
The Node-safe `renderer/protocol.ts` exports the exact display library and instructions
used by the protocol generator, without UI or stylesheet imports.

OpenUI is a built-in chat output format, not a separate agent tool or connector.
Agents send `openui-lang` fences through the conversation's existing message
delivery path. The generated protocol declares this capability in startup context
and lead/member briefings; compact startup context tells agents to refresh the
full protocol before emitting a visualization.

The full briefing includes positional component signatures, JSON schemas, and
validated examples for a table/bar chart and a step line/semicircular donut.
Supported chart variants are:

| Component   | Variants                                                          |
| ----------- | ----------------------------------------------------------------- |
| `BarChart`  | `grouped`, `stacked`                                              |
| `LineChart` | `linear`, `natural`, `step`                                       |
| `PieChart`  | `pie`, `donut`, each with `circular` or `semiCircular` appearance |

`VisualizationBlock` owns a stable streaming preflight parser, bounded display
validation, the responsive shell, scoped application theme, and shared Radix dialog.
The application supplies its existing Mermaid renderer through
`ChatVisualizationProvider`. The fixed OpenUI hierarchy is Stack → Card → display
content. Table cells and chart data are static, and TextContent escapes Markdown.

A fence is capped at 32,000 JavaScript characters before parsing. Tables/charts
permit at most 500 rows/points; runtime adapters enforce bounds independently of
the protocol schemas. A preflight over the SDK's unexpanded AST also limits repeated
references before the SDK allocates their data. Its 50,000-unit budget counts each
expanded scalar/container, displayed string length, and component overhead. It
conservatively includes all definitions and the largest duplicate definition so
streaming replacements cannot bypass the bound. The enclosing Markdown viewer
retains its 60,000-character whole-message raw-preview limit. No new message
transport, tool provider, actions, or persistence.

Focused tests live in `test/features/chat-visualizations/` and exercise the actual
pinned parser/library, progressive reference resolution, display guards, plain-text
rendering, and Markdown projection.

## Live OpenCode verification

`test/main/services/team/OpenCodeVisualization.live.test.ts` uses the real app main
services, pinned runtime bridge, model, MCP server, and durable chat inbox without
starting Electron. It creates a fresh sandbox team and project, checks silent
bootstrap, asks its lead and teammate for a chart without supplying the DSL or
tool instructions, and checks a follow-up with several visualization variants.
Only replies persisted through the normal message route count as success. The
production parser and display guards validate their fences and requested data.

Build the MCP server first with `pnpm --filter agent-teams-mcp build`, then run:

```sh
CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH=/absolute/path/to/cli-source \
CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH=/absolute/path/to/opencode \
OPENCODE_E2E=1 OPENCODE_E2E_VISUALIZATION=1 \
OPENCODE_E2E_MODEL=opencode/big-pickle OPENCODE_E2E_KEEP_TEMP=1 \
pnpm exec vitest run --maxWorkers=1 test/main/services/team/OpenCodeVisualization.live.test.ts
```

Use the source launcher for dev smoke, or explicitly select the pinned built
runtime for release verification. Select a model with available quota. This test
is skipped without both opt-in flags; an enabled run that encounters a provider
error or missing chat reply fails. Successful deterministic parser/MCP tests or
test collection do not establish live-model success. Electron rendering and
group-chat delivery are outside this focused live test's scope.
