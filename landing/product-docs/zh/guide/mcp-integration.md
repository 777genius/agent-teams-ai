---
title: MCP 集成 – Agent Teams 文档
description: 在 Agent Teams 中配置 MCP，用于看板操作、队友协作、外部工具服务器以及自定义工具开发。
lang: zh-Hans
---

# MCP 集成

Agent Teams 在两个实用层级上使用 MCP：

| 层级 | 作用 | 使用者 |
| --- | --- | --- |
| 内置看板服务器 | 暴露 Agent Teams 的任务、消息、审查、进程、运行时以及跨团队工具 | 由应用启动的 lead 与队友 |
| 外部 MCP 服务器 | 添加可选工具，例如浏览器自动化、设计上下文、文档搜索或公司系统 | 用户与已配置的运行时 |

请将这两个层级分开看待。内置的 `agent-teams` MCP 服务器是智能体在 Agent Teams 内部进行协作的方式。外部 MCP 服务器则是可选的运行时工具。

## Agent Teams 如何注入 MCP

当桌面应用启动基于 Claude 的团队成员时，它会写入一个临时的 `--mcp-config` JSON 文件，其中包含内置的 `agent-teams` 服务器：

```json
{
  "mcpServers": {
    "agent-teams": {
      "command": "node",
      "args": ["/path/to/agent-teams-mcp/index.js"],
      "env": {
        "AGENT_TEAMS_MCP_CLAUDE_DIR": "/Users/you/.claude"
      }
    }
  }
}
```

在开发环境中，该命令可能通过 `tsx` 指向 `mcp-server/src/index.ts`。在打包构建中，应用会将捆绑的 MCP 服务器复制到一个稳定的应用数据路径，并使用 Node 运行它。生成的文件归应用所有，并会尽力清理。

用户级和项目级的 MCP 服务器保持独立。应用从以下位置读取已安装的服务器：

| 范围 | 位置 |
| --- | --- |
| 用户 | `~/.claude.json` 中的 `mcpServers` |
| Claude 配置中的本地项目条目 | `~/.claude.json` 中的 `projects[projectPath].mcpServers` |
| 项目 | `<project>/.mcp.json` 中的 `mcpServers` |

对于属于某一个仓库的工具，优先使用项目范围。对于你要在多个不相关项目中复用的工具，优先使用用户范围。

## 项目 `.mcp.json` 示例

当一个团队应当看到相同的项目范围服务器时，将此文件放在项目根目录：

```json
{
  "mcpServers": {
    "docs-search": {
      "command": "npx",
      "args": ["-y", "@acme/docs-search-mcp"],
      "env": {
        "DOCS_INDEX_PATH": "./docs-index"
      }
    },
    "local-browser": {
      "command": "node",
      "args": ["./tools/mcp/browser-server.js"]
    }
  }
}
```

不要把密钥放进已提交的 `.mcp.json` 文件。如果某个值必须保留在本地，请把凭据放在你的 shell、用户范围配置中，或应用的自定义 MCP 安装流程中。

## 看板 MCP 工作流

当工作属于某个任务时，智能体应当使用看板 MCP 工具：

1. 读取最新的任务上下文。
2. 仅在真正开始工作时才启动任务。
3. 为阻塞项、计划和最终结果添加任务评论。
4. 在发布结果评论后将任务标记为完成。
5. 当 lead 或队友需要知道结果时，发送一条简短消息。

智能体流程示例：

```text
task_get -> task_start -> edit/test -> task_add_comment -> task_complete -> message_send
```

用直接消息进行协作。用任务评论保存持久的任务历史。

::: tip
如果该备注涉及审查、验证、变更范围或某个阻塞项，请把它放在任务上。
:::

## 内置 Agent Teams 工具

MCP 服务器从 `agent-teams-controller/src/mcpToolCatalog.js` 注册工具。注册循环位于 `mcp-server/src/tools/index.ts`，每个分组在 `mcp-server/src/tools/` 下有自己的文件。

常用运维工具：

| 工具 | 用途 |
| --- | --- |
| `task_get` | 读取最新的任务上下文、评论、附件、状态以及关联关系 |
| `task_start` | 在工作真正开始时将任务标记为 in progress |
| `task_add_comment` | 添加阻塞项备注、验证备注、计划以及最终结果摘要 |
| `task_complete` | 在发布最终结果评论后完成任务 |
| `message_send` | 向 lead、队友或用户发送一条可见的收件箱消息 |
| `review_request`、`review_start`、`review_approve`、`review_request_changes` | 推进任务范围的审查工作流 |
| `process_register`、`process_list`、`process_stop`、`process_unregister` | 跟踪队友拥有的开发服务器、监听器以及其他后台服务 |

工具名称在运行时可能带有 MCP 命名空间前缀，例如 `mcp__agent-teams__task_get`。在 MCP 服务器内部，规范的工具名称仍然是 `task_get`。

## 注册一个新的内置工具

对于 Agent Teams 仓库的工作，请通过现有的 FastMCP 结构添加内置看板工具：

