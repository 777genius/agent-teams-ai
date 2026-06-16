---
title: 运行时设置 – Agent Teams 文档
description: 配置 Claude Code、Codex 或 OpenCode 运行时。涵盖认证、提供方访问、多模型模式以及启动前检查。
lang: zh-Hans
---

# 运行时设置

Agent Teams 是一个协调层。实际的模型工作通过受支持的本地运行时与提供方运行。

::: tip 快速开始 - 选择你的第一个运行时
| 如果你 …… | 从这里开始 |
| --- | --- |
| 已经使用 Claude Code 或拥有 Anthropic 访问权限 | **Claude** - 熟悉的认证方式，设置最少 |
| 使用 Codex 或基于 OpenAI 的工作流 | **Codex** - 原生集成 |
| 想在不注册、不使用 API key 的情况下试用 Agent Teams | **OpenCode** - 使用内置的免费模型，无需认证 |
| 想要多模型路由或广泛的提供方覆盖 | **OpenCode** - 最灵活，一份配置对应多个后端 |
| 不确定哪个运行时适合自己 | **OpenCode** - 覆盖最多的提供方选项，并允许你之后切换 |

先从一个运行时和一名队友开始。在扩展到多模型之前，先确认一次启动可以正常工作。
:::

## 前置条件

在启动团队之前，请确保：

- 运行时二进制文件已安装并位于你的 `PATH` 中。
- 你的提供方账户对你打算使用的模型拥有有效访问权限，除非你从内置的免费 OpenCode 模型开始（无需认证）。
- 项目路径存在且可读。
- 当你手动测试认证时，应用与你的终端使用相同的 home/config 环境。

::: tip
先从单个队友和一个提供方开始。在添加多模型通道之前，先确认一次启动可以正常工作。
:::

快速终端检查：

```bash
command -v claude
command -v codex
command -v opencode
```

为你计划使用的运行时运行对应的命令。如果它没有任何输出，请先安装该运行时或修复 `PATH`，然后再启动团队。

## 受支持的路径

| 路径 | 默认 CLI | 典型提供方 | 适用场景 |
| --- | --- | --- | --- |
| Claude | `claude` | Anthropic | 你已经使用 Claude Code 或基于 Anthropic 的工作流 |
| Codex | `codex` | OpenAI | 你想要 Codex 原生的运行时集成 |
| OpenCode | `opencode` | OpenRouter 以及许多后端 | 你想要多模型路由和广泛的提供方覆盖 |

应用会检测受支持的运行时，并在可能时从 UI 中引导你完成设置。

Gemini 作为受支持的提供方路径提供，支持 Google ADC（`gcloud auth`）、Gemini CLI OAuth 以及 API key 认证。当检测到 Gemini 后端时，可在运行时设置 UI 中进行配置。

## 提供方访问

Agent Teams 自身没有付费层级。你可以从内置的免费 OpenCode 模型开始，无需认证 - 无需注册、API key 或信用卡。对于额外的模型，请使用你已经拥有的提供方访问权限：订阅、本地运行时认证或 API key，具体取决于你选择的路径。

- **Claude** 和 **Codex** 路径依赖各自的 CLI 认证工具。
- **OpenCode** 可以先运行内置的免费模型，无需认证。其他 OpenCode 模型可能需要在配置文件中提供特定于提供方的 API key（例如 `openrouter`、`openai`、`anthropic`）。

## 认证配置

### Claude Code

在终端中运行标准认证流程：

```bash
claude login
```

然后验证 CLI 可访问：

```bash
claude --version
```

