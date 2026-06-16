---
title: 快速开始 – Agent Teams 文档
description: 在几分钟内，从全新安装到运行起一个 AI 智能体团队。涵盖安装、运行时选择、团队创建以及首次代码审查。
lang: zh-Hans
---

# 快速开始

本指南帮助你在几分钟内，从全新安装到运行起一个团队。

## 最短路径

```bash
# 1. Install prerequisites
node --version    # need 20+
pnpm --version    # need 10+

# 2. Clone and install
git clone https://github.com/777genius/agent-teams-ai.git
cd agent-teams-ai
pnpm install

# 3. Start the desktop app (default workflow)
pnpm dev

# 4. Verify a docs-only change
pnpm --dir landing docs:build
```

桌面端 Electron 应用（`pnpm dev`）是首要目标——常规开发中请勿使用浏览器/Web 开发服务器。浏览器路径缺少桌面端 IPC、终端、提供方认证以及团队生命周期行为。

## 开始之前

你需要：

- **一台计算机**，运行 macOS、Windows 或 Linux
- **（推荐）一个由 Git 跟踪的项目**——worktree 隔离与 diff 审查都依赖 Git
- **（可选）提供方访问权限**——运行时设置会从 UI 中检测可用的提供方，但某些路径需要已有的认证（Anthropic、OpenAI 等）

