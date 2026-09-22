---
title: Git 与 worktree 策略 – Agent Teams 文档
description: 决定何时使用主 worktree、功能分支或 OpenCode worktree 隔离来进行并行智能体工作。
lang: zh-Hans
---

# Git 与 worktree 策略

Git 为 Agent Teams 提供了最强的审查路径：精简的 diff、分支可见性、任务范围内的变更，以及更安全的并行工作。

## 选择一种策略

| 策略 | 适用场景 | 取舍 |
| --- | --- | --- |
| 主 worktree | 单人工作、仅文档编辑，或一次只有一个队友 | 简单，但并行编辑可能发生冲突 |
| 功能分支 | 一个团队正在进行一项连贯的变更 | 审查目标清晰，但队友仍共享文件 |
| Worktree 隔离 | 多个 OpenCode 队友可能并行编辑同一个仓库 | 隔离性更好，但合并/审查需要更多纪律 |

从简单开始。当可能出现并行编辑时再加入 worktree 隔离，而不是因为每个任务都需要单独的检出（checkout）。

## 何时启用 worktree 隔离

在以下情况下为 OpenCode 队友启用它：

- 两个或更多队友可能同时编辑同一个仓库
- 某个任务可能运行格式化工具、代码生成器或大范围测试
- 你希望每个队友的分支和 diff 保持彼此独立
- lead 工作区是脏的（dirty），不应接收直接编辑

在以下情况下保持关闭：

- 任务是只读的
- 一个队友负责所有编辑
- 仓库未被 Git 跟踪
- 你需要一条不支持此隔离模式的运行时路径

::: warning
Worktree 隔离目前仅适用于 OpenCode 成员，并且要求项目被 Git 跟踪。
:::

## 分支卫生

在开始并行工作之前：

```bash
git status --short
git branch --show-current
```

尽可能使用干净的分支。如果主 worktree 已经有用户的改动，请告知智能体不要还原（revert）不相关的文件，并保持任务范围精简。

推荐的分支命名风格：

```text
agent/<team-or-task>/<short-purpose>
```

示例：

```text
agent/docs/mcp-guide
agent/review/task-log-filtering
agent/ui/code-review-polish
```

## 审查流程

对于隔离的 worktree，在将变更合并或应用回主工作区之前，先审查队友的 diff。

1. 确认任务结果评论中说明了变更范围和验证情况。
2. 在审查 UI 中检查任务 diff。
3. 如果 diff 触及了不相关的文件，则对该任务请求修改（request changes）。
4. 仅在测试或手动检查与任务风险相匹配后才批准（approve）。
5. 有意识地合并或应用变更。

不要仅仅因为任务已完成就自动合并 worktree 的产出。完成只意味着智能体认为这项工作已准备好接受审查。

## 冲突处理策略

针对并行团队，使用以下策略：

| 情形 | 操作 |
| --- | --- |
| 两个队友编辑同一个文件 | 暂停其中一个任务，或指定一个负责人来负责整合 |
| 生成的文件被大范围改动 | 要求附上一条评论，说明所用的生成器和命令 |
| 主 worktree 有不相关的改动 | 保留这些改动，仅审查任务所属的变更 |
| Worktree 分支出现分叉 | 在审查后手动 rebase 或 merge，而不要在一个含糊不清的智能体任务内部进行 |

## 任务提示词示例

```text
Implement the settings validation fix in your assigned worktree. Keep edits inside src/features/settings and focused tests. Do not touch provider auth or task storage. Post the test command and result before completing the task.
```

这条提示词之所以有效，是因为它指明了允许的区域、敏感的边界以及完成的证据。

## 相关指南

- [创建团队](/zh/guide/create-team)
- [代码审查](/zh/guide/code-review)
- [团队简报示例](/zh/guide/team-brief-examples)
- [运行时设置](/zh/guide/runtime-setup)
