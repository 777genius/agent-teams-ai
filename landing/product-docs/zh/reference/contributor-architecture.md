---
title: 贡献者架构 – Agent Teams 文档
description: 面向贡献者的指南，介绍功能布局、运行时/提供方边界、硬性护栏以及权威架构文档。
lang: zh-Hans
---

# 贡献者架构

本页是面向贡献者的导览图。它指向权威的仓库指引，而不是重述每一条实现规则。

## 权威来源

在修改应用时，请将以下文件作为唯一可信来源：

| 需求 | 权威来源 |
| --- | --- |
| 仓库概览与命令 | [README.md](https://github.com/777genius/agent-teams-ai/blob/main/README.md) |
| 本地协作约定 | [CLAUDE.md](https://github.com/777genius/agent-teams-ai/blob/main/CLAUDE.md) |
| 硬性护栏 | [AGENT_CRITICAL_GUARDRAILS.md](https://github.com/777genius/agent-teams-ai/blob/main/AGENT_CRITICAL_GUARDRAILS.md) |
| 中型与大型功能布局 | [docs/FEATURE_ARCHITECTURE_STANDARD.md](https://github.com/777genius/agent-teams-ai/blob/main/docs/FEATURE_ARCHITECTURE_STANDARD.md) |
| 智能体团队启动调试 | [docs/team-management/debugging-agent-teams.md](https://github.com/777genius/agent-teams-ai/blob/main/docs/team-management/debugging-agent-teams.md) |

## 功能布局

中型与大型功能应位于 `src/features/<feature-name>/` 下，并遵循功能架构标准。将功能内部细节隐藏在公共入口点之后，避免跨越功能边界的深层导入。

对于新的工作，请以现有的 `src/features/recent-projects` 切片作为本地参考实现来起步。当创建功能切片带来的结构开销大于其价值时，小修小补可以保留在现有代码路径附近。

## 运行时与提供方边界

Agent Teams 负责编排：团队、任务、消息、启动状态、审查界面、诊断以及本地持久化。

所选的运行时/提供方路径负责模型执行、认证、模型可用性、速率限制、工具语义以及运行时特定的会话记录证据。不要让 prompt 或 UI 状态去弥补缺失的认证、缺失的二进制文件、被拒绝的 model id 或提供方故障。关于面向用户的设置细节，请参阅 [提供方与运行时](/zh/reference/providers-runtimes)。

## 智能体团队调试

对于启动挂起、OpenCode `registered` / bootstrap 未确认状态、缺失的队友回复或可疑的任务日志，请从专门的调试运行手册开始。检查 `~/.claude/teams/<team>/launch-failure-artifacts/latest.json` 下最新的启动失败产物，然后将 UI 状态与持久化文件以及运行时特定的证据相互关联。

调试时避免大范围清理。仅停止你能确认属于该问题的进程、lane、团队或冒烟运行。

## 贡献者约定

- 在常规开发中，使用 `pnpm dev` 启动桌面 Electron 应用。
- 不要将浏览器开发模式当作桌面运行时、IPC、终端、提供方认证或团队生命周期行为的替代品。
- 将 Electron 的 main、preload、renderer、shared 与功能各自的职责分开。
- 使用 `wrapAgentBlock(text)` 处理仅供智能体使用的块，而不是手动拼接标记。
- 优先进行有针对性的验证。除非任务明确与格式化相关，否则避免大范围的 `lint:fix` 或格式变动。
- 将解析、任务生命周期、提供方/运行时检测、持久化、IPC、Git 以及审查流程视为高风险区域，它们需要有针对性的测试或清晰的验证路径。

## 相关页面

- [运行时设置](/zh/guide/runtime-setup)
- [故障排查](/zh/guide/troubleshooting)
- [代码审查](/zh/guide/code-review)
- [隐私与本地数据](/zh/reference/privacy-local-data)
