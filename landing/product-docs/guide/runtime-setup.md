---
title: Runtime Setup – Agent Teams Docs
description: Configure Claude Code, Codex, or OpenCode runtimes. Covers auth, provider access, multimodel mode, and prelaunch checks.
---

# Runtime Setup

Agent Teams is a coordination layer. The actual model work runs through supported local runtimes and providers.

::: tip Quick start - choosing your first runtime
| If you ... | Start with |
| --- | --- |
| Already use Claude Code or have Anthropic access | **Claude** - familiar auth, minimal setup |
| Use Codex or OpenAI-based workflows | **Codex** - native integration |
| Want to try Agent Teams without signup or API keys | **OpenCode** - use the included free model with no auth |
| Want multi-model routing or broad provider coverage | **OpenCode** - most flexible, one config for many backends |
| Are not sure which runtime fits | **OpenCode** - covers the most provider options and lets you switch later |

Start with one runtime and one teammate. Confirm one launch works before expanding to multimodel.
:::

## Prerequisites

Before launching a team, make sure:

- The runtime binary is installed and on your `PATH`.
- Your provider account has active access to the model you intend to use, unless you start with the included free OpenCode model with no auth.
- The project path exists and is readable.
- The app and your terminal use the same home/config environment when you test auth manually.

::: tip
Start with a single teammate and one provider. Confirm one launch works before adding multimodel lanes.
:::

Quick terminal checks:

```bash
command -v claude
command -v codex
command -v opencode
```

Run the command for the runtime you plan to use. If it prints nothing, install the runtime or fix `PATH` before launching a team.

## Supported paths

| Path | Default CLI | Typical providers | Use when |
| --- | --- | --- | --- |
| Claude | `claude` | Anthropic | You already use Claude Code or Anthropic-backed workflows |
| Codex | `codex` | OpenAI | You want Codex-native runtime integration |
| OpenCode | `opencode` | OpenRouter and many backends | You want multimodel routing and broad provider coverage |

The app detects supported runtimes and guides setup from the UI when possible.


## Provider access

Agent Teams has no paid tier of its own. You can start with the included free OpenCode model with no auth - no registration, API keys, or credit card. For additional models, bring the provider access you already have: subscriptions, local runtime auth, or API keys depending on the path you choose.

- **Claude** and **Codex** paths rely on their respective CLI auth tools.
- **OpenCode** can run the included free model with no auth first. Other OpenCode models may need provider-specific API keys in a config file (e.g., `openrouter`, `openai`, `anthropic`).

## Auth configuration

### Claude Code

Run the standard auth flow in a terminal:

```bash
claude login
```

Then verify the CLI is reachable:

```bash
claude --version
```

If the packaged app reports "not logged in" while your terminal works, compare the `$HOME` and `PATH` seen by the app with the terminal you used for login. The auth diagnostic log described in [Troubleshooting](/guide/troubleshooting#auth-diagnostic-log) is the best starting point.

### Codex

Install and authenticate via OpenAI's CLI flow:

```bash
codex login
```

Then verify the runtime is reachable:

```bash
codex --version
```

Codex-native launches use Codex account state and model catalog data when available. If a model is missing from the UI, refresh provider status before editing team prompts.

### OpenCode

To use the included free model with no auth, select it in the app and launch without provider signup. To use other OpenCode backends, create or edit `~/.opencode/config.json` (or the equivalent path on your platform) with the provider key you want:

```json
{
  "providers": {
    "openrouter": {
      "apiKey": "sk-or-..."
    }
  }
}
```

Use the exact provider name that OpenCode expects. If you set a custom provider name, double-check it against the provider ID you use in the model string (for example `openrouter/moonshotai/kimi-k2.6` would use the `openrouter` block).

Example model strings:

| Model string | Provider block that must exist |
| --- | --- |
| `openrouter/moonshotai/kimi-k2.6` | `openrouter` |
| `openai/gpt-5.4` | `openai` |
| `anthropic/claude-sonnet-4-6` | `anthropic` |

If OpenCode launches but a teammate never becomes deliverable, inspect lane evidence before assuming the model ignored the prompt. See [Troubleshooting](/guide/troubleshooting#opencode-registered-but-bootstrap-unconfirmed).

## Multimodel mode

Multimodel mode can route work through many provider backends via OpenCode-compatible configuration. Use it when you need provider flexibility or want teammates to use different model lanes.

::: info Model lanes
Each teammate can use a different `providerId` + `model` pair. In the team edit UI, expand member options to override the global defaults.
:::

A conservative multimodel setup:

| Role | Provider | Why |
| --- | --- | --- |
| Lead | Claude or Codex | Keep coordination on the provider you trust most |
| Builder | OpenCode | Use broad model routing for implementation work |
| Reviewer | Claude, Codex, or a second OpenCode model | Separate review judgment from the builder lane |

Avoid mixing many unfamiliar providers in the first launch. Confirm one small task per lane before assigning broad work.

## Prelaunch checklist

Before launching a team:

1. The selected runtime is installed
2. The runtime binary is in the environment `PATH`
3. Provider auth is configured for the chosen backend
4. The provider has access to the exact model string you specify
5. The project path exists and is readable

## When to switch runtime paths

Switch when the current path is blocked by model availability, rate limits, provider capabilities, or team role needs. Keep the same project and team workflow, but validate one small task after switching.

::: warning Treat setup errors as setup problems
If auth fails, a model name is rejected, or the runtime binary cannot be found, fix the setup first. Do not change team prompts or project code to work around a runtime configuration issue.
:::

Use this decision table:

| Symptom | Better first action |
| --- | --- |
| Binary not found | Fix installation or `PATH` |
| Login works in terminal but not app | Check Electron auth diagnostic log and environment |
| Model rejected | Verify exact model id in the provider runtime |
| Repeated 429s | Lower concurrency or switch model/provider |
| OpenCode lane stuck | Inspect lane manifest and `opencode-sessions.json` |
