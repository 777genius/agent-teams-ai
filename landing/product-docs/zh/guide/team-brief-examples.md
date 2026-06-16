---
title: 团队简报示例 – Agent Teams 文档
description: 适用于小修复、文档工作、实现任务、审查以及高风险区域的实用团队简报模板。
lang: zh-Hans
---

# 团队简报示例

一份好的团队简报会给 lead 提供足够的结构，使其能够创建小任务，而无需在一开始就强行规定每一个实现细节。

使用如下结构：

```text
Outcome:
Scope:
Boundaries:
Coordination:
Verification:
Review:
```

## 最小化简报

适用于小型、低风险的工作。

```text
Outcome: Improve the quickstart so a new user can launch one team successfully.
Scope: Keep edits inside landing/product-docs.
Boundaries: Do not rewrite the whole docs structure.
Coordination: Create one or two tasks, keep comments on the task.
Verification: Run `pnpm --dir landing docs:build`.
Review: Summarize changed pages and any remaining gaps.
```

## 实现简报

当代码改动只涉及某一个功能区域时使用。

```text
Outcome: Add a focused improvement to task comment filtering.
Scope: Work inside the task/comment feature files unless a shared helper is clearly needed.
Boundaries: Do not change task storage format or review state semantics.
Coordination: Split parser, UI, and tests into separate tasks if they can be reviewed independently.
Verification: Run the focused unit tests first, then the feature typecheck if touched.
Review: Call out parsing edge cases and any behavior that affects existing task comments.
```

## 文档简报

适用于文档与指南类工作。

```text
Outcome: Draft practical workflow guides from the docs audit.
Scope: Add concise VitePress pages under landing/product-docs/guide.
Boundaries: Avoid moving existing navigation hubs owned by other tasks.
Coordination: Check related docs tasks before editing nav.
Verification: Run `pnpm --dir landing docs:build`.
Review: Include links added to sidebar and any pages intentionally left as drafts.
```

## 偏重审查的简报

适用于风险较高的区域，例如 IPC、提供方鉴权、持久化、Git 或任务生命周期逻辑。

```text
Outcome: Fix the launch failure without changing successful launch behavior.
Scope: Start from the newest launch-failure artifact and the affected runtime adapter.
Boundaries: Do not change provider prompts until setup and runtime evidence are inspected.
Coordination: Make one diagnostic task and one fix task if the cause is confirmed.
Verification: Run focused tests and one desktop smoke check when practical.
Review: Lead must inspect the diff before approval.
```

## 混合提供方简报

当不同队友运行不同的提供方/模型通道时使用。

```text
Outcome: Implement and review a small feature using separate builder and reviewer lanes.
Scope: Builder edits the feature. Reviewer inspects only the task diff and tests.
Boundaries: Do not switch model ids mid-task unless launch fails before work begins.
Coordination: Builder posts result comment first. Reviewer posts findings as task comments.
Verification: Builder runs focused tests. Reviewer checks failure output and changed scope.
Review: Lead approves only after reviewer comments are resolved.
```

## 简报中的 agent block

agent block 是仅供智能体阅读的隐藏文本，使用诸如 `<info_for_agent>...</info_for_agent>` 这样的标记包裹。应用会将它们从常规显示中剥离，但仍保留下来供智能体协调使用。当简报需要向智能体传达某些对人类读者而言属于干扰信息的内容时，可以使用它们。

示例——一份简报告诉 lead 如何拆分工作，同时又不向用户暴露协调指令：

```text
Outcome: Add a dark mode toggle to the application settings.
Scope: Settings UI, theme context, and CSS variables.
Boundaries: Do not change existing light theme values or provider auth screens.

<info_for_agent>
Split this into three tasks: (1) theme context and CSS vars, (2) toggle component and settings wiring, (3) dark mode preview in existing docs screenshots if practical.
</info_for_agent>
```

该 block 让面向人类的简报保持简洁，同时为 lead 提供结构化的任务拆分指引。

## 应避免的做法

| 薄弱的简报 | 更好的替代写法 |
| --- | --- |
| “Improve the app” | 指明工作流、文件以及成功检查 |
| “Fix all docs” | 选定一个指南组和一条构建命令 |
| “Use the best model” | 指明提供方/模型选择，或让应用的默认设置保持不变 |
| “Refactor as needed” | 说明允许改动哪些模块 |
| “Make it production ready” | 定义审查、测试以及上线检查 |

## 启动前

在启动团队之前，请检查以下几点：

1. 简报指明了一个具体的成果。
2. 风险边界是明确的。
3. lead 能够把工作拆分成可审查的任务。
4. 在已知的情况下包含了验证命令。
5. 敏感区域在批准前需要经过审查。

如果简报仍然过于宽泛，可以先启动一个 solo 或小型团队，并要求它先产出一份任务计划，而不是直接实现。

## 相关指南

- [创建团队](/zh/guide/create-team)
- [MCP 集成](/zh/guide/mcp-integration)
- [Git 与 worktree 策略](/zh/guide/git-worktree-strategy)