1. 将工具实现添加到 `mcp-server/src/tools/` 中匹配的文件，如果该领域确实是全新的，则创建一个新的分组文件。
2. 将工具名称添加到 `agent-teams-controller/src/mcpToolCatalog.js` 中相应的分组。
3. 仅在需要新的领域分组时，才通过 `mcp-server/src/tools/index.ts` 接入新分组。
4. 使用 `zod` 校验输入，并调用控制器 API，而不是直接读取看板文件。
5. 在 `mcp-server/test/tools.test.ts` 中添加针对性测试，或在传输层很重要时添加一个 e2e 用例。

最小结构：

```ts
server.addTool({
  name: 'task_example',
  description: 'Explain what this tool does for agents.',
  parameters: z.object({
    teamName: z.string().min(1),
    claudeDir: z.string().min(1).optional(),
    taskId: z.string().min(1)
  }),
  execute: async ({ teamName, claudeDir, taskId }) => {
    assertConfiguredTeam(teamName, claudeDir);
    const controller = getController(teamName, claudeDir);
    return jsonTextContent(controller.tasks.getTask(taskId));
  }
});
```

不要创建绕过控制器校验、改动无关团队文件，或在没有明确任务需要的情况下暴露宽泛文件系统/进程访问权限的工具。

## 外部 MCP 服务器

当队友需要一个持久的工具连接，而不仅仅是一次带粘贴上下文的提示时，请使用外部 MCP 服务器。

适用场景：

- 浏览器或网站测试工具
- 设计或产品数据工具
- 内部文档与搜索系统
- 问题跟踪或支持系统
- 使用只读凭据的数据库检查工具

不适用场景：

- 粘贴进提示的密钥
- 可以直接附加的一次性文件
- 未经审查就改动生产系统的工具
- 当更窄的项目范围已经足够时，却使用宽泛的本地文件系统访问

## 范围

Agent Teams 识别共享范围和面向项目的 MCP 范围。

| 范围 | 适用情形 |
| --- | --- |
| 用户或全局 | 同一个服务器应当在多个项目间可用 |
| 项目或本地 | 该服务器属于某一个仓库、工作区或团队上下文 |

优先选择仍能让工作流可用的最窄范围。项目范围的服务器在审查时更易于推理，因为该工具属于正在被修改的项目。

## 设置检查清单

在分配一个依赖某个 MCP 服务器的任务之前：

1. 安装或配置该服务器。
2. 确认它出现在应用针对目标范围的已安装 MCP 列表中。
3. 在可用时，从 MCP 注册表或扩展 UI 运行诊断。
4. 从一个低风险的只读任务开始。
5. 在任务描述或团队简报中提及预期的 MCP 工具使用方式。

如果某个服务器诊断失败，请先修复它。更好的任务提示并不能修复缺失的命令、错误的配置路径或被拒绝的凭据。

## 从应用安装自定义服务器

桌面应用通过 Electron IPC 暴露 MCP 注册表 API，用于搜索、浏览、安装、自定义安装、卸载、读取已安装状态以及诊断。自定义安装会在调用运行时安装路径之前，校验服务器名称、范围、项目路径、环境变量名以及 HTTP 标头。

当你有一个尚未进入注册表的 MCP 包时，使用自定义安装：

| 字段 | 示例 |
| --- | --- |
| 服务器名称 | `docs-search` |
| 范围 | `project` 表示此仓库，`user` 表示所有项目 |
| 类型 | `stdio` 表示本地命令，`http` 或 `sse` 表示远程服务器 |
| 包 | `@acme/docs-search-mcp` |
| 环境变量 | `DOCS_INDEX_PATH=./docs-index` |

安装后，运行诊断并创建一个小型的只读任务来验证工具界面，然后再分配更大的工作。

## 任务示例

```text
Audit the docs home page with the browser MCP. Check desktop and mobile widths, capture any layout issue as a task comment, and only edit landing/product-docs files. Run `pnpm --dir landing docs:build` before completion.
```

这之所以有效，是因为它指明了工具、操作界面、写入边界以及验证步骤。

## 安全规则

- 不要默认给每个队友都配上每一个 MCP 服务器。
- 除非审查需要，否则将具备写入能力的工具排除在宽泛团队之外。
- 检查类任务优先使用只读凭据。
- 把会影响生产的工具使用置于明确的任务评论和审查之后。
- 将 MCP 诊断失败视为设置失败，而非智能体失败。
- 避免在 `.mcp.json` 或提示中提交密钥。
- 通过应用安装项目范围服务器时，使用绝对路径的 `projectPath` 值。
- 不要编辑应用生成的 `agent-teams-mcp-*.json` 文件；它们是临时的启动产物。

## 相关指南

- [运行时设置](/zh/guide/runtime-setup)
- [团队简报示例](/zh/guide/team-brief-examples)
- [智能体工作流](/zh/guide/agent-workflow)
- [开发者](/zh/developers/)
