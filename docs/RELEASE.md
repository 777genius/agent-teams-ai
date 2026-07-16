# Release Guide

## Draft: v2.8.0 (2026-07-13)

Target branch: `dev`.

Runtime gate:

- Agent Teams runtime: `v0.0.65`.
- Terminal Platform runtime: `v0.3.2`.

Draft body source for GitHub release:

<!-- RELEASE_BODY_START v2.8.0 -->
Use more of the AI subscriptions you already pay for in the same Agent Team. Guided setup connects supported plans, lets you choose a provider and model for each teammate, and keeps the whole flow in one place. This release also adds safe team-folder import, newer Codex models, and fuller usage and cost reporting.

### What's New

- Connect SuperGrok, GitHub Copilot, Cursor, Amazon Q Developer / Kiro, Z.AI Coding Plan, MiniMax Token Plan, Kimi Code Membership, and Xiaomi MiMo Token Plan through guided setup in the dashboard and Provider Settings.
- Browse models by connected provider and assign them to individual teammates, including models from the larger OpenCode catalog.
- Import an existing team folder, preview the detected members, skills, and project path, and create a draft team before launching it.
- Discover GPT-5.6 Sol, Terra, and Luna in Codex, with Max and Ultra reasoning effort where supported.
- Include OpenCode token usage and refreshed model pricing in the shared Usage dashboard and budget breakdowns.
- Configure and validate context and output limits for local OpenCode models without changing the user's OpenCode project settings.

### Improvements

- Make Provider Settings easier to understand with clearer Claude, Codex, and OpenCode tabs, immediate setup progress, guided browser and device-code sign-in, key validation, and clearer verification results.
- Load provider cards and connection counts sooner, then cache, paginate, and virtualize large model catalogs for faster search and stable scrolling.
- Guide installation or updates for the OpenCode runtime and the Cursor Agent or Kiro CLI components required by their provider flows.
- Let connected providers renew or replace managed credentials without deleting the working credential first, and detect Xiaomi MiMo regions automatically from the plan's dedicated Base URL.
- Keep mixed OpenCode teammates isolated by model, improve readiness checks, and apply model context limits consistently.
- Update the terminal runtime and make command history render more reliably.
- Preserve task references, attachment paths, and work-sync timeouts in MCP actions, plus advanced team settings sent through HTTP.

### Bug Fixes

- Fix SuperGrok device authorization getting stuck after browser approval, and refresh its managed session before team launch when needed.
- Fix stale provider cards and connection counts after connecting or reconnecting, stop plans from appearing connected without usable credentials, and close setup races around OAuth, cancellation, credential writes, and model verification.
- Prevent simultaneous team messages from overwriting one another, keep other inboxes readable when one history is damaged, and reject unsafe member paths.
- Fix project matching when path casing differs while keeping distinct case-sensitive paths separate on macOS and Linux.
- Reject malformed or unsafe team-folder imports and prevent competing imports or storage writes from overwriting each other.
- Fix unavailable Codex models and stale teammate effort values in team configuration, show a clear fallback notice when the live catalog is unavailable, and offer an in-app runtime update when one is available.
- Stop cancelled setup and CLI operations from leaving child processes running in the background.
- Prevent the startup configuration request from running before its desktop handler is ready.

### Downloads

<table>
<tr>
<td align="center">
  <a href="https://github.com/777genius/agent-teams-ai/releases/download/v2.8.0/Agent.Teams.AI-2.8.0-arm64.dmg">
    <img src="https://img.shields.io/badge/macOS_Apple_Silicon-.dmg-000000?style=for-the-badge&logo=apple&logoColor=white" alt="macOS Apple Silicon" />
  </a>
  <br />
  <a href="https://github.com/777genius/agent-teams-ai/releases/download/v2.8.0/Agent.Teams.AI-2.8.0-x64.dmg">
    <img src="https://img.shields.io/badge/macOS_Intel-.dmg-434343?style=for-the-badge&logo=apple&logoColor=white" alt="macOS Intel" />
  </a>
</td>
<td align="center">
  <a href="https://github.com/777genius/agent-teams-ai/releases/download/v2.8.0/Agent.Teams.AI.Setup.2.8.0.exe">
    <img src="https://img.shields.io/badge/Windows-Download_.exe-0078D4?style=for-the-badge&logo=windows&logoColor=white" alt="Windows" />
  </a>
  <br />
  <sub>May trigger SmartScreen - click "More info" then "Run anyway"</sub>
  <br />
  <sub>Run normally. Administrator mode may be needed only if the app reports a specific OpenCode symlink or permission error.</sub>
</td>
<td align="center">
  <a href="https://github.com/777genius/agent-teams-ai/releases/download/v2.8.0/Agent.Teams.AI-2.8.0.AppImage">
    <img src="https://img.shields.io/badge/Linux-Download_.AppImage-FCC624?style=for-the-badge&logo=linux&logoColor=black" alt="Linux AppImage" />
  </a>
  <br />
  <a href="https://github.com/777genius/agent-teams-ai/releases/download/v2.8.0/agent-teams-ai_2.8.0_amd64.deb">
    <img src="https://img.shields.io/badge/.deb-E95420?style=flat-square&logo=ubuntu&logoColor=white" alt=".deb" />
  </a>&nbsp;
  <a href="https://github.com/777genius/agent-teams-ai/releases/download/v2.8.0/agent-teams-ai-2.8.0.x86_64.rpm">
    <img src="https://img.shields.io/badge/.rpm-294172?style=flat-square&logo=redhat&logoColor=white" alt=".rpm" />
  </a>&nbsp;
  <a href="https://github.com/777genius/agent-teams-ai/releases/download/v2.8.0/agent-teams-ai-2.8.0.pacman">
    <img src="https://img.shields.io/badge/.pacman-1793D1?style=flat-square&logo=archlinux&logoColor=white" alt=".pacman" />
  </a>
</td>
</tr>
</table>
<!-- RELEASE_BODY_END v2.8.0 -->

