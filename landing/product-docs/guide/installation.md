---
title: Installation – Agent Teams Docs
description: Download and install Agent Teams for macOS, Windows, or Linux. Covers packaged builds, source setup, auto-updates, and requirements.
---

# Installation

Agent Teams is distributed as a desktop app for macOS, Windows, and Linux.

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

The `main` branch carries the latest stable development. Switch to feature branches only if you need a specific unreleased change.

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

## Next steps

- [Quickstart](/guide/quickstart) — from install to first running team
- [Runtime setup](/guide/runtime-setup) — provider auth and model selection per runtime
- [Create a team](/guide/create-team) — recommended team shapes and brief writing
