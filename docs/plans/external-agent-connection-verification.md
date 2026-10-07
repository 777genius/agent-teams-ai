# External agent connection: implementation evidence

2026-10-07. Core implementation and packaged acceptance pass in the isolated `feat/external-agent-mcp-cdp` worktree. Required current-head GitHub CI and PR delivery are pending. This record is not a release announcement.

## Tested source and artifact

- Latest packaged source: `7a5a6bd48a84782621a9dbc63130f392dfb2a43f`, including the reviewed consumer-query extraction and current-main document-preview integration. Delivery PR4 tree `2821e838a07ff9c11e097ef2176f8776e3516317` is identical; subsequent documentation does not change the tested source. Earlier shared-root/crash evidence uses source `5e3f16baf146661d705e84a685cdd8ae99cb94d2`.
- Linux unpacked Electron 44.4.5, application 2.17.6. No remote-debugging or main-inspector launch flags; the saved application setting enables renderer CDP with port 0.
- Executable SHA256: `ee9faf5bb9fe78a750cc5099863c85c4459e7f04c387fd1f111c83e4e8c57c97`.
- Latest `app.asar` SHA256: `0a25d30031586215cf3814f7b3abdf580bfc2b947216f8fd55487fdea83f5829`. Earlier shared-root/crash artifact: `95db6b844566ecb93c373ac8f02c7644cfbc13cb761a1e745729ccbfe0d4060d`.
- Packaged `resources/mcp-server/index.js` SHA256: `9bfd6034a8373cd977fcb69ff482fb0d4c621817c05b0145c9475caa130a640a`.
- Fuse values were read without modification from the same executable hash. The Linux harness uses `--no-sandbox --disable-gpu` under isolated Xvfb; this does not prove sandboxed macOS/Windows behavior or signing.

## Acceptance evidence

| Requirement | Result and nearest proof |
| --- | --- |
| Providerless saved drafts | Four static templates reuse the existing editor/writer. Create/edit/reopen and IPC/HTTP preserve marker 1. Launch admission requires explicit selection; legacy behavior remains. |
| Native external MCP connection | Codex CLI 0.159.2 registers the actual HTTP endpoint in an isolated home. Native app-server discovers tools, calls `app_get_connection_info`, creates a marker-1 draft and reads it back. No SDK substitute, login, API key, LLM turn or agent launch. |
| Independent MCP/control ownership | Immutable binding rejects stale/foreign contexts and fallback. Focused lifecycle tests cover failed local context recovery against the actual root, partial remote transition refusal, startup cancellation, child exit and shutdown fences. |
| Raw renderer CDP | Real listener/WS, exact renderer target and context marker agree. Native input, JS, screenshot, console/network, renderer reload and actual clipboard are exercised in the package. No main inspector is opened. |
| Toggle/restart | Disable truthfully reports still-open access until restart. Next process exposes no CDP endpoint. Re-enable reports pending until restart, then a fresh endpoint. |
| Prompt popup/DRY roster | Free text and four read-only references use the shared create/launch roster primitives. Dark/light screenshots, clipboard equality, selectable preview on clipboard failure and reopen pass. Copied instructions truthfully support create-only. |
| Copy/provider intent | Configured offline sandbox sources expose the real Copy action. Disabled multimodel normalizes a selected copied provider to Anthropic; unresolved Copy retains no provider. Both save marker-1 drafts without launch. Model save/remount/default and inherited-member serialization have focused regression coverage. |
| Root/context safety | Actual TCP admission/root-switch fixture and transport stale-context checks pass. Admitted writes retain captured dependencies. Early IPC guards reject unresolved/unsupported selection before cwd creation, launch intent, engagement or provisioning. |
| Shared storage | Two actual packaged main processes share one test root with separate profiles/endpoints. Concurrent create returns 201/409, preserves winner hashes, rejects foreign context, and closes only owned endpoints. |
| Owned shutdown | Shared-root apps exit normally with code 0, `hardFallback=false`, `detachedMcpCleanup=false`; all three endpoints per app close. Main CDP-ready runs request app close without fallback. The CDP-disabled fixture explicitly uses verified test-owned forced cleanup, not graceful-shutdown proof. |
| Crash cleanup | Deliberate SIGKILL yields an expected failed harness run. Its separately verified owned MCP child is cleaned; all endpoints close, while the other app exits normally. The crash is never reported as normal quit or a green full flow. |
| No runtime side effects | Created/copied destinations have no config/launch/bootstrap runtime artifacts. Copy sources contain only deliberate offline config fixtures. No agent, terminal, task assignment or provisioning action runs on a real project. |

