---
title: Agent Teams 文档 – 从本地桌面应用运行 AI 智能体团队
description: Agent Teams 的文档，这是一款用于编排 AI 智能体的免费桌面应用。创建团队、在看板上观察工作进展、审查代码变更，并协调 Claude、Codex、OpenCode 与多模型工作流。
lang: zh-Hans
layout: home
hero:
  name: Agent Teams 文档
  text: 从本地桌面应用运行 AI 智能体团队
  tagline: 创建团队、观察工作在看板上流转、审查代码变更，并协调 Claude、Codex、OpenCode 与多模型工作流，同时不放弃对本地的掌控。
  actions:
    - theme: brand
      text: 快速开始
      link: /zh/guide/quickstart
    - theme: alt
      text: 安装
      link: /zh/guide/installation
    - theme: alt
      text: 概念
      link: /zh/reference/concepts
features:
  - icon: '01'
    title: 团队优先的工作流
    details: 定义角色，启动一名 lead，让智能体拆分、认领并协调任务。
    link: /zh/guide/create-team
    linkText: 创建团队
  - icon: '02'
    title: 实时看板
    details: 在智能体工作时，观察任务在 todo、in progress、review、done 和 approved 之间流转。
    link: /zh/guide/agent-workflow
    linkText: 了解工作流
  - icon: '03'
    title: 内置代码审查
    details: 检查以任务为范围的 diff，接受或拒绝代码块（hunk），并在智能体需要指引时留下评论。
    link: /zh/guide/code-review
    linkText: 审查变更
  - icon: '04'
    title: 运行时感知的设置
    details: 通过你已有的访问权限，使用 Claude、Codex、OpenCode 或多模型提供方。
    link: /zh/guide/runtime-setup
    linkText: 配置运行时
  - icon: '05'
    title: 本地优先的掌控
    details: 该桌面应用读取本地项目与运行时状态。除非选定的提供方接收到提示词上下文，否则你的代码始终留在你的机器上。
    link: /zh/reference/privacy-local-data
    linkText: 隐私模型
  - icon: '06'
    title: 可调试的团队
    details: 当启动或任务卡住时，可追踪任务日志、运行时输出、队友消息以及运行中的进程。
    link: /zh/guide/troubleshooting
    linkText: 故障排查
---

<InstallBlock label="复制" copied-label="已复制" />

## 从这里开始

Agent Teams 是一款用于编排 AI 智能体团队的免费桌面应用。你不只是在向单个智能体发送孤立的提示词：你创建一个团队、分配角色，并观察智能体通过任务看板协调工作。

<DocsCardGrid />

## 启动后的下一步

创建第一个团队后，浏览这些指南以进一步深入：

- **运行时设置** - 配置 Claude、Codex、OpenCode 或多模型提供方：[配置运行时](/zh/guide/runtime-setup)
- **智能体工作流** - 了解智能体如何通过任务看板协调工作：[了解工作流](/zh/guide/agent-workflow)
- **团队简报示例** - 从真实世界的简报中学习提示词模式：[查看示例](/zh/guide/team-brief-examples)
- **代码审查** - 检查 diff，接受或拒绝变更：[审查变更](/zh/guide/code-review)
- **故障排查** - 诊断卡住的启动、缺失的队友以及任务失败：[故障排查](/zh/guide/troubleshooting)
- **Git 与 worktree 策略** - 当多名队友并行编辑同一仓库时，使用 worktree 隔离：[了解 worktree](/zh/guide/git-worktree-strategy)
- **发布说明** - 查看每个版本的新内容：[查看发布版本](/zh/reference/release-notes)

## 参考

当你需要准确的术语、提供方行为、贡献者架构或隐私边界时，请使用参考页面。

<DocsCardGrid type="reference" />

## 产品预览

<ZoomImage src="/screenshots/product-preview.png" alt="Agent Teams 看板" caption="任务状态、队友活动与审查工作流，全部集中在一个工作区中可见。" />
