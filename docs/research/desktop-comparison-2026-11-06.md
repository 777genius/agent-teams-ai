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

## Mobile load: measured CDP and Lighthouse E2E

On November 6, 2026, the [final Chromium CDP/Lighthouse run](https://github.com/777genius/agent-teams-ai/actions/runs/42236550959) compared pinned untouched main `7ba6e417c56f1d78300f85985ead1698d4902ae0` against PR commit `50e98a10b3e8c66870442022b94add2aad99ee1a`. Both sources were statically generated with the same Node/Nuxt configuration and served via equivalent localhost gzip servers. The CDP experiment used three *cold browser contexts* per revision, 390x844 mobile viewport, DPR 3, 4x CPU slowdown, 150ms RTT, 1.6Mbit/s down / 750Kbit/s up. Values are medians unless labeled Lighthouse.

| Metric | Main baseline | PR | Interpretation |
| --- | ---: | ---: | --- |
| CDP LCP | 4,080 ms | 1,140 ms | -72.1%; LCP candidate changed from remote Mux video background to prioritized robot avatar |
| CDP FCP | 1,152 ms | 1,024 ms | -11.1% |
| CDP transfer size | 2,367 KiB | 1,205 KiB | -49.1% |
| CDP requests | 67 | 63 | Four fewer |
| CDP JS heap | 10.1 MiB | 9.8 MiB | Small reduction |
| CDP CLS | 0.00176 | 0.00176 | No change |
| Lighthouse mobile score | 61/100 | 65/100 | +4 points (single Lighthouse run per revision) |
| Lighthouse LCP | 8,452 ms | 7,755 ms | -697 ms under Lighthouse's independent mobile throttling |
| Lighthouse FCP | 4,562 ms | 4,108 ms | -454 ms |
| Lighthouse TBT | 198 ms | 74 ms | -124 ms |
| Lighthouse CLS | 0.00175 | 0.00175 | No change |

**Root cause confirmed in CDP Network:** The original `organization-map.png` (~1,086 KiB) was used as a *carousel preview*, causing an unnecessary full-resolution download on initial mobile entry. The preview is now the actual `docs/screenshots/previews/organization-map.webp` (23,268 bytes), while the full-resolution PNG remains available on intentional lightbox use. The final CDP assert confirms that the full-size PNG is **not fetched during entry**. The baseline also requested a 1600px Mux background poster despite mobile video being disabled; mobile now renders a static gradient instead. Hero LCP image is preloaded. Content below the fold hydrates near visibility.

**Behavioral E2E:** On the PR build, mobile poster is displayed without an initial Mux iframe, tapping it mounts the player; horizontal comparison navigation, screenshot lightbox open/close, Russian platform translation and 1440px desktop smoke all passed. No page exceptions, missing assets or unintentional desktop horizontal document scroll were observed. The [workflow run and its archived artifacts](https://github.com/777genius/agent-teams-ai/actions/runs/42236550959) contain raw JSON CDP traces, individual mobile samples, Lighthouse reports, resource breakdown, network logs and screenshots.

**Limitations:** These are headless Chromium lab measurements on an isolated runner, **not** hardware iOS/Android Safari/WebView tests, production Render/CDN timings, or real-user field INP. Lighthouse and CDP LCP use different throttling/methodology and must not be interchanged. The local server uses gzip, not the production CDN's possible Brotli. The Lighthouse score is still 65: render-blocking Google Fonts and unused JS/CSS remain possible follow-up optimizations, requiring separate testing. The first draft's cache-disabled, uncompressed-server measurements were invalid as representative network baselines and are not used here.

