# External agent connection: implementation evidence

2026-10-07. Core implementation is complete in the isolated `feat/external-agent-mcp-cdp` worktree. PR delivery and required GitHub CI are pending. This is a verification record, not a product audit store or a release announcement.

## Tested source and artifact

- Production source: `3b9f6112d7841267ac86a0eac32a164724395856`.
- Final harness source: `b50bb502308bc2905020cae266adeabd3fc33589`. Later commits change only harnesses, typecheck registration and documentation; they do not change the tested production source.
- Linux unpacked Electron 44.4.5, application 2.17.4; no remote-debugging or main-inspector launch flags. The saved application setting enables native renderer CDP with port 0.
- Executable SHA256: `ee9faf5bb9fe78a750cc5099863c85c4459e7f04c387fd1f111c83e4e8c57c97`.
- `app.asar` SHA256: `57d4f185463284d782b6eeb5abfed784192f6b778aaae1c8e518ce129338dc58`.
- Packaged `resources/mcp-server/index.js` SHA256: `9bfd6034a8373cd977fcb69ff482fb0d4c621817c05b0145c9475caa130a640a`.
- Fuse values were read from the artifact without modifying them. The Linux harness uses `--no-sandbox --disable-gpu` under its isolated Xvfb display; this does not prove sandboxed macOS/Windows behavior or signing.

## Acceptance evidence

| Requirement | Result and nearest proof |
| --- | --- |
| Providerless templates remain saved drafts | Four static templates reuse the existing editor/writer. Metadata create/edit/reopen and IPC/HTTP checks preserve marker 1; explicit provider selection is required before launch admission. Legacy requests retain existing semantics. |
| Native external MCP client can connect | Codex CLI 0.159.2 registers the actual HTTP endpoint in a fresh isolated home. Native app-server discovers tools, calls `app_get_connection_info`, creates a marker-1 draft and reads its saved request. No SDK substitute, login, API key, LLM turn or agent launch. |
| Independent MCP/control ownership | Actual HTTP/stdio transport checks pass; immutable desktop binding rejects stale/foreign contexts, redirects and override/fallback. Startup and shutdown review found and fixed early-child composition and foreign cleanup defects. |
| Raw renderer CDP | Application-owned port/WS and exact renderer marker agree. Native CDP input, JS, screenshot, console/network and reload are exercised against the packaged renderer. No main inspector is opened. |
| Toggle and restart | Disable reports access still open until restart; the next process reports disabled with no endpoint. Re-enable reports pending before restart, then a fresh renderer endpoint after restart. |
| Prompt popup and DRY roster | Free text and four read-only template references use shared roster primitives from create/launch rows. Dark/light popup and Settings screenshots, real clipboard equality, clipboard failure with selectable preview, and draft reopen pass. The prompt truthfully supports create-only. |
| Root/context safety | Real TCP admission/root-switch fixture and transport stale-context checks pass. Bound requests retain admitted dependencies rather than rereading a changed global root. |
| Two applications sharing storage | Two actual packaged main processes use the same test data root but separate profiles/endpoints. Concurrent create produces 201/409, preserves the winner, rejects foreign app context, and closes each app's own endpoints. |
| Owned shutdown | Both CDP-ready runs close through the application's window-close API with `hardFallback=false` and `detachedMcpCleanup=false`. The CDP-disabled fixture has no renderer control channel and explicitly uses verified test-owned forced cleanup; it is not evidence of graceful disabled-mode shutdown. |
| No runtime side effects | Sandbox-only drafts contain no launch/bootstrap/config runtime artifacts. No terminal, provisioning, task assignment or agent action runs on a real user project. |

Hosted evidence locations (preserved outside the repository):

- `/tmp/external-agent-desktop-TEST-I2w7os/evidence.json`, screenshots and prompt text; log `/tmp/external-agent-packaged-e2e-gated-20261007.log`.
- `/tmp/external-agent-shared-root-TEST-FdBjG4/evidence.json`; log `/tmp/external-agent-shared-root-e2e-20261007.log`.
- Local copies: `/tmp/external-agent-mcp-cdp-20261007/desktop-final-evidence.json` and `shared-root-evidence.json`.

## Static and focused checks

Workspace typecheck passes; the two final handwritten TypeScript harness configurations also pass after registration in the project command. Full app lint has zero errors and 4557 existing warnings; MCP lint has zero errors and four warnings. Production source-size and provisioning architecture guards pass without raising frozen caps. Frozen dependency installation, controller/MCP builds, production desktop build and unpacked packaging pass.

Relevant focused suites: providerless persistence/IPC/HTTP/prefill 478; controller 391; MCP unit 66; actual MCP HTTP/stdio 22; roster/settings/draft hydration 52; lifecycle/root TCP 30. These counts include existing tests. Two startup/ownership regressions were shown red on old code and fixed; no per-template/helper/snapshot coverage expansion was added.

## Explicit limits and remaining delivery

Verified support is Linux Electron 44.4.5 with native Codex CLI 0.159.2 plus raw CDP. Claude Code/Cursor registration instructions are not runtime proof. Other OS/client versions, extra BrowserWindows and in-process renderer crash/recreation were not exercised; reload was. Hot tool registration in an already running agent turn is not promised. Cloud agents need a local executor. Copying a prompt alone cannot grant a client MCP/CDP tools.

Edit, trash, session-only recent highlights and change summaries are a separately planned next scope in `team-template-prompt-builder-ux.md`. Required current-head GitHub CI and dependency-safe PR delivery remain outstanding. No release has been published.
