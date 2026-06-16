---
title: 开发者中心 – Agent Teams 文档
description: 面向贡献者和开发者的 Agent Teams 入口，涵盖架构、护栏、调试以及 MCP 扩展路径。
lang: zh-Hans
---

# 开发者中心

当你想要修改 Agent Teams 本身、调试团队启动，或用 MCP 工具扩展某个运行时，请使用本页。下面的链接指向仓库中的权威文档，使实现规则集中在一处。

## 从这里开始

| 需求 | 前往 |
| --- | --- |
| 仓库概览、脚本与源码设置 | [README.md](https://github.com/777genius/agent-teams-ai/blob/main/README.md) |
| 智能体导航与架构索引 | [AGENTS.md](https://github.com/777genius/agent-teams-ai/blob/main/AGENTS.md) |
| 面向智能体与贡献者的工作约定 | [CLAUDE.md](https://github.com/777genius/agent-teams-ai/blob/main/CLAUDE.md) |
| 硬性实现护栏 | [AGENT_CRITICAL_GUARDRAILS.md](https://github.com/777genius/agent-teams-ai/blob/main/AGENT_CRITICAL_GUARDRAILS.md) |
| 中型与大型功能的结构 | [功能架构标准](https://github.com/777genius/agent-teams-ai/blob/main/docs/FEATURE_ARCHITECTURE_STANDARD.md) |
| 启动、引导与队友消息传递的调试 | [智能体团队调试手册](https://github.com/777genius/agent-teams-ai/blob/main/docs/team-management/debugging-agent-teams.md) |
| 贡献流程 | [贡献指南](https://github.com/777genius/agent-teams-ai/blob/main/.github/CONTRIBUTING.md) |
| 发布说明 / 更新日志 | [RELEASE.md](https://github.com/777genius/agent-teams-ai/blob/main/docs/RELEASE.md) — [CHANGELOG.md](https://github.com/777genius/agent-teams-ai/blob/main/docs/CHANGELOG.md) |

## 本地开发路径

运行桌面端 Electron 应用进行常规开发：

```bash
pnpm install
pnpm dev
```

浏览器/网页路径并不能替代桌面端运行时。桌面模式是受支持的本地路径，因为它包含 IPC、终端、提供方鉴权、团队生命周期处理、启动诊断，以及真实团队所使用的运行时桥接。

## 架构检查点

在修改某个功能之前，先确定它的边界：

| 区域 | 预期归属 |
| --- | --- |
| 中型或大型产品功能 | `src/features/<feature-name>/` |
| Electron 主进程编排 | `src/main/` |
| Preload 安全 API 层 | `src/preload/` |
| 渲染器 UI 与应用状态 | `src/renderer/` |
| 共享类型与纯工具函数 | `src/shared/` |
| Agent Teams 看板 MCP 服务器 | `mcp-server/` |
| 看板数据控制器 | `agent-teams-controller/` |

使用 `src/features/recent-projects` 作为功能组织的参考切片。保持跨进程契约的显式化，并避免跨功能边界进行深层导入。

## 调试路径

针对启动挂起、OpenCode 的 `registered` / 引导未确认状态、队友回复缺失，或可疑的任务日志：

1. 从[调试手册](https://github.com/777genius/agent-teams-ai/blob/main/docs/team-management/debugging-agent-teams.md)开始。
2. 检查 `~/.claude/teams/<team>/launch-failure-artifacts/latest.json` 下最新的产物包。
3. 打开产物中的 `manifest.json`，检查 `classification`、引导面包屑、启动诊断、成员 spawn 状态以及经过脱敏的日志末尾片段。
4. 仅清理你能确认归属于本次冒烟测试或失败启动的团队、运行、面板或进程。

## MCP 开发路径

Agent Teams 使用一个名为 `agent-teams` 的内置 MCP 服务器进行看板操作。用户级和项目级的 MCP 服务器可以为运行时添加外部能力。设置示例、`.mcp.json` 结构以及工具注册指引，参见 [MCP 集成](/zh/guide/mcp-integration)。

## 相关文档

- [贡献者架构](/zh/reference/contributor-architecture)
- [运行时设置](/zh/guide/runtime-setup)
- [MCP 集成](/zh/guide/mcp-integration)
- [故障排查](/zh/guide/troubleshooting)
