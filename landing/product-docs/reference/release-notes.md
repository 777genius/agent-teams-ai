---
title: Release Notes – Agent Teams Docs
description: Release notes and changelog for Agent Teams. Links to the canonical RELEASE.md and CHANGELOG.md for full details.
---

# Release Notes

Current release: **v1.2.0** (2026-03-31). Active development continues on the `main` branch with unreleased changes for member work-sync, OpenCode delivery hardening, and CI stabilization.

## How releases work

Agent Teams follows [Semantic Versioning](https://semver.org/). Tags pushed to the repository trigger an automated [release workflow](https://github.com/777genius/agent-teams-ai/blob/main/docs/RELEASE.md) that builds signed packages for macOS, Windows, and Linux, then publishes them to GitHub Releases.

## Recent releases

### v1.2.0 — Agent Graph, per-team tool approval, interactive AskUserQuestion

Agent Graph with force-directed visualization and kanban task layout, per-team tool approval controls with readable permission prompts, task comment notifications, and interactive AskUserQuestion buttons. Permission system overhaul with Write/Edit/NotebookEdit seeding and MCP tool catalog integration. See [full changelog](https://github.com/777genius/agent-teams-ai/blob/main/docs/CHANGELOG.md#120---2026-03-31).

### v1.1.0 — React 19 + Electron 40, user-initiated task starts

React 19 + Electron 40 migration, user-initiated task starts from the kanban board, auth troubleshooting guide, syntax highlighting for R/Ruby/PHP/SQL, 3x faster transcript search, WSL/Windows path fixes, and XSS vulnerability fix. See [full changelog](https://github.com/777genius/agent-teams-ai/blob/main/docs/CHANGELOG.md#110---2026-03-25).

### v1.0.0 — Initial public release

First stable build: CLI/auth reliability in packaged apps, IPC hardening, cross-platform packaging with signed macOS builds, open-source governance docs (LICENSE, CONTRIBUTING, CODE_OF_CONDUCT, SECURITY). See [full changelog](https://github.com/777genius/agent-teams-ai/blob/main/docs/CHANGELOG.md#100---2026-03-23).

## Canonical sources

| Document | Description |
| --- | --- |
| [RELEASE.md](https://github.com/777genius/agent-teams-ai/blob/main/docs/RELEASE.md) | Release process, versioning guide, artifact naming, auto-update setup, and release notes template. |
| [CHANGELOG.md](https://github.com/777genius/agent-teams-ai/blob/main/docs/CHANGELOG.md) | Full changelog with all versions, features, improvements, and bug fixes from the user perspective. |
| [GitHub Releases](https://github.com/777genius/agent-teams-ai/releases) | Downloadable installers for all platforms. |

## Related pages

- [Installation](/guide/installation)
- [Quickstart](/guide/quickstart)
- [Contributor architecture](/reference/contributor-architecture)
- [Developers](/developers/)
