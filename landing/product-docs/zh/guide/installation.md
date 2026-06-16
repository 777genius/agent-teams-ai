---
title: 安装 – Agent Teams 文档
description: 下载并在 macOS、Windows 或 Linux 上安装 Agent Teams。涵盖打包构建、源码设置、自动更新以及环境要求。
lang: zh-Hans
---

# 安装

Agent Teams 以桌面应用的形式分发，支持 macOS、Windows 和 Linux。

::: tip 最短路径
1. 在下方下载适合你平台的构建版本
2. 启动应用 - 先使用无需认证的免费模型，或从界面中连接提供方认证
3. 开始[快速开始](/zh/guide/quickstart)，创建你的第一个团队

桌面应用启动：运行 `pnpm dev` 来启动 Electron 应用。日常使用时请勿启动浏览器/网页开发模式。
:::

## 下载构建版本

当你需要打包好的应用时，请使用<a href="/zh/download/" target="_self">下载页面</a>或最新的 [GitHub release](https://github.com/777genius/agent-teams-ai/releases)：

- macOS Apple Silicon：`.dmg`
- macOS Intel：`.dmg`
- Windows：`.exe`
- Linux：`.AppImage`、`.deb`、`.rpm` 或 `.pacman`

::: warning Windows SmartScreen
未签名或新发布的开源应用可能会触发 SmartScreen。如果你信任该发布来源，请选择 **More info**，然后选择 **Run anyway**。
:::

## 环境要求

打包好的应用旨在实现零设置上手。你可以先使用无需认证的免费模型 - 无需注册、API 密钥或信用卡。如果你想要更多模型，应用会引导你从界面中完成运行时检测和提供方认证。

对于付费或需要账户支持的模型，请至少连接一个提供方：

| 提供方             | 接入方式                                          |
| ------------------ | ------------------------------------------------- |
| Claude (Anthropic) | Claude Code CLI 登录或 API 密钥                   |
| Codex (OpenAI)     | Codex CLI 登录或 API 密钥                         |
| Gemini (Google)    | Google ADC、Gemini CLI 或 API 密钥                |
| OpenCode           | 内置的无需认证免费模型，或用于受支持后端（例如 OpenRouter）的 API 密钥 |

::: info
Gemini 作为受支持的提供方路径提供。关于所有提供方的认证选项和当前状态，请参阅[提供方与运行时](/zh/reference/providers-runtimes)。
:::

对于源码开发，你还需要：

| 工具    | 版本    |
| ------- | ------- |
| Node.js | 24.16.0 LTS |
| pnpm    | 10+     |

在 macOS 上，官方的 Node.js 24 预编译二进制文件需要 macOS 13.5+。

## 从源码运行

<InstallBlock command="git clone https://github.com/777genius/agent-teams-ai.git && cd agent-teams-ai && pnpm install && pnpm dev" label="复制" copied-label="已复制" />

```bash
git clone https://github.com/777genius/agent-teams-ai.git
cd agent-teams-ai
pnpm install
pnpm dev
```

`pnpm dev` 会启动带有热重载的桌面 Electron 应用。这是默认的开发目标 — 日常开发时请勿启动浏览器网页开发服务器。浏览器路径缺少完整的桌面 IPC、终端、提供方认证以及团队生命周期行为。

`main` 分支承载着最新的稳定开发版本。仅当你需要某个特定的未发布变更时，才切换到功能分支。

## 验证设置

安装完成后，确认构建状态正常：

```bash
# Check that the desktop app compiles and starts
pnpm typecheck

# Verify the VitePress documentation site builds
pnpm --dir landing docs:build
```

如果 `pnpm typecheck` 报告类型错误，请检查依赖项是否有较新版本，或者固定的 TypeScript 版本。如果 `pnpm --dir landing docs:build` 失败，请检查 `landing/product-docs/` 中 markdown 或配置文件的语法错误。

如果你正在编辑这些文档，请运行构建以验证你的更改：

```bash
pnpm --dir landing docs:build
```

## 自动更新

打包好的应用会在启动时以及运行过程中定期自动检查更新。当有可用更新时，应用会提示你下载并安装。你也可以从应用菜单手动检查。

::: tip
从源码运行时无法使用自动更新。当依赖项发生变化时，请拉取最新更改并重新运行 `pnpm install`。
:::

## 从源码更新

如果你从源码运行，当依赖项发生变化时，请拉取 `main` 分支并重新运行安装：

```bash
git pull
pnpm install
```

更新后，验证构建和文档：

```bash
pnpm typecheck
pnpm --dir landing docs:build
```

日常开发请始终使用 `pnpm dev`（Electron）— 而不是浏览器开发服务器。

## 后续步骤

- [快速开始](/zh/guide/quickstart) — 从安装到运行第一个团队
- [运行时设置](/zh/guide/runtime-setup) — 按运行时配置提供方认证和模型选择
- [创建团队](/zh/guide/create-team) — 推荐的团队形态与简报撰写

### 面向贡献者

- [AGENTS.md](https://github.com/777genius/agent-teams-ai/blob/main/AGENTS.md) — 仓库导航与架构指引
- [CLAUDE.md](https://github.com/777genius/agent-teams-ai/blob/main/CLAUDE.md) — 工作约定与项目规则
- [AGENT_CRITICAL_GUARDRAILS.md](https://github.com/777genius/agent-teams-ai/blob/main/AGENT_CRITICAL_GUARDRAILS.md) — 硬性实现护栏
