---
title: MCP Integration – Agent Teams Docs
description: Configure MCP in Agent Teams for board operations, teammate coordination, external tool servers, and custom tool development.
---

# MCP Integration

Agent Teams uses MCP in two practical layers:

| Layer | What it does | Who uses it |
| --- | --- | --- |
| Built-in board server | Exposes Agent Teams task, message, review, process, runtime, and cross-team tools | Leads and teammates launched by the app |
| External MCP servers | Add optional tools such as browser automation, design context, docs search, or company systems | Users and configured runtimes |

Keep those layers separate. The built-in `agent-teams` MCP server is how agents coordinate inside Agent Teams. External MCP servers are optional runtime tools.

## How Agent Teams injects MCP

When the desktop app launches Claude-based team members, it writes a temporary `--mcp-config` JSON file containing the built-in `agent-teams` server:

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

In development, the command may point at `mcp-server/src/index.ts` through `tsx`. In packaged builds, the app copies the bundled MCP server to a stable app-data path and runs it with Node. The generated file is app-owned and cleaned up best effort.

User and project MCP servers remain separate. The app reads installed servers from:

| Scope | Location |
| --- | --- |
| User | `~/.claude.json` under `mcpServers` |
| Local project entry in Claude config | `~/.claude.json` under `projects[projectPath].mcpServers` |
| Project | `<project>/.mcp.json` under `mcpServers` |

Prefer project scope for tools that belong to one repository. Prefer user scope for tools you reuse across unrelated projects.

## Project `.mcp.json` example

Place this file at the project root when a team should see the same project-scoped server:

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

Keep secrets out of committed `.mcp.json` files. Put credentials in your shell, a user-scoped config, or the app's custom MCP install flow if the value must stay local.

## Board MCP workflow

Agents should use board MCP tools when the work belongs to a task:

1. Read the latest task context.
2. Start the task only when actually beginning work.
3. Add task comments for blockers, plans, and final results.
4. Mark the task complete after the result comment is posted.
5. Send a short message when a lead or teammate needs to know the result.

Example agent flow:

```text
task_get -> task_start -> edit/test -> task_add_comment -> task_complete -> message_send
```

Use a direct message for coordination. Use a task comment for durable task history.

::: tip
If the note affects review, verification, changed scope, or a blocker, put it on the task.
:::

## Built-in Agent Teams tools

The MCP server registers tools from `agent-teams-controller/src/mcpToolCatalog.js`. The registration loop lives in `mcp-server/src/tools/index.ts`, and each group has its own file under `mcp-server/src/tools/`.

Common operational tools:

| Tool | Use |
| --- | --- |
| `task_get` | Read the latest task context, comments, attachments, status, and relations |
| `task_start` | Mark a task in progress when work actually begins |
| `task_add_comment` | Add blocker notes, verification notes, plans, and final result summaries |
| `task_complete` | Complete a task after the final result comment is posted |
| `message_send` | Send a visible inbox message to a lead, teammate, or user |
| `review_request`, `review_start`, `review_approve`, `review_request_changes` | Move task-scoped review workflows |
| `process_register`, `process_list`, `process_stop`, `process_unregister` | Track teammate-owned dev servers, watchers, and other background services |

Tool names may appear to runtimes with MCP namespace prefixes, for example `mcp__agent-teams__task_get`. The canonical tool name inside the MCP server remains `task_get`.

## Register a new built-in tool

For Agent Teams repository work, add built-in board tools through the existing FastMCP structure:

1. Add the tool implementation to the matching file in `mcp-server/src/tools/`, or create a new group file if the domain is genuinely new.
2. Add the tool name to the appropriate group in `agent-teams-controller/src/mcpToolCatalog.js`.
3. Wire a new group through `mcp-server/src/tools/index.ts` only when a new domain group is needed.
4. Validate input with `zod` and call the controller API instead of reading board files directly.
5. Add focused tests in `mcp-server/test/tools.test.ts` or an e2e case when the transport matters.

Minimal shape:

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

Do not create a tool that bypasses controller validation, mutates unrelated team files, or exposes broad filesystem/process access without a narrow task need.

## External MCP servers

Use external MCP servers when a teammate needs a durable tool connection, not just one prompt with pasted context.

Good fits:

- browser or website testing tools
- design or product data tools
- internal docs and search systems
- issue tracker or support systems
- database inspection tools with read-only credentials

Poor fits:

- secrets pasted into prompts
- one-off files that can be attached directly
- tools that mutate production systems without review
- broad local filesystem access when a narrower project scope is enough

## Scopes

Agent Teams recognizes shared and project-oriented MCP scopes.

| Scope | Use when |
| --- | --- |
| User or Global | The same server should be available across projects |
| Project or Local | The server belongs to one repository, workspace, or team context |

Prefer the narrowest scope that still makes the workflow usable. Project-scoped servers are easier to reason about during review because the tool belongs to the project being changed.

## Setup checklist

Before assigning a task that depends on an MCP server:

1. Install or configure the server.
2. Confirm it appears in the app's installed MCP list for the intended scope.
3. Run diagnostics from the MCP registry or extensions UI when available.
4. Start with a low-risk read-only task.
5. Mention the expected MCP tool use in the task description or team brief.

If a server fails diagnostics, fix that first. A better task prompt will not repair a missing command, wrong config path, or rejected credentials.

## Install a custom server from the app

The desktop app exposes MCP registry APIs through Electron IPC for search, browse, install, custom install, uninstall, installed-state reading, and diagnostics. Custom installs validate the server name, scope, project path, env var names, and HTTP headers before calling the runtime install path.

Use custom install when you have an MCP package that is not in the registry yet:

| Field | Example |
| --- | --- |
| Server name | `docs-search` |
| Scope | `project` for this repository, `user` for all projects |
| Type | `stdio` for local commands, `http` or `sse` for remote servers |
| Package | `@acme/docs-search-mcp` |
| Env | `DOCS_INDEX_PATH=./docs-index` |

After install, run diagnostics and create a small read-only task to prove the tool surface before assigning larger work.

## Task example

```text
Audit the docs home page with the browser MCP. Check desktop and mobile widths, capture any layout issue as a task comment, and only edit landing/product-docs files. Run `pnpm --dir landing docs:build` before completion.
```

This works because it names the tool, the surface, the write boundary, and the verification step.

## Safety rules

- Do not give every teammate every MCP server by default.
- Keep write-capable tools out of broad teams unless review requires them.
- Prefer read-only credentials for inspection tasks.
- Put production-impacting tool use behind explicit task comments and review.
- Treat MCP diagnostic failures as setup failures, not agent failures.
- Avoid committing secrets in `.mcp.json` or prompts.
- Use absolute `projectPath` values when installing project-scoped servers through the app.
- Do not edit the app-generated `agent-teams-mcp-*.json` files; they are temporary launch artifacts.

## Related guides

- [Runtime setup](/guide/runtime-setup)
- [Team brief examples](/guide/team-brief-examples)
- [Agent workflow](/guide/agent-workflow)
- [Developers](/developers/)