## Published: v2.5.1 (2026-06-21)

GitHub release: [v2.5.1](https://github.com/777genius/agent-teams-ai/releases/tag/v2.5.1).

Target branch: `dev`.

Draft build commit: `9cddb727de5470074ffe07dd3f528f31c4b8edf2`.

User-facing code range: `v2.5.0..9e1edc66944ef69d148ec9b3f55b377deac2e68a`, plus release metadata in `9cddb727de5470074ffe07dd3f528f31c4b8edf2`.

Runtime gate:

- Agent Teams runtime: `v0.0.54`; `777genius/agent_teams_orchestrator@main` currently matches `v0.0.54`.
- Terminal Platform runtime: `v0.2.0`; this is the latest published `777genius/terminal-platform` release. The newer `terminal-platform@main` commit is unreleased and is not bundled in this patch release.

Release body source for GitHub release:

<!-- RELEASE_BODY_START v2.5.1 -->
Reduces memory growth in long-running teams and large projects. Fixes OOM risks in transcript/project matching, duplicate runtime probes, and unbounded runtime/provisioning diagnostic buffers.

### What's New

- Lower memory overhead for long-running teams and large project scans.

### Improvements

- Keep transcript/project matching metadata compact after large scans finish.
- Keep runtime health checks single-flight during rapid refreshes and timeouts.
- Cap retained runtime, provisioning, provider, MCP probe, and timeout output.
- Improve launch reliability on low-memory machines.
- Reduce repeated work-sync nudges that do not add new information.

### Bug Fixes

- Fix OOM risk from transcript affinity metadata retaining full normalized JSONL message text.
- Fix duplicate runtime snapshot probes during cache invalidation and timeout storms.
- Fix low-heap team launch crashes and unbounded stdout/stderr carry buffers.
- Fix Enter submitting text during IME composition.
- Fix draft launch roster updates before launch.
- Update vulnerable dependencies from the post-v2.5.0 security audit.

### Downloads

<table>
<tr>
<td align="center">
  <a href="https://github.com/777genius/agent-teams-ai/releases/download/v2.5.1/Agent.Teams.AI-2.5.1-arm64.dmg">
    <img src="https://img.shields.io/badge/macOS_Apple_Silicon-.dmg-000000?style=for-the-badge&logo=apple&logoColor=white" alt="macOS Apple Silicon" />
  </a>
  <br />
  <a href="https://github.com/777genius/agent-teams-ai/releases/download/v2.5.1/Agent.Teams.AI-2.5.1-x64.dmg">
    <img src="https://img.shields.io/badge/macOS_Intel-.dmg-434343?style=for-the-badge&logo=apple&logoColor=white" alt="macOS Intel" />
  </a>
</td>
<td align="center">
  <a href="https://github.com/777genius/agent-teams-ai/releases/download/v2.5.1/Agent.Teams.AI.Setup.2.5.1.exe">
    <img src="https://img.shields.io/badge/Windows-Download_.exe-0078D4?style=for-the-badge&logo=windows&logoColor=white" alt="Windows" />
  </a>
  <br />
  <sub>May trigger SmartScreen - click "More info" then "Run anyway"</sub>
  <br />
  <sub><strong>Windows required:</strong> launch Agent Teams AI as Administrator, especially when using OpenCode runtimes.</sub>
</td>
<td align="center">
  <a href="https://github.com/777genius/agent-teams-ai/releases/download/v2.5.1/Agent.Teams.AI-2.5.1.AppImage">
    <img src="https://img.shields.io/badge/Linux-Download_.AppImage-FCC624?style=for-the-badge&logo=linux&logoColor=black" alt="Linux AppImage" />
  </a>
  <br />
  <a href="https://github.com/777genius/agent-teams-ai/releases/download/v2.5.1/agent-teams-ai_2.5.1_amd64.deb">
    <img src="https://img.shields.io/badge/.deb-E95420?style=flat-square&logo=ubuntu&logoColor=white" alt=".deb" />
  </a>&nbsp;
  <a href="https://github.com/777genius/agent-teams-ai/releases/download/v2.5.1/agent-teams-ai-2.5.1.x86_64.rpm">
    <img src="https://img.shields.io/badge/.rpm-294172?style=flat-square&logo=redhat&logoColor=white" alt=".rpm" />
  </a>&nbsp;
  <a href="https://github.com/777genius/agent-teams-ai/releases/download/v2.5.1/agent-teams-ai-2.5.1.pacman">
    <img src="https://img.shields.io/badge/.pacman-1793D1?style=flat-square&logo=archlinux&logoColor=white" alt=".pacman" />
  </a>
</td>
</tr>
</table>
<!-- RELEASE_BODY_END v2.5.1 -->

## Published: v2.5.0 (2026-06-15)

GitHub release: [v2.5.0](https://github.com/777genius/agent-teams-ai/releases/tag/v2.5.0).

Release body source for GitHub release:

<!-- RELEASE_BODY_START v2.5.0 -->
Built-in terminal for command and graph screens.

<img width="762" height="338" alt="image" src="https://github.com/user-attachments/assets/c8aa4e93-1223-4caa-b3be-cf22852f1c10" />

### What's New

- Bottom-sheet terminal in command and graph views.
- Multi-tab shells: rename, reorder, close, switch, restore history, and prewarmed new tabs.
- Command history blocks show cwd, git branch, duration, stdout/stderr, and error state.
- Settings tab controls theme, font size, opacity, background color/image, image fit, blur, and line wrapping.
- Right-click command block actions copy the whole block, command, or output.

### Improvements

- Fresh clones auto-download the Terminal Platform runtime; `CLAUDE_TERMINAL_PLATFORM_ROOT` remains available for local runtime development.
- Run is shown only with non-empty input; Ctrl+C is shown only after terminal history exists.

### Bug Fixes

- Prevented shell-startup input from becoming stray text or duplicate pending command entries.
- Restored visible command input in blank/initial terminal states and fixed history context menus.
- Fixed tab click, close, reorder, hover close, and left-tab fallback after close.

### Downloads

<table>
<tr>
<td align="center">
  <a href="https://github.com/777genius/agent-teams-ai/releases/download/v2.5.0/Agent.Teams.AI-2.5.0-arm64.dmg">
    <img src="https://img.shields.io/badge/macOS_Apple_Silicon-.dmg-000000?style=for-the-badge&logo=apple&logoColor=white" alt="macOS Apple Silicon" />
  </a>
  <br />
  <a href="https://github.com/777genius/agent-teams-ai/releases/download/v2.5.0/Agent.Teams.AI-2.5.0-x64.dmg">
    <img src="https://img.shields.io/badge/macOS_Intel-.dmg-434343?style=for-the-badge&logo=apple&logoColor=white" alt="macOS Intel" />
  </a>
</td>
<td align="center">
  <a href="https://github.com/777genius/agent-teams-ai/releases/download/v2.5.0/Agent.Teams.AI.Setup.2.5.0.exe">
    <img src="https://img.shields.io/badge/Windows-Download_.exe-0078D4?style=for-the-badge&logo=windows&logoColor=white" alt="Windows" />
  </a>
  <br />
  <sub>May trigger SmartScreen - click "More info" then "Run anyway"</sub>
  <br />
  <sub><strong>Windows required:</strong> launch Agent Teams AI as Administrator, especially when using OpenCode runtimes.</sub>
</td>
<td align="center">
  <a href="https://github.com/777genius/agent-teams-ai/releases/download/v2.5.0/Agent.Teams.AI-2.5.0.AppImage">
    <img src="https://img.shields.io/badge/Linux-Download_.AppImage-FCC624?style=for-the-badge&logo=linux&logoColor=black" alt="Linux AppImage" />
  </a>
  <br />
  <a href="https://github.com/777genius/agent-teams-ai/releases/download/v2.5.0/agent-teams-ai_2.5.0_amd64.deb">
    <img src="https://img.shields.io/badge/.deb-E95420?style=flat-square&logo=ubuntu&logoColor=white" alt=".deb" />
  </a>&nbsp;
  <a href="https://github.com/777genius/agent-teams-ai/releases/download/v2.5.0/agent-teams-ai-2.5.0.x86_64.rpm">
    <img src="https://img.shields.io/badge/.rpm-294172?style=flat-square&logo=redhat&logoColor=white" alt=".rpm" />
  </a>&nbsp;
  <a href="https://github.com/777genius/agent-teams-ai/releases/download/v2.5.0/agent-teams-ai-2.5.0.pacman">
    <img src="https://img.shields.io/badge/.pacman-1793D1?style=flat-square&logo=archlinux&logoColor=white" alt=".pacman" />
  </a>
</td>
</tr>
</table>
<!-- RELEASE_BODY_END v2.5.0 -->

## Draft: v2.4.0 (2026-06-09)

Target commit: `ad5a2dc5808eeddde30ab17eecf3afbb32b24214` (`origin/dev`).

Draft body source for GitHub release:

<!-- RELEASE_BODY_START v2.4.0 -->
Minor release focused on more capable team runtime workflows, better Agent Graph controls, faster team screens, and stronger recovery for OpenCode, Codex, and member work sync. It also refreshes onboarding docs, screenshots, and Simplified Chinese localization.

### What's New

- feat: Copy a reusable team configuration from an existing team setup.
- feat: Add Agent Graph space effects controls and owner column backdrops for clearer team visualization.
- feat: Add Codex custom provider profiles and keep live OpenCode model choices authoritative.
- feat: Add Opus 4.8 to the model catalog and runtime profile.
- feat: Support OpenCode worktree root lanes and runtime-backed OpenCode lead sessions.

### Improvements

- improve: Show a team loading skeleton while team details are still loading.
- improve: Reduce team page telemetry, message rendering, transcript scanning, task presence, and runtime watcher overhead.
- improve: Surface runtime launch stages and overlay runtime liveness in team status responses.
- improve: Clean stale direct-process runtime metadata and add targeted runtime PID liveness checks.
- improve: Refresh landing page screenshots, beginner workflow guides, mobile landing layout, and Simplified Chinese localization.

### Bug Fixes

- fix: Preserve team project filter selection and scope workspace trust preflight checks by provider.
- fix: Harden member work-sync nudges, stale report token recovery, provider metadata merging, and recovery delivery.
- fix: Improve OpenCode runtime recovery, message delivery, managed profile diagnostics, and Windows junction fallback handling.
- fix: Repair runtime snapshot caching, RSS sampling, bootstrap timestamp handling, and Codex bootstrap reconciliation.
- fix: Allow quoted Windows shell metacharacters and harden command/path handling.
- fix: Deduplicate runtime watcher/model badges and guard Radix ref cleanup loops.

### Downloads

<table>
<tr>
<td align="center">
  <a href="https://github.com/777genius/agent-teams-ai/releases/download/v2.4.0/Agent.Teams.AI-2.4.0-arm64.dmg">
    <img src="https://img.shields.io/badge/macOS_Apple_Silicon-.dmg-000000?style=for-the-badge&logo=apple&logoColor=white" alt="macOS Apple Silicon" />
  </a>
  <br />
  <a href="https://github.com/777genius/agent-teams-ai/releases/download/v2.4.0/Agent.Teams.AI-2.4.0-x64.dmg">
    <img src="https://img.shields.io/badge/macOS_Intel-.dmg-434343?style=for-the-badge&logo=apple&logoColor=white" alt="macOS Intel" />
  </a>
</td>
<td align="center">
  <a href="https://github.com/777genius/agent-teams-ai/releases/download/v2.4.0/Agent.Teams.AI.Setup.2.4.0.exe">
    <img src="https://img.shields.io/badge/Windows-Download_.exe-0078D4?style=for-the-badge&logo=windows&logoColor=white" alt="Windows" />
  </a>
  <br />
  <sub>May trigger SmartScreen - click "More info" then "Run anyway"</sub>
  <br />
  <sub><strong>Windows required:</strong> launch Agent Teams AI as Administrator, especially when using OpenCode runtimes.</sub>
</td>
<td align="center">
  <a href="https://github.com/777genius/agent-teams-ai/releases/download/v2.4.0/Agent.Teams.AI-2.4.0.AppImage">
    <img src="https://img.shields.io/badge/Linux-Download_.AppImage-FCC624?style=for-the-badge&logo=linux&logoColor=black" alt="Linux AppImage" />
  </a>
  <br />
  <a href="https://github.com/777genius/agent-teams-ai/releases/download/v2.4.0/agent-teams-ai_2.4.0_amd64.deb">
    <img src="https://img.shields.io/badge/.deb-E95420?style=flat-square&logo=ubuntu&logoColor=white" alt=".deb" />
  </a>&nbsp;
  <a href="https://github.com/777genius/agent-teams-ai/releases/download/v2.4.0/agent-teams-ai-2.4.0.x86_64.rpm">
    <img src="https://img.shields.io/badge/.rpm-294172?style=flat-square&logo=redhat&logoColor=white" alt=".rpm" />
  </a>&nbsp;
  <a href="https://github.com/777genius/agent-teams-ai/releases/download/v2.4.0/agent-teams-ai-2.4.0.pacman">
    <img src="https://img.shields.io/badge/.pacman-1793D1?style=flat-square&logo=archlinux&logoColor=white" alt=".pacman" />
  </a>
</td>
</tr>
</table>
<!-- RELEASE_BODY_END v2.4.0 -->

## Published: v2.3.1 (2026-06-01)

Patch release focused on more reliable team recovery, cleaner provider/model loading, and task dependency handling. GitHub release: [v2.3.1](https://github.com/777genius/agent-teams-ai/releases/tag/v2.3.1).

## Published: v2.1.2 (2026-05-23)

Performance and reliability release: faster startup, deferred provider/runtime hydration, resilient file watching under watcher limits, safer context switching, better team launch diagnostics, and packaged app entry/runtime fixes. GitHub release: [v2.1.2](https://github.com/777genius/agent-teams-ai/releases/tag/v2.1.2).

## Published: v1.2.0 (2026-03-31)

Agent Graph, per-team tool approval, interactive AskUserQuestion, task comment notifications, cross-team ghost nodes. Major graph improvements: force-directed visualization with kanban task layout, fullscreen/tab mode, animated particles, member hexagons with avatars, popover actions. Permission system overhaul with proper Write/Edit/NotebookEdit seeding and MCP tool catalog integration. Full list: [CHANGELOG.md](./CHANGELOG.md).

## Published: v1.1.0 (2026-03-26)

Minor release: React 19 + Electron 40 migration, start-task-by-user, auth troubleshooting guide, syntax highlighting for R/Ruby/PHP/SQL, search performance improvements, cost tracking accuracy, WSL/Windows path fixes. Full list: [CHANGELOG.md](./CHANGELOG.md).

## Published: v1.0.0 (2026-03-23)

Initial release: Agent Teams with reliable CLI detection in packaged builds (shell PATH/HOME, `CLAUDE_CONFIG_DIR`, auth output parsing), IPC status cache handling, concurrent binary resolution, capped NDJSON diagnostics. Full list: [CHANGELOG.md](./CHANGELOG.md).

After CI uploads artifacts, optional notes update:

```bash
gh release edit v1.0.0 --repo 777genius/agent-teams-ai --notes "$(cat <<'EOF'
## Agent Teams v1.0.0

First stable build: CLI/auth reliability in packaged apps, IPC hardening, and platform packaging.

### What's New
- Setting to auto-expand AI response groups in transcripts (`general.autoExpandAIGroups`).

### Improvements
- CLI status uses interactive shell environment and merged PATH so packaged builds match terminal behavior.
- Stricter IPC validation and clearer notification/update contracts.

### Bug Fixes
- Fix false "not logged in" when the CLI is authenticated in the shell.
- Clear stale CLI status cache when status refresh fails.
- Windows path edge cases in tooling and tests.

### Downloads

<table>
<tr>
<td align="center">
  <a href="https://github.com/777genius/agent-teams-ai/releases/download/v1.0.0/Agent.Teams.AI-1.0.0-arm64.dmg">
    <img src="https://img.shields.io/badge/macOS_Apple_Silicon-.dmg-000000?style=for-the-badge&logo=apple&logoColor=white" alt="macOS Apple Silicon" />
  </a>
  <br />
  <a href="https://github.com/777genius/agent-teams-ai/releases/download/v1.0.0/Agent.Teams.AI-1.0.0.dmg">
    <img src="https://img.shields.io/badge/macOS_Intel-.dmg-434343?style=for-the-badge&logo=apple&logoColor=white" alt="macOS Intel" />
  </a>
</td>
<td align="center">
  <a href="https://github.com/777genius/agent-teams-ai/releases/download/v1.0.0/Agent.Teams.AI.Setup.1.0.0.exe">
    <img src="https://img.shields.io/badge/Windows-Download_.exe-0078D4?style=for-the-badge&logo=windows&logoColor=white" alt="Windows" />
  </a>
  <br />
  <sub>May trigger SmartScreen - click "More info" then "Run anyway"</sub>
</td>
<td align="center">
  <a href="https://github.com/777genius/agent-teams-ai/releases/download/v1.0.0/Agent.Teams.AI-1.0.0.AppImage">
    <img src="https://img.shields.io/badge/Linux-Download_.AppImage-FCC624?style=for-the-badge&logo=linux&logoColor=black" alt="Linux AppImage" />
  </a>
  <br />
  <a href="https://github.com/777genius/agent-teams-ai/releases/download/v1.0.0/claude-agent-teams-ui_1.0.0_amd64.deb">
    <img src="https://img.shields.io/badge/.deb-E95420?style=flat-square&logo=ubuntu&logoColor=white" alt=".deb" />
  </a>&nbsp;
  <a href="https://github.com/777genius/agent-teams-ai/releases/download/v1.0.0/claude-agent-teams-ui-1.0.0.x86_64.rpm">
    <img src="https://img.shields.io/badge/.rpm-294172?style=flat-square&logo=redhat&logoColor=white" alt=".rpm" />
  </a>&nbsp;
  <a href="https://github.com/777genius/agent-teams-ai/releases/download/v1.0.0/claude-agent-teams-ui-1.0.0.pacman">
    <img src="https://img.shields.io/badge/.pacman-1793D1?style=flat-square&logo=archlinux&logoColor=white" alt=".pacman" />
  </a>
</td>
</tr>
</table>
EOF
)"
```

## Versioning (SemVer)

Format: `MAJOR.MINOR.PATCH`

| Bump  | When                                                                  | Example       |
| ----- | --------------------------------------------------------------------- | ------------- |
| MAJOR | Breaking changes, major UI overhaul, incompatible data format changes | 1.0.0 -> 2.0.0 |
| MINOR | New features, new panels/views, new integrations                      | 1.0.0 -> 1.1.0 |
| PATCH | Bug fixes, performance improvements, small UI tweaks                  | 1.0.0 -> 1.0.1 |

## Release Process

### Critical stable-release invariant

> [!CAUTION]
> A draft becoming public is not enough to complete a stable release. The only
> supported publication path is a successful `release.yml` run for the exact
> release tag with `publish_release=true`. Publishing through GitHub's
> **Publish release** button or `gh release edit --draft=false` skips the updater
> feed job. Existing installations then receive no update event, dialog, or
> banner.

A stable release is complete only when all of these are true:

- The final `release.yml` run used `publish_release=true`.
- Its `upload-stable-links` job succeeded rather than being skipped.
- The release is public, non-prerelease, and selected as GitHub's latest release.
- The release assets contain `latest.yml`, `latest-linux.yml`, and `latest-mac.yml`.
- All three `/releases/latest/download/latest*.yml` URLs return successfully.

If any condition is false, treat the release as incomplete: do not announce it,
do not report it as shipped, and use the recovery procedure in step 5.

Two automated guards enforce this invariant:

- The final `release.yml` job runs `scripts/ci/verify-published-updater-release.sh`
  after publication and returns an incomplete release to draft.
- `.github/workflows/release-publication-guard.yml` listens for manual
  `release.published` events and returns a directly published incomplete stable
  release to draft. This closes the GitHub UI and direct `gh release edit` path.

### Test Releases And Auto-Update Safety

Packaged apps check GitHub releases through `electron-updater` shortly after startup and then periodically. A normal public release with a higher SemVer and uploaded `latest.yml`, `latest-linux.yml`, or `latest-mac.yml` can be shown to users as an available update.

For smoke/testing releases, do not publish a normal stable release. Use at least one of these guards:

- Mark the GitHub release as `prerelease`.
- Keep the GitHub release as `draft`.
- Add one of these exact markers to the release title or notes: `[skip-updater]`, `[test-release]`, `[internal-release]`, `[no-autoupdate]`.

The app suppresses update notifications for releases with those flags or markers. A stable production release must not use those markers.

### 1. Prepare

```bash
# Make sure branch is clean and pushed
git status
git push origin <branch>
```

### 2. Runtime release gate

Every app release must prove whether the packaged `claude-multimodel` runtime is
current. The app release workflow stages runtime assets from `runtime.lock.json`,
so an app draft can be built from fresh UI code while still bundling an old
runtime if this gate is skipped.

Check the runtime delta from this repo:

```bash
APP_VERSION=2.4.0
RUNTIME_REPO=/Users/belief/dev/projects/claude/agent_teams_orchestrator
CURRENT_RUNTIME_REF="$(node scripts/runtime-lock.mjs source-ref)"

git -C "$RUNTIME_REPO" fetch origin --tags
git -C "$RUNTIME_REPO" status --short
git -C "$RUNTIME_REPO" log --oneline "$CURRENT_RUNTIME_REF"..origin/main
```

If `git status --short` in the runtime repo is non-empty, stop and resolve that
repo first. Do not tag a runtime from a dirty worktree.

If the log is empty, keep the existing `runtime.lock.json` and continue to the
app tag step.

If the log is not empty and any commit affects packaged runtime behavior, ship a
new runtime before building the app release:

```bash
RUNTIME_VERSION=0.0.52
RUNTIME_REPO=/Users/belief/dev/projects/claude/agent_teams_orchestrator

cd "$RUNTIME_REPO"
git checkout main
git pull --ff-only origin main

# Bump the runtime package version to RUNTIME_VERSION.
RUNTIME_VERSION="$RUNTIME_VERSION" node -e "const fs=require('fs'); const p='package.json'; const j=JSON.parse(fs.readFileSync(p,'utf8')); j.version=process.env.RUNTIME_VERSION; fs.writeFileSync(p, JSON.stringify(j, null, 2)+'\n');"

bun test src/utils/renderOptions.test.ts src/utils/headlessInputPrompt.test.ts
git add package.json
git commit -m "chore(release): bump runtime to $RUNTIME_VERSION"
git tag "v$RUNTIME_VERSION"
git push origin main "v$RUNTIME_VERSION"

gh workflow run release-runtime.yml \
  --repo 777genius/agent_teams_orchestrator \
  --ref "v$RUNTIME_VERSION" \
  -f source_ref="v$RUNTIME_VERSION" \
  -f runtime_version="$RUNTIME_VERSION" \
  -f target_release_repo=777genius/agent_teams_orchestrator_binaries \
  -f target_release_tag="runtime-v$RUNTIME_VERSION"

gh run list \
  --repo 777genius/agent_teams_orchestrator \
  --workflow release-runtime.yml \
  --limit 1
```

Watch the returned run until it succeeds:

```bash
gh run watch <RUN_ID> --repo 777genius/agent_teams_orchestrator
```

After the runtime workflow succeeds, update this repo's `runtime.lock.json`:

- `version`: the new runtime version, for example `0.0.52`
- `sourceRef`: the matching runtime tag, for example `v0.0.52`
- `releaseRepository`: the public repository that hosts runtime assets,
  `777genius/agent_teams_orchestrator_binaries`
- `releaseTag`: the namespaced public runtime release tag, for example `runtime-v0.0.52`
- each `assets.*.file`: replace the old runtime version suffix with the new one

Then verify the lock points at real uploaded assets:

```bash
RUNTIME_TAG="$(node scripts/runtime-lock.mjs release-tag)"
RUNTIME_REPO="$(node scripts/runtime-lock.mjs release-repository)"

gh release view "$RUNTIME_TAG" \
  --repo "$RUNTIME_REPO" \
  --json assets \
  -q '.assets[].name' > /tmp/agent-teams-release-assets.txt

node scripts/runtime-lock.mjs asset-list | while read -r asset; do
  rg -qx "$asset" /tmp/agent-teams-release-assets.txt
done

node scripts/stage-runtime.mjs
```

Do not create standalone runtime releases in the frontend repository. The source tag is in the
private `777genius/agent_teams_orchestrator` repository, while the downloadable release is in
public `777genius/agent_teams_orchestrator_binaries`. The frontend release workflow stages those
archives into packaged app installers.

Local `pnpm dev` downloads the pinned runtime anonymously from the public binary repository. GitHub
CLI authentication is not required. A local runtime override remains available through
`CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH`.

### 3. Create tag and build the draft

```bash
git tag v<VERSION>
git push origin v<VERSION>

gh workflow run release.yml \
  --repo 777genius/agent-teams-ai \
  --ref v<VERSION> \
  -f release_tag=v<VERSION> \
  -f publish_release=false
```

Pushing the tag does not start the release workflow. `release.yml` is
`workflow_dispatch`-only, so the explicit `gh workflow run` command is required.
The draft workflow:

- Builds the app (ubuntu)
- Packages macOS arm64 + x64 (with code signing & notarization)
- Packages Windows (NSIS installer)
- Packages Linux (AppImage, deb, rpm, pacman)
- Creates a GitHub Release with all artifacts

### 4. Update release notes

After the workflow completes, edit the release notes:

```bash
gh release edit v<VERSION> --repo 777genius/agent-teams-ai --notes "$(cat <<'EOF'
<paste release notes here>
EOF
)"
```

Public release notes must follow this standard every time:

- Start with a short user-facing summary. Explain what changed and why users should care.
- Do not add a duplicate `## Agent Teams v<VERSION>` heading inside the release body; the GitHub release title already shows the version.
- Do not start with a template sentence like `Agent Teams AI <VERSION> is...`; start with the concrete user impact.
- Use the sections `What's New`, `Improvements`, and `Bug Fixes`; omit a section only if it would be empty.
- Keep internal-only CI, lint, dependency, and refactor work out of public notes unless it directly explains a user-visible fix.
- Do not include raw build SHA, target commit, workflow IDs, or other internal release plumbing in public notes.
- Do not mention the Agent Teams/orchestrator runtime version in public notes. Describe the user-visible runtime change instead, for example "Update bundled runtime" or "Improve native startup validation".
- For Terminal Platform updates, prefer user-facing wording such as "Update terminal runtime" unless the exact version is specifically relevant.
- Put `Downloads` as the final section, after all text notes.
- Use badge/button links in `Downloads`, not bare asset links.
- Verify actual asset names with `gh release view v<VERSION> --repo 777genius/agent-teams-ai --json assets` before writing links.
- Prefer versioned installer links for release-specific notes: `Agent.Teams.AI-<VERSION>-arm64.dmg`, `Agent.Teams.AI-<VERSION>-x64.dmg`, `Agent.Teams.AI.Setup.<VERSION>.exe`, `Agent.Teams.AI-<VERSION>.AppImage`, `agent-teams-ai_<VERSION>_amd64.deb`, `agent-teams-ai-<VERSION>.x86_64.rpm`, and `agent-teams-ai-<VERSION>.pacman`.

Draft releases must be treated as review artifacts:

- There must be at most one draft release in `777genius/agent-teams-ai` at any time. Before creating a new draft, check existing drafts with `gh release list --repo 777genius/agent-teams-ai --limit 20`. If any draft already exists, stop and resolve it first by publishing it or by explicitly deleting it after a direct user command.
- Do not hand off a draft release for review while it still has generated notes, stale notes from an earlier run, or a `Full Changelog`-only body.
- Before telling the user a draft is ready, always edit the draft body with the current release notes template and then re-check it with `gh release view v<VERSION> --repo 777genius/agent-teams-ai --json body,assets,isDraft,isPrerelease,targetCommitish`.
- Confirm the draft targets the intended commit with `targetCommitish`; do not put the raw commit SHA in the release body.
- If a draft already exists when starting or retrying a release, do not delete it automatically. Ask for explicit permission to delete, replace, or reuse it.
- Never delete a draft release just because the user said to "make a release" or "redo the release". Deleting a draft requires a separate explicit command such as "delete the draft release".

### 5. Publish a reviewed draft

The only supported draft-to-stable transition is rerunning the release workflow
for the exact same tag with `publish_release=true`:

```bash
gh workflow run release.yml \
  --repo 777genius/agent-teams-ai \
  --ref v<VERSION> \
  -f release_tag=v<VERSION> \
  -f publish_release=true

gh run list \
  --repo 777genius/agent-teams-ai \
  --workflow release.yml \
  --limit 3

gh run watch <RUN_ID> --repo 777genius/agent-teams-ai
```

Do not use GitHub's **Publish release** button, `gh release edit --draft=false`,
or any other direct draft-to-public action. Those paths bypass the
`upload-stable-links` job. That job uploads the stable aliases and canonical
updater feeds before making the release public.

After the publish workflow finishes, run this required fail-fast gate. Replace
`v<VERSION>` with the exact tag that was published:

```bash
RELEASE_REPOSITORY=777genius/agent-teams-ai \
RELEASE_TAG=v<VERSION> \
  bash scripts/ci/verify-published-updater-release.sh
```

Do not rely only on the overall workflow conclusion. A draft build can succeed
with `publish_release=false` while `upload-stable-links` is skipped. The gate
must exit successfully before announcing or closing the release. It verifies
the public/latest state, updater skip markers, platform installers, feed
versions and references, and all latest download URLs.

#### Recovery: a draft was published directly or updater feeds are missing

Do not delete the public release and do not create a replacement version only
to repair its updater metadata. Rerun the workflow for the same tag with the
publication flag enabled:

```bash
gh workflow run release.yml \
  --repo 777genius/agent-teams-ai \
  --ref v<VERSION> \
  -f release_tag=v<VERSION> \
  -f publish_release=true

gh run list \
  --repo 777genius/agent-teams-ai \
  --workflow release.yml \
  --limit 3

gh run watch <RUN_ID> --repo 777genius/agent-teams-ai
```

The publication guard may already have returned the incomplete release to draft.
After the publish workflow succeeds, run the full fail-fast gate above. The
incident is not fixed until that gate passes.

### 6. Required release closeout gate

Do not publish or call a release finished until this is true:

- `runtime.lock.json` points at the runtime tag intended for this app release.
- `gh release view "$(node scripts/runtime-lock.mjs release-tag)" --repo "$(node scripts/runtime-lock.mjs release-repository)" --json assets -q '.assets[].name'` includes every file from `node scripts/runtime-lock.mjs asset-list`.
- `git -C /Users/belief/dev/projects/claude/agent_teams_orchestrator log --oneline "$(node scripts/runtime-lock.mjs source-ref)"..origin/main` has been reviewed. If it is non-empty, the skipped runtime commits are explicitly known to be irrelevant to the packaged app.
- The GitHub release body is not just auto-generated `Full Changelog`.
- The release body starts with short user-facing notes: what changed, why users care, and the most important fixes.
- The `Downloads` table from the template is present and every link points to the current `v<VERSION>` assets.
- The asset names in the notes match the assets uploaded by `release.yml`.
- For a draft handoff, `gh release view v<VERSION> --json body,assets,isDraft,isPrerelease,targetCommitish` confirms the release is still a draft, targets the intended commit, has current notes, and has the expected installer assets.
- For final publication, `gh release view v<VERSION> --json body,assets,isDraft,isPrerelease,targetCommitish` confirms the release is public, has current notes, targets the intended commit, and has the expected installer assets.
- The successful final `release.yml` run used `publish_release=true`, including a successful `upload-stable-links` job.
- The public release assets include `latest.yml`, `latest-linux.yml`, and `latest-mac.yml`.

If a draft was published before notes were written, immediately edit the public release body with `gh release edit`; do not leave a release with only generated notes.

## Release Notes Template

```markdown
<1-2 sentence summary of the release>

### What's New

- feat: <feature description>
- feat: <feature description>

### Improvements

- improve: <improvement description>

### Bug Fixes

- fix: <bug fix description>

### Downloads

<table>
<tr>
<td align="center">
  <a href="https://github.com/777genius/agent-teams-ai/releases/download/v<VERSION>/Agent.Teams.AI-<VERSION>-arm64.dmg">
    <img src="https://img.shields.io/badge/macOS_Apple_Silicon-.dmg-000000?style=for-the-badge&logo=apple&logoColor=white" alt="macOS Apple Silicon" />
  </a>
  <br />
  <a href="https://github.com/777genius/agent-teams-ai/releases/download/v<VERSION>/Agent.Teams.AI-<VERSION>-x64.dmg">
    <img src="https://img.shields.io/badge/macOS_Intel-.dmg-434343?style=for-the-badge&logo=apple&logoColor=white" alt="macOS Intel" />
  </a>
</td>
<td align="center">
  <a href="https://github.com/777genius/agent-teams-ai/releases/download/v<VERSION>/Agent.Teams.AI.Setup.<VERSION>.exe">
    <img src="https://img.shields.io/badge/Windows-Download_.exe-0078D4?style=for-the-badge&logo=windows&logoColor=white" alt="Windows" />
  </a>
  <br />
  <sub>May trigger SmartScreen - click "More info" then "Run anyway"</sub>
  <br />
  <sub>Run normally. Administrator mode may be needed only if the app reports a specific OpenCode symlink or permission error.</sub>
</td>
<td align="center">
  <a href="https://github.com/777genius/agent-teams-ai/releases/download/v<VERSION>/Agent.Teams.AI-<VERSION>.AppImage">
    <img src="https://img.shields.io/badge/Linux-Download_.AppImage-FCC624?style=for-the-badge&logo=linux&logoColor=black" alt="Linux AppImage" />
  </a>
  <br />
  <a href="https://github.com/777genius/agent-teams-ai/releases/download/v<VERSION>/agent-teams-ai_<VERSION>_amd64.deb">
    <img src="https://img.shields.io/badge/.deb-E95420?style=flat-square&logo=ubuntu&logoColor=white" alt=".deb" />
  </a>&nbsp;
  <a href="https://github.com/777genius/agent-teams-ai/releases/download/v<VERSION>/agent-teams-ai-<VERSION>.x86_64.rpm">
    <img src="https://img.shields.io/badge/.rpm-294172?style=flat-square&logo=redhat&logoColor=white" alt=".rpm" />
  </a>&nbsp;
  <a href="https://github.com/777genius/agent-teams-ai/releases/download/v<VERSION>/agent-teams-ai-<VERSION>.pacman">
    <img src="https://img.shields.io/badge/.pacman-1793D1?style=flat-square&logo=archlinux&logoColor=white" alt=".pacman" />
  </a>
</td>
</tr>
</table>
```

## Changelog Guidelines

Write changelog entries from the **user's perspective**, not the developer's.

Release notes must stay short, concrete, and user-facing. Do not include internal
maintenance details unless they directly change what users can do or clearly fix
a user-visible problem.

Avoid entries about:

- CI/lint/test gates, smoke tests, or validation infrastructure.
- README/docs cleanup, roadmap checkbox changes, or release-process polish.
- Runtime artifact internals, bundled runtime version numbers, stable aliases,
  compatibility aliases, or updater plumbing.
- Refactors, dependency bumps, or workflow changes without a user-visible effect.

If a change only made future releases, tests, packaging, or developer validation
more reliable, keep it out of the public notes or fold it into one concise
user-facing line only when it explains a real fix.

**Good:**

- "Add team member activity timeline with live status tracking"
- "Fix crash when opening sessions with corrupted JSONL data"
- "Improve session list loading speed by 3x with streaming parser"

**Bad:**

- "Refactor ChunkBuilder to use new pipeline"
- "Update dependencies"
- "Fix bug in useEffect cleanup"
- "Fix CI lint gate"
- "Stabilize provider smoke tests"
- "Update README install guidance"
- "Bundled runtime remains vX.Y.Z"
- "Compatibility aliases are still included"

Group entries by type: `What's New` > `Improvements` > `Bug Fixes` > `Breaking Changes` (if any).

## File Naming Convention

electron-builder generates these artifacts per platform:

| Platform        | Versioned Name                       | Stable Name (for /latest/download) | Compatibility Alias                |
| --------------- | ------------------------------------ | ---------------------------------- | ---------------------------------- |
| macOS arm64 DMG | `Agent.Teams.AI-<VER>-arm64.dmg`     | `Agent.Teams.AI-arm64.dmg`         | `Claude-Agent-Teams-UI-arm64.dmg`  |
| macOS x64 DMG   | `Agent.Teams.AI-<VER>-x64.dmg`       | `Agent.Teams.AI-x64.dmg`           | `Claude-Agent-Teams-UI-x64.dmg`    |
| macOS arm64 ZIP | `Agent.Teams.AI-<VER>-arm64-mac.zip` | -                                  | -                                  |
| macOS x64 ZIP   | `Agent.Teams.AI-<VER>-x64-mac.zip`   | -                                  | -                                  |
| Windows         | `Agent.Teams.AI.Setup.<VER>.exe`     | `Agent.Teams.AI.Setup.exe`         | `Claude-Agent-Teams-UI-Setup.exe`  |
| Linux AppImage  | `Agent.Teams.AI-<VER>.AppImage`      | `Agent.Teams.AI.AppImage`          | `Claude-Agent-Teams-UI.AppImage`   |
| Linux deb       | `agent-teams-ai_<VER>_amd64.deb`     | `agent-teams-ai-amd64.deb`         | `Claude-Agent-Teams-UI-amd64.deb`  |
| Linux rpm       | `agent-teams-ai-<VER>.x86_64.rpm`    | `agent-teams-ai-x86_64.rpm`        | `Claude-Agent-Teams-UI-x86_64.rpm` |
| Linux pacman    | `agent-teams-ai-<VER>.pacman`        | `agent-teams-ai.pacman`            | `Claude-Agent-Teams-UI.pacman`     |

## Stable Download Links

The `upload-stable-links` job in `release.yml` re-uploads key assets with version-agnostic names.
It starts only after **release-mac** (two matrix jobs), **release-win**, and **release-linux** all succeed, so it often stays in **Queued** until the slowest job finishes. Delays of several minutes are common when macOS hosted runners are backed up.

This enables permanent links in README that always point to the latest release:

```
https://github.com/777genius/agent-teams-ai/releases/latest/download/Agent.Teams.AI-arm64.dmg
```

GitHub automatically redirects `/releases/latest/download/FILENAME` to the asset from the most recent release. No README updates needed when releasing a new version.
The `Claude-Agent-Teams-UI-*` aliases are kept only for backward compatibility with older links and clients.

## macOS Code Signing

macOS builds are signed and notarized via GitHub Actions secrets:

| Secret                        | Description                                  |
| ----------------------------- | -------------------------------------------- |
| `CSC_LINK`                    | Base64-encoded .p12 certificate              |
| `CSC_KEY_PASSWORD`            | Certificate password                         |
| `APPLE_ID`                    | Apple Developer account email                |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific password from appleid.apple.com |
| `APPLE_TEAM_ID`               | Apple Developer Team ID                      |

Without these secrets, macOS builds will be unsigned (users need to bypass Gatekeeper manually).

## Auto-Update

The `publish_release=true` workflow publishes canonical updater metadata after
all platform assets are uploaded:

- `latest.yml` for Windows
- `latest-linux.yml` for Linux
- `latest-mac.yml` for macOS

`latest-mac.yml` includes both Apple Silicon and Intel assets. Draft workflows
do not upload updater metadata because draft releases are intentionally hidden
from the stable update channel.

Both the publish workflow and the independent `release.published` workflow run
the shared updater release guard. A stable release that is missing required
installers or feeds, contains an updater skip marker, declares the wrong feed
version, or has broken latest URLs is automatically returned to draft.

## Quick Reference

```bash
# Create a draft release
git tag v1.0.0
git push origin v1.0.0
gh workflow run release.yml --repo 777genius/agent-teams-ai --ref v1.0.0 \
  -f release_tag=v1.0.0 -f publish_release=false
# Wait for CI, review the assets, and update the draft notes

# Publish the reviewed draft and generate updater metadata
# Never publish the draft directly through GitHub UI or gh release edit.
gh workflow run release.yml --repo 777genius/agent-teams-ai --ref v1.0.0 \
  -f release_tag=v1.0.0 -f publish_release=true

# Watch the publish run, then run the required fail-fast gate from step 5.
# Do not announce or close the release until that gate passes.
RELEASE_REPOSITORY=777genius/agent-teams-ai RELEASE_TAG=v1.0.0 \
  bash scripts/ci/verify-published-updater-release.sh

# Delete a release (if needed)
gh release delete v1.0.0 --repo 777genius/agent-teams-ai --yes
git tag -d v1.0.0
git push origin :refs/tags/v1.0.0

# Check workflow status
gh run list --repo 777genius/agent-teams-ai --workflow release.yml --limit 3
```
