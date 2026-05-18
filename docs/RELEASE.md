# Release Guide

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
  <sub>May trigger SmartScreen — click "More info" → "Run anyway"</sub>
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
| MAJOR | Breaking changes, major UI overhaul, incompatible data format changes | 1.0.0 → 2.0.0 |
| MINOR | New features, new panels/views, new integrations                      | 1.0.0 → 1.1.0 |
| PATCH | Bug fixes, performance improvements, small UI tweaks                  | 1.0.0 → 1.0.1 |

## Release Process

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

### 2. Create tag and push

```bash
git tag v<VERSION>
git push origin v<VERSION>
```

This triggers the `release.yml` GitHub Actions workflow which:

- Builds the app (ubuntu)
- Packages macOS arm64 + x64 (with code signing & notarization)
- Packages Windows (NSIS installer)
- Packages Linux (AppImage, deb, rpm, pacman)
- Creates a GitHub Release with all artifacts

### 3. Update release notes

After the workflow completes, edit the release notes:

```bash
gh release edit v<VERSION> --repo 777genius/agent-teams-ai --notes "$(cat <<'EOF'
<paste release notes here>
EOF
)"
```

## Release Notes Template

```markdown
## Agent Teams v<VERSION>

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
  <sub>May trigger SmartScreen — click "More info" → "Run anyway"</sub>
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

**Good:**

- "Add team member activity timeline with live status tracking"
- "Fix crash when opening sessions with corrupted JSONL data"
- "Improve session list loading speed by 3x with streaming parser"

**Bad:**

- "Refactor ChunkBuilder to use new pipeline"
- "Update dependencies"
- "Fix bug in useEffect cleanup"

Group entries by type: `What's New` > `Improvements` > `Bug Fixes` > `Breaking Changes` (if any).

## File Naming Convention

electron-builder generates these artifacts per platform:

| Platform        | Versioned Name                       | Stable Name (for /latest/download) |
| --------------- | ------------------------------------ | ---------------------------------- |
| macOS arm64 DMG | `Agent.Teams.AI-<VER>-arm64.dmg`     | `Claude-Agent-Teams-UI-arm64.dmg`  |
| macOS x64 DMG   | `Agent.Teams.AI-<VER>-x64.dmg`       | `Claude-Agent-Teams-UI-x64.dmg`    |
| macOS arm64 ZIP | `Agent.Teams.AI-<VER>-arm64-mac.zip` | -                                  |
| macOS x64 ZIP   | `Agent.Teams.AI-<VER>-x64-mac.zip`   | -                                  |
| Windows         | `Agent.Teams.AI.Setup.<VER>.exe`     | `Claude-Agent-Teams-UI-Setup.exe`  |
| Linux AppImage  | `Agent.Teams.AI-<VER>.AppImage`      | `Claude-Agent-Teams-UI.AppImage`   |
| Linux deb       | `agent-teams-ai_<VER>_amd64.deb`     | `Claude-Agent-Teams-UI-amd64.deb`  |
| Linux rpm       | `agent-teams-ai-<VER>.x86_64.rpm`    | `Claude-Agent-Teams-UI-x86_64.rpm` |
| Linux pacman    | `agent-teams-ai-<VER>.pacman`        | `Claude-Agent-Teams-UI.pacman`     |

## Stable Download Links

The `upload-stable-links` job in `release.yml` re-uploads key assets with version-agnostic names.
It starts only after **release-mac** (two matrix jobs), **release-win**, and **release-linux** all succeed, so it often stays in **Queued** until the slowest job finishes. Delays of several minutes are common when macOS hosted runners are backed up.

This enables permanent links in README that always point to the latest release:

```
https://github.com/777genius/agent-teams-ai/releases/latest/download/Claude-Agent-Teams-UI-arm64.dmg
```

GitHub automatically redirects `/releases/latest/download/FILENAME` to the asset from the most recent release. No README updates needed when releasing a new version.

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

The release workflow publishes canonical updater metadata after all platform assets are uploaded:

- `latest.yml` for Windows
- `latest-linux.yml` for Linux
- `latest-mac.yml` for macOS

⚠️ `latest-mac.yml` is currently Apple Silicon first because `electron-updater` on GitHub releases still uses a single macOS metadata file. Intel Mac users keep manual download support, while automatic macOS updates stay aligned with the native arm64 build until we move to universal packaging or an arch-aware provider.

## Quick Reference

```bash
# Create and publish a release
git tag v1.0.0
git push origin v1.0.0
# Wait for CI to finish (~10 min), then update notes

# Delete a release (if needed)
gh release delete v1.0.0 --repo 777genius/agent-teams-ai --yes
git tag -d v1.0.0
git push origin :refs/tags/v1.0.0

# Check workflow status
gh run list --repo 777genius/agent-teams-ai --workflow release.yml --limit 3
```
