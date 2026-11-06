# Desktop comparison and mobile landing verification — 2026-11-06

## Scope and method

Compared published stable releases and primary vendor documentation on November 6, 2026. **Desktop means macOS, Windows and Linux only.** CLI installations are differentiated from graphical desktop applications; browser/self-hosted apps do not count as native desktop applications. No hosted product account, competitor runtime, or benchmark was executed. Product feature ratings remain editorial assessments, not measured rankings.

| Product | Stable release / evidence | Desktop platforms and form | Updated assessment |
| --- | --- | --- | --- |
| Agent Teams | [v2.18.6](https://github.com/777genius/agent-teams-ai/releases/tag/v2.18.6), [source](https://github.com/777genius/agent-teams-ai) | macOS (Intel / Apple Silicon), Windows (x64 / ARM64), Linux (published x64 packages); native Electron app. v2.18.6 requires macOS 13+ | Published release adds Codex corrections, OpenCode V2 setup and team messaging diagnostics. Specific runtimes still vary by architecture. |
| Gas Town | [v1.2.1](https://github.com/gastownhall/gastown/releases/tag/v1.2.1) | macOS, Windows and Linux binaries; terminal-first CLI, not a graphical native desktop app | Persistent coordinated agents, dependency management, and recovery; browser dashboard is a separate surface. |
| Paperclip | [v2026.1023.0](https://github.com/paperclipai/paperclip/releases/tag/v2026.1023.0), [README](https://github.com/paperclipai/paperclip) | No native desktop application. Self-hosted control plane accessed through a browser; runtime can be hosted on supported hosts | Private projects/tasks, model gateways, auditable cost ledger (reported, estimated, or unpriced usage), experimental GitHub review bot (disabled by default), MCP client task-editing and experimental Runner adapters. Not equivalent to an in-app hunk review or live peer-team UI. |
| Cursor | [download](https://cursor.com/download), [agent docs](https://cursor.com/docs/agent/agents-window) | macOS, Windows, Linux; graphical desktop IDE | Native agent review, Bugbot and worktrees; these do not establish a shared peer-team task graph. |
| Claude Code | [v2.1.318](https://github.com/anthropics/claude-code/releases/tag/v2.1.318), [setup](https://code.claude.com/docs/en/setup) | macOS, Windows, Linux; **CLI**, not a standalone graphical code editor | Agent teams and cross-session tools documented; releases include major fixes, not a native desktop GUI. |
| OpenRig | [v0.7.8](https://github.com/mvschwarz/openrig/releases/tag/v0.7.8), [setup](https://github.com/mvschwarz/openrig/blob/main/docs/reference/getting-started.md) | macOS and Linux. Windows via **WSL2**; no native Windows deployment claim. Node/tmux prerequisites | Since the previous [v0.6.5 baseline](openrig-comparison-2026-10-06.md): v0.7.4 added experimental hosted MCP members; v0.7.6 added task-following terminal views; v0.7.8 added human answers to runner permission requests and recovery improvements. The v0.7.8 OpenShell reference is **not usable** per its own release note. No claim of supported internet exposure. |

## Notes on version comparisons

- OpenRig v0.7.8 describes hosted MCP members as **experimental, unsupported and disabled by default**. External TLS, narrow grants and explicit opt-in are required. Runner permission requests route to a human, but its default policy permits when nobody can be asked; do not equate every default with denial.
- OpenRig v0.7.8 release notes explicitly say the OpenShell worker could not complete release testing; it is not a shipped working sandbox path.
- Paperclip's GitHub review bot is experimental, requires a setting, and is not a native inline/hunk review surface. MCP client task editing is available, but it does not prove equal live peer-team coordination. Experimental Runner providers such as Dot and Pi are separate from the MCP client integration.
- A green capability tick is about documented behavior in an appropriate form. Cross-platform labels do **not** guarantee that every AI provider/backend works on every architecture.
- Original [OpenRig v0.6.5 analysis](openrig-comparison-2026-10-06.md) remains as an explicitly dated historical source. Other comparison references are retained with version-specific links.

## Mobile landing regression contract

The changes in the related PR target the **website on mobile browsers**, not a mobile build of Agent Teams:

1. Keep the SSR-visible hero and its video placeholder while determining the mobile breakpoint, without constructing the Mux player iframe on a mobile first render. Playback remains available on an explicit tap.
2. Use a reduced-width video thumbnail on phones.
3. Preserve an already-mounted desktop video player when the window narrows; reset iframe loading state and fallback timers only on actual mount/unmount transitions.
4. On widths <=767px, remove the unnecessary 1600px video-poster background (background video and WebGL canvas are disabled at <=767px); keep a static CSS gradient.
5. Hide costly global blurred animated orbs and the full-page scanline overlay on phones, preserving layout and grid.
6. Defer hydration of below-the-fold sections until they are near the viewport, preserving SSR markup, in-page anchors, and desktop interaction.

Verification needed before merge: landing lint/build and smoke checks on narrow and wide widths, mobile hero without Mux iframe before tap, demo playback after tap, horizontal comparison scrolling and localized labels, screenshot lightbox, and browser console/network checks. Mobile network/CPU improvements are **hypotheses based on source inspection**, not measured Lighthouse results.
