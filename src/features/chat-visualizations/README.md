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

`VisualizationBlock` owns a stable streaming preflight parser, bounded display
validation, the responsive shell, scoped application theme, and shared Radix dialog.
The application supplies its existing Mermaid renderer through
`ChatVisualizationProvider`. The fixed OpenUI hierarchy is Stack → Card → display
content. Table cells and chart data are static, and TextContent escapes Markdown.

A fence is capped at 32,000 JavaScript characters before parsing. Tables/charts
permit at most 500 rows/points; runtime adapters enforce bounds independently of
the protocol schemas. The enclosing Markdown viewer retains its whole-message
raw-preview limit. No new message transport, tool provider, actions, or persistence.

Focused tests live in `test/features/chat-visualizations/` and exercise the actual
pinned parser/library, progressive reference resolution, display guards, plain-text
rendering, and Markdown projection.