Preserved hosted evidence under `/srv/workers/ea-cdp-20261007-5adf8c/`:

- `external-agent-desktop-TEST-W0hD7A/evidence.json`: current-main integrated packaged acceptance passes; log `main-integration-e2e.log`. Local manifest: `/tmp/external-agent-mcp-cdp-20261007/desktop-main-integration-evidence.json`.
- `external-agent-desktop-TEST-bMwdE8/evidence.json`, screenshots and prompt; log `final-main-e2e.log`.
- `external-agent-shared-root-TEST-rOfYns/evidence.json`; log `final-shared-root-e2e.log`.
- `external-agent-shared-root-TEST-6F5vBn/evidence.json`; log `final-failure-cleanup.log` (intentional failure).
- Local manifest copies: `/tmp/external-agent-mcp-cdp-20261007/{desktop,shared-root,failure-cleanup}-current-final-evidence.json`.

## Static and focused checks

Project typecheck, desktop build and unpacked packaging pass. Typed lint of the final nine changed production paths has zero errors and 44 warnings. Source-size/provisioning guards pass without raising frozen caps (main 3702/3703, supervisor 1399/1410). Packaging's dependency collector falls back to manual traversal after EACCES and completes successfully.

Final relevant suites: IPC/supervisor/actual HTTP lifecycle **290**; dialog/OpenCode model authority/draft persistence **124**; corrected host fixtures **19**. Counts include existing tests. Old-code RED was reproduced for IPC early admission, expected pre-ready stop, failed context recovery, draft model intent, inherited-member materialization and launch opt-out. After the final assertion-only adjustment, six affected UI cases pass. Native adapter probes on Linux and macOS verify the portable `ps axeww` argument with their own test marker without emitting environment contents.

Post-package source review extracted the unchanged MCP-consumer predicate from the provisioning facade into an explicit-input synchronous query (`0767493810`, formatting `c72d94e607`). Independent review accepted behavior equivalence and the architecture boundary. Existing provisioning service tests **479**, full project typecheck, focused lint and architecture/size guards pass; no tests were added for the extraction. Logs: `consumer-extraction-{tests,types,lint}.log`. After merging current main, independent conflict/ancestry review, fresh frozen install, typecheck, build, package and main desktop acceptance pass again (`main-integration-{fresh-install,types,build,package,e2e}.log`).

Earlier broad providerless/controller/MCP suites and installation/build checks remain historical evidence; they are not substituted for current-head CI of changed code. Hosted logs for final checks are `backend-final-{red,green}.log`, `ui-intent-{red,green}.log`, `copy-preflight-{red-corrected,green-suite}.log`, `ci-fixtures-green.log`, `ui-intent-contract-final.log`, `final-source-types.log`, `final-production-lint.log`, `final-build.log`, and `final-package.log` in the same scratch directory.

## Explicit limits and delivery

Verified packaged support is Linux Electron 44.4.5 with native Codex CLI 0.159.2 plus raw CDP. The macOS process-command probe is not a macOS packaged acceptance run. Claude Code/Cursor instructions are not runtime proof. Other OS/client versions, extra BrowserWindows and in-process renderer crash/recreation were not exercised; reload was. Hot registration in an already running agent turn is not promised. Cloud agents need a local executor; copying a prompt cannot grant unavailable client tools.

Edit, reversible trash, session-only highlights and change summaries remain the separate next scope in `team-template-prompt-builder-ux.md`. Current-head required GitHub CI and dependency-safe PR delivery remain outstanding. No release is published.
