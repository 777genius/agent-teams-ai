---
title: Installation – Agent Teams Docs
description: Download and install Agent Teams for macOS, Windows, or Linux. Covers packaged builds, source setup, auto-updates, and requirements.
---

# Installation

Agent Teams is distributed as a desktop app for macOS, Windows, and Linux.

::: tip Shortest path
1. Download the build for your platform below
2. Launch the app — it detects runtimes and guides provider auth from the UI
3. Start the [quickstart](/guide/quickstart) to create your first team

Desktop app startup: run `pnpm dev` for the Electron app. Do not start the browser/web dev mode for normal use.
:::

## Download builds

Use the <a href="/download/" target="_self">download page</a> or the latest [GitHub release](https://github.com/777genius/agent-teams-ai/releases) when you want the packaged app:

- macOS Apple Silicon: `.dmg`
- macOS Intel: `.dmg`
- Windows: `.exe`
- Linux: `.AppImage`, `.deb`, `.rpm`, or `.pacman`

::: warning Windows SmartScreen
Unsigned or newly published open-source apps can trigger SmartScreen. If you trust the release source, choose **More info** and then **Run anyway**.
:::

## Requirements

The packaged app is designed for zero-setup onboarding. It guides you through runtime detection and provider authentication from the UI — no manual CLI configuration needed.

To use agent runtimes, you need access to at least one provider:

| Provider           | Access method                                     |
| ------------------ | ------------------------------------------------- |
| Claude (Anthropic) | Claude Code CLI login or API key                  |
| Codex (OpenAI)     | Codex CLI login or API key                        |
| Gemini (Google)    | Google ADC, Gemini CLI, or API key                |
| OpenCode           | API key for a supported backend (e.g. OpenRouter) |

::: info
Gemini is available as a supported provider path. See [Providers and runtimes](/reference/providers-runtimes) for auth options and current status across all providers.
:::

For source development, you also need:

| Tool    | Version |
| ------- | ------- |
| Node.js | 20+     |
| pnpm    | 10+     |

## Run from source

<InstallBlock command="git clone https://github.com/777genius/agent-teams-ai.git && cd agent-teams-ai && pnpm install && pnpm dev" />

```bash
git clone https://github.com/777genius/agent-teams-ai.git
cd agent-teams-ai
pnpm install
pnpm dev
```

`pnpm dev` starts the desktop Electron app with hot reload. This is the default development target — do not start a browser web dev server for normal development. The browser path lacks the full desktop IPC, terminal, provider auth, and team lifecycle behavior.

The `main` branch carries the latest stable development. Switch to feature branches only if you need a specific unreleased change.

## Verify the setup

After installing, confirm the build is healthy:

```bash
# Check that the desktop app compiles and starts
pnpm typecheck

# Verify the VitePress documentation site builds
pnpm --dir landing docs:build
```

If `pnpm typecheck` reports type errors, check for a newer version of dependencies or pinned TypeScript. If `pnpm --dir landing docs:build` fails, inspect `landing/product-docs/` for syntax errors in markdown or config.

If you are editing these docs, run the build to verify your changes:

```bash
pnpm --dir landing docs:build
```

## Auto-updates

The packaged app checks for updates automatically on launch and periodically while running. When an update is available, the app prompts you to download and install it. You can also check manually from the app menu.

::: tip
Auto-updates are not available when running from source. Pull the latest changes and rerun `pnpm install` when dependencies change.
:::

## Updating from source

If you run from source, pull the `main` branch and rerun install when dependencies change:

```bash
git pull
pnpm install
```

After updating, verify the build and docs:

```bash
pnpm typecheck
pnpm --dir landing docs:build
```

Always use `pnpm dev` (Electron) — not the browser dev server — for normal development.

## Next steps

- [Quickstart](/guide/quickstart) — from install to first running team
- [Runtime setup](/guide/runtime-setup) — provider auth and model selection per runtime
- [Create a team](/guide/create-team) — recommended team shapes and brief writing

### For contributors

- [AGENTS.md](https://github.com/777genius/agent-teams-ai/blob/main/AGENTS.md) — repo navigation and architecture pointers
- [CLAUDE.md](https://github.com/777genius/agent-teams-ai/blob/main/CLAUDE.md) — working conventions and project rules
- [AGENT_CRITICAL_GUARDRAILS.md](https://github.com/777genius/agent-teams-ai/blob/main/AGENT_CRITICAL_GUARDRAILS.md) — hard implementation guardrails