如果下面的某个步骤无法奏效，请查阅[故障排查指南](/zh/guide/troubleshooting#team-does-not-launch)以获取常见修复方法。

关于项目约定与架构指引，在做出改动之前请先参考以下规范文件：

- [AGENTS.md](https://github.com/777genius/agent-teams-ai/blob/main/AGENTS.md) — 仓库导航与架构指引
- [CLAUDE.md](https://github.com/777genius/agent-teams-ai/blob/main/CLAUDE.md) — 工作约定与项目规则
- [功能架构标准](https://github.com/777genius/agent-teams-ai/blob/main/docs/FEATURE_ARCHITECTURE_STANDARD.md) — 新功能的结构
- [调试操作手册](https://github.com/777genius/agent-teams-ai/blob/main/docs/team-management/debugging-agent-teams.md) — 启动与队友诊断

## 1. 从源码运行或下载

**下载已打包的应用**（适用于 macOS、Windows 或 Linux），请前往<a href="/zh/download/" target="_self">下载页面</a>——无需任何前置条件。你可以从免费模型开始、无需认证，或在需要更多模型时从 UI 连接提供方认证。

**或从源码运行**以进行开发：

需要 Node.js 24.16.0 LTS 和 pnpm 10+。在 macOS 上，官方 Node.js 24 预编译二进制文件要求 macOS 13.5+。

```bash
git clone https://github.com/777genius/agent-teams-ai.git
cd agent-teams-ai
pnpm install
pnpm dev
```

`pnpm dev` 会启动支持热重载的桌面端 Electron 应用。这是默认的开发目标。常规开发中请勿启动浏览器 Web 开发服务器——浏览器路径缺少完整的桌面端 IPC、终端、提供方认证以及团队生命周期行为。

## 2. 打开或创建一个项目

启动应用，并选择你希望智能体在其中工作的项目目录。Agent Teams 会读取本地项目文件以及运行时/会话状态，以便 UI 能够展示任务、日志、diff 以及队友活动。

::: tip
选择一个由 Git 跟踪的项目以获得最佳体验。worktree 隔离与基于 diff 的审查都依赖 Git。
:::

在启动团队之前，请检查项目是否有一个足够干净的基线：

```bash
git status --short
```

你不需要一个完全干净的工作树，但在智能体开始编辑之前，你应当清楚哪些改动是你自己的。这能让任务 diff 与代码块（hunk）级别的审查更值得信赖。

## 3. 选择运行时路径

设置流程会自动检测你机器上已安装的运行时。常见的首次设置是：

| 运行时  | 适用于                                        |
| -------- | ----------------------------------------------- |
| Claude   | Claude Code 用户以及已有 Anthropic 访问权限的人 |
| Codex    | Codex 原生工作流以及 OpenAI 访问权限        |
| OpenCode | 免费模型、无需认证，多模型团队，以及众多提供方后端 |

::: info
Gemini 作为受支持的提供方路径提供。有关认证选项以及当前提供方状态，请参阅[提供方与运行时](/zh/reference/providers-runtimes)。
:::

有关每个提供方的详细配置，请参阅[运行时设置](/zh/guide/runtime-setup)。

要在应用之外验证一个付费或基于账户的运行时，请检查二进制文件并测试认证：

```bash
# Check that the runtime is installed and on PATH
command -v claude && claude --version
command -v codex && codex --version
command -v opencode && opencode --version
```

如果命令失败，请先修复运行时安装或 `PATH`。对于需要认证的模型，团队提示无法绕过缺失的二进制文件或缺失的提供方认证。

::: tip
如果找到了二进制文件但应用报告 "not logged in"，那么你的终端与应用之间的环境可能不同。请参阅[认证诊断日志](/zh/guide/troubleshooting#auth-diagnostic-log)来对比二者。
:::

## 4. 创建你的第一个团队

创建一个包含一个 lead 和一个或多个专家的团队。第一个团队请保持精简：一个 lead、一个实现智能体以及一个偏向审查的智能体，足以验证整个工作流。

有关推荐的结构与提示，请参阅[创建团队](/zh/guide/create-team)。

对于首次启动，建议采用如下这样的团队结构：

| 成员 | 职责 | 备注 |
| --- | --- | --- |
| Lead | 将目标拆分为任务并协调状态 | 部署在你拥有的最可靠的提供方上 |
| Builder | 实现有明确边界的任务 | 给出清晰的文件或功能边界 |
| Reviewer | 审查已完成的工作 | 让它专注于回归问题以及缺失的测试 |

避免一开始就配置五个或更多队友。更多的智能体会在你确认设置是否健康之前，增加并发、日志、提供方用量以及冲突风险。

## 5. 给 lead 一个具体的目标

像给一位工程负责人做简报那样写下目标：

```text
Improve the onboarding flow. Split the work into tasks, keep changes small, and ask for review before broad refactors.
```

好的首个提示应包含具体的范围、安全边界以及验证：

```text
Improve the docs quickstart. Keep edits inside landing/product-docs. Add practical examples, preserve existing VitePress syntax, and run `pnpm --dir landing docs:build` before marking tasks done.
```

在首次运行时，请避免诸如 "make the app better" 这样含糊的提示。lead 能够拆解大型目标，但更好的输入会产生更小的任务以及更整洁的审查。

::: tip
如果团队已启动但没有任务出现，请检查 lead 是否收到了你的提示。有关诊断，请参阅[智能体回复缺失](/zh/guide/troubleshooting#agent-replies-are-missing)。
:::

lead 会创建任务、分配工作并协调队友。你可以在 kanban 看板上观察进度，并随时通过评论或直接消息进行干预。

## 6. 审查结果

打开已完成或可供审查（review）的任务，检查 diff，并对单个改动进行接受、拒绝或评论。当你需要理解智能体为何做出某个选择时，可使用任务日志。

有关完整的审查工作流，请参阅[代码审查](/zh/guide/code-review)。

在批准第一个任务之前，请检查三件事：

1. 任务评论解释了改动了什么
2. 改动的文件与任务范围相符
3. 验证结果在任务评论或日志中可见

## 常见陷阱

| 症状 | 可能的原因 | 检查 |
| --- | --- | --- |
| 应用未检测到运行时 | 二进制文件不在 `PATH` 上，或应用与终端看到的环境不同 | 在终端中运行 `command -v <runtime>`，然后使用相同的终端环境来启动应用 |
| 团队启动卡住 | 付费/账户模型缺少提供方认证、模型字符串错误，或找不到运行时二进制文件 | 参阅[故障排查](/zh/guide/troubleshooting#team-does-not-launch) |
| OpenCode lane 卡在 `registered` | lane 证据尚未提交，或模型字符串不匹配 | 检查 `~/.claude/teams/<team>/.opencode-runtime/lanes/` |
| 智能体回复缺失 | 运行时投递重试、解析或任务归属问题 | 打开任务日志并检查投递账本 |
| 提供方返回 429 | 达到速率限制 | 等待重置，或切换模型/提供方 |

## 后续步骤

- [创建团队](/zh/guide/create-team) — 推荐的团队结构与简报写法
- [运行时设置](/zh/guide/runtime-setup) — 提供方认证与模型选择
- [代码审查](/zh/guide/code-review) — 审查、批准或请求修改

### 面向贡献者

如果你正在修改 Agent Teams 或这些文档，请从仓库根目录的规范项目文件开始：

- [CLAUDE.md](https://github.com/777genius/agent-teams-ai/blob/main/CLAUDE.md) — 工作约定与项目规则
- [AGENTS.md](https://github.com/777genius/agent-teams-ai/blob/main/AGENTS.md) — 架构与实现指引的导航层
- [AGENT_CRITICAL_GUARDRAILS.md](https://github.com/777genius/agent-teams-ai/blob/main/AGENT_CRITICAL_GUARDRAILS.md) — 硬性实现护栏
- [功能架构标准](https://github.com/777genius/agent-teams-ai/blob/main/docs/FEATURE_ARCHITECTURE_STANDARD.md) — 新功能的结构
- [智能体团队调试操作手册](https://github.com/777genius/agent-teams-ai/blob/main/docs/team-management/debugging-agent-teams.md) — 启动、引导（bootstrap）与队友诊断

要验证此文档站点是否正确构建：

```bash
pnpm --dir landing docs:build
```