如果打包后的应用报告 "not logged in"，而你的终端却能正常工作，请将应用所看到的 `$HOME` 与 `PATH` 和你用于登录的终端进行对比。[故障排查](/zh/guide/troubleshooting#auth-diagnostic-log)中描述的认证诊断日志是最佳的排查起点。

### Codex

通过 OpenAI 的 CLI 流程安装并认证：

```bash
codex login
```

然后验证运行时可访问：

```bash
codex --version
```

Codex 原生启动在可用时会使用 Codex 账户状态和模型目录数据。如果某个模型未出现在 UI 中，请先刷新提供方状态，再编辑团队 prompt。

### OpenCode

要使用内置的免费模型且无需认证，请在应用中选择它，并在不进行提供方注册的情况下启动。要使用其他 OpenCode 后端，请创建或编辑 `~/.opencode/config.json`（或你所在平台上的等价路径），并填入你想要的提供方 key：

```json
{
  "providers": {
    "openrouter": {
      "apiKey": "sk-or-..."
    }
  }
}
```

请使用 OpenCode 期望的确切提供方名称。如果你设置了自定义的提供方名称，请仔细核对它与你在模型字符串中使用的提供方 ID（例如 `openrouter/moonshotai/kimi-k2.6` 会使用 `openrouter` 块）。

模型字符串示例：

| 模型字符串 | 必须存在的提供方块 |
| --- | --- |
| `openrouter/moonshotai/kimi-k2.6` | `openrouter` |
| `openai/gpt-5.4` | `openai` |
| `anthropic/claude-sonnet-4-6` | `anthropic` |

如果 OpenCode 启动了，但某个队友始终无法变为可送达状态，请在假定模型忽略了 prompt 之前先检查通道证据。参见[故障排查](/zh/guide/troubleshooting#opencode-registered-but-bootstrap-unconfirmed)。

### Gemini

Gemini 支持三种认证方法：

- **Google ADC** — 运行 `gcloud auth application-default login`，通过 Google 应用默认凭据进行认证。
- **Gemini CLI** — 如果已安装 Gemini CLI，运行 `gemini login`。
- **API key** — 在环境中设置 `GEMINI_API_KEY`，或通过应用的 Manage Providers UI 进行配置。

应用会自动检测可用的认证方法，并在后端可访问时，于运行时设置和团队创建 UI 中显示 Gemini 提供方。

## 多模型模式

多模型模式可以通过兼容 OpenCode 的配置将工作路由到许多提供方后端。当你需要提供方灵活性，或希望让队友使用不同的模型通道时，请使用它。

::: info 模型通道
每个队友都可以使用不同的 `providerId` + `model` 组合。在团队编辑 UI 中，展开成员选项即可覆盖全局默认值。
:::

一个保守的多模型设置：

| 角色 | 提供方 | 原因 |
| --- | --- | --- |
| Lead | Claude 或 Codex | 把协调工作放在你最信任的提供方上 |
| Builder | OpenCode | 为实现工作使用广泛的模型路由 |
| Reviewer | Claude、Codex 或第二个 OpenCode 模型 | 将审查判断与 builder 通道分开 |

避免在首次启动时混用许多不熟悉的提供方。在分配大量工作之前，先在每个通道上确认一个小任务。

## 启动前检查清单

在启动团队之前：

1. 已安装所选运行时
2. 运行时二进制文件位于环境 `PATH` 中
3. 已为所选后端配置提供方认证
4. 提供方对你指定的确切模型字符串拥有访问权限
5. 项目路径存在且可读

## 何时切换运行时路径

当当前路径因模型可用性、速率限制、提供方能力或团队角色需求而受阻时进行切换。保持相同的项目和团队工作流，但在切换后验证一个小任务。

::: warning 把设置错误当作设置问题来处理
如果认证失败、模型名称被拒绝，或找不到运行时二进制文件，请先修复设置。不要为了绕过运行时配置问题而修改团队 prompt 或项目代码。
:::

使用此决策表：

| 症状 | 更好的首要行动 |
| --- | --- |
| 找不到二进制文件 | 修复安装或 `PATH` |
| 终端中可以登录但应用中不行 | 检查 Electron 认证诊断日志和环境 |
| 模型被拒绝 | 在提供方运行时中验证确切的模型 id |
| 反复出现 429 | 降低并发数或切换模型/提供方 |
| OpenCode 通道卡住 | 检查通道清单和 `opencode-sessions.json` |
