# Desktop-bound MCP

The app-owned child receives `AGENT_TEAMS_BOUND_CONTROL_URL`,
`AGENT_TEAMS_BOUND_CONTEXT_JSON`, and `AGENT_TEAMS_MCP_CLAUDE_DIR` at startup.
The controller captures this binding once, rejects different URL/root overrides,
attaches `x-agent-teams-app-context` to every runtime/work-sync HTTP request, and
rejects redirects. Bound requests never use legacy state-file or environment URL
fallback, and work-sync failures cannot queue filesystem reports. Standalone
stdio keeps its existing lookup behavior.

`app_get_connection_info` takes no arguments and reads `/api/app/connection`.
`team_create` with `runtimeSelectionVersion: 1` requires `expectedContext` with
the app instance, root fingerprint, and connection generation. It must match the
child binding; the app independently validates it before admitting the mutation.

## HTTP transport admission

Pinned FastMCP 3.35.0 delegates to mcp-proxy 6.4.1. Their default HTTP transport
does not validate Host/Origin and enables wildcard CORS. The tracked dependency
patches expose a request gate before CORS, OPTIONS, and session processing. The
desktop-bound server accepts the exact listener Host and either absent Origin
(native clients) or the exact listener origin; other values receive HTTP 403.
With this gate enabled, CORS headers are disabled. This is browser/rebinding
protection, not authentication of local processes.

Both dependency patches must be installed before building the self-contained
MCP bundle. After updating either dependency, revalidate the patch and run the
real HTTP contract in `test/http.e2e.test.ts` against the rebuilt bundle.
