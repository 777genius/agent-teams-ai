---
title: 发布说明 – Agent Teams 文档
description: Agent Teams 的发布说明与变更日志。提供指向权威 RELEASE.md 与 CHANGELOG.md 的链接以获取完整细节。
lang: zh-Hans
---

# 发布说明

当前发布版本：**v1.2.0**（2026-03-31）。`main` 分支上仍在持续积极开发，包含尚未发布的成员工作同步、OpenCode 投递加固以及 CI 稳定性方面的改动。

## 发布机制

Agent Teams 遵循[语义化版本](https://semver.org/)。推送到仓库的标签会触发一个自动化的[发布工作流](https://github.com/777genius/agent-teams-ai/blob/main/docs/RELEASE.md)，该工作流会为 macOS、Windows 和 Linux 构建签名包，然后将它们发布到 GitHub Releases。

## 近期发布

### v1.2.0 — Agent Graph、按团队工具审批、交互式 AskUserQuestion

Agent Graph 提供力导向可视化与看板任务布局，按团队的工具审批控制并附带可读的权限提示，任务评论通知，以及交互式 AskUserQuestion 按钮。权限系统全面改造，加入 Write/Edit/NotebookEdit 预置以及 MCP 工具目录集成。参见[完整变更日志](https://github.com/777genius/agent-teams-ai/blob/main/docs/CHANGELOG.md#120---2026-03-31)。

### v1.1.0 — React 19 + Electron 40、用户发起的任务启动

迁移到 React 19 + Electron 40，从看板发起的用户启动任务，认证故障排查指南，针对 R/Ruby/PHP/SQL 的语法高亮，会话记录搜索速度提升 3 倍，WSL/Windows 路径修复，以及 XSS 漏洞修复。参见[完整变更日志](https://github.com/777genius/agent-teams-ai/blob/main/docs/CHANGELOG.md#110---2026-03-25)。

### v1.0.0 — 首个公开发布

首个稳定构建：打包应用中的 CLI/认证可靠性，IPC 加固，带签名 macOS 构建的跨平台打包，开源治理文档（LICENSE、CONTRIBUTING、CODE_OF_CONDUCT、SECURITY）。参见[完整变更日志](https://github.com/777genius/agent-teams-ai/blob/main/docs/CHANGELOG.md#100---2026-03-23)。

## 权威来源

| 文档 | 说明 |
| --- | --- |
| [RELEASE.md](https://github.com/777genius/agent-teams-ai/blob/main/docs/RELEASE.md) | 发布流程、版本管理指南、构件命名、自动更新设置以及发布说明模板。 |
| [CHANGELOG.md](https://github.com/777genius/agent-teams-ai/blob/main/docs/CHANGELOG.md) | 完整变更日志，从用户视角列出所有版本、功能、改进与缺陷修复。 |
| [GitHub Releases](https://github.com/777genius/agent-teams-ai/releases) | 适用于所有平台的可下载安装包。 |

## 相关页面

- [安装](/zh/guide/installation)
- [快速开始](/zh/guide/quickstart)
- [贡献者架构](/zh/reference/contributor-architecture)
- [开发者](/zh/developers/)
