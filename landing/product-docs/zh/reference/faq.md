---
title: 常见问题 – Agent Teams 文档
description: 关于 Agent Teams 的常见问题——价格、模型访问、运行时、隐私、审查与故障排查。
lang: zh-Hans
---

# 常见问题

## Agent Teams 是免费的吗？

是的。该应用免费且开源。根据你使用的内容，提供方或运行时访问仍可能产生费用。

## Agent Teams 是否包含模型访问？

不包含。Agent Teams 是本地的编排与 UI 层。模型访问来自所选的运行时/提供方路径，例如 Claude Code、Codex 或 OpenCode。

## 支持哪些运行时？

支持的运行时路径为 Claude Code、Codex 和 OpenCode。当运行时暴露相应信息时，该应用还会跟踪提供方 id，例如 Anthropic、Codex 和 OpenCode。

## 我需要先安装 Claude Code 或 Codex 吗？

并非总是如此。该应用会从 UI 引导你完成运行时检测与设置。某些路径仍需要外部运行时认证。

OpenCode 的设置与 Claude Code 和 Codex 的设置是分开的。如果某次启动失败，请在修改团队 prompt 之前先检查运行时状态和提供方认证。

## 如何检查某个运行时是否就绪？

先在终端运行该运行时命令：

```bash
claude --version
codex --version
opencode --version
```

然后确认你所选路径的提供方认证。如果该命令或认证检查在 Agent Teams 之外失败，请先修复设置，再启动团队。

## 它会把我的代码上传到 Agent Teams 服务器吗？

不会。Agent Teams 不是云端代码同步服务。根据你所选的运行时，由提供方支持的模型调用可能会接收到 prompt 上下文。

## 团队文件存储在哪里？

团队协调数据本地存储在 `~/.claude/teams/<team>/`（macOS/Linux）或 `%APPDATA%\Claude\teams\<team>\`（Windows）下，任务文件存储在 `~/.claude/tasks/<team>/` 或 `%APPDATA%\Claude\tasks\<team>\` 下，项目会话数据在可用时存储在 `~/.claude/projects/<encoded-project>/` 下。

## 哪些内容会离开我的机器？

当某个智能体使用由提供方支持的模型时，prompt 上下文、所选文件内容、工具结果、命令输出、任务文本、评论以及附件可能会通过运行时/提供方路径离开你的机器。具体行为取决于运行时和提供方。

## 智能体之间可以互相沟通吗？

可以。智能体可以给队友发消息、在任务上评论、跨团队协调，并使用任务引用让对话与工作保持关联。

## 第一条团队 prompt 里应该写什么？

给 lead 一个具体的产出目标、文件或功能边界、风险限制以及验证预期。例如：

```text
Improve the docs quickstart. Keep edits inside landing/product-docs, add practical examples, and run `pnpm --dir landing docs:build` before marking work done.
```

## 我可以在接受代码之前先审查它吗？

可以。审查流程围绕任务范围的 diff 和代码块（hunk）级别的决策构建。

## 什么是 Agent Block？

Agent Block 是隐藏的、仅供智能体使用的文本，用诸如 `<info_for_agent>...</info_for_agent>` 这样的标记包裹。该应用会在面向用户的常规显示中将其剥离，但会保留它以供智能体协调使用。

## 什么是 solo 模式？

solo 模式是单智能体团队。它适用于较小的任务以及较低的协调开销。

## 我应该使用 worktree 隔离吗？

当多个 OpenCode 队友可能并行编辑同一个 Git 项目时，请使用它。它能减少文件冲突，但需要一个受 Git 跟踪的项目，并且目前仅适用于 OpenCode 成员。

## 不同的队友可以使用不同的提供方吗？

可以，当所选的运行时路径支持时，提供方/模型设置可以按团队成员分别携带。OpenCode 是实现广泛多提供方路由的主要路径。

## 为什么某个任务会显示 review 或 approved，而与 done 分开？

工作状态和审查状态相关但并不相同。一个任务可能从智能体的角度看已经 done，然后在 kanban UI 中经过 review 和审批流程。

## 启动卡住时我应该怎么做？

打开故障排查，收集启动诊断信息，检查 `~/.claude/teams/<team>/`，并在修改 prompt 之前验证运行时/提供方认证。

对于 OpenCode，请在认定某个队友已在线却忽略消息之前，先检查 lane/会话证据。

## 为什么不同运行时的日志各不相同？

Claude Code、Codex 和 OpenCode 暴露的转录格式和运行时证据各不相同。Agent Teams 会尽可能地将其规范化，但日志的完整性和归属可能因运行时而异。
