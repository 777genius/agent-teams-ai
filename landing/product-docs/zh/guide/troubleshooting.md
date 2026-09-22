---
title: 故障排查 – Agent Teams 文档
description: 借助本地诊断手段修复团队启动问题、缺失的智能体回复、速率限制、CLI 认证问题以及通道（lane）引导停滞。
lang: zh-Hans
---

# 故障排查

大多数团队问题都可归入以下四类之一：运行时设置、启动确认、任务解析以及提供方限制。

## 快速证据准备

对于任何团队生命周期问题，请先定义以下变量，并复用同一个 shell：

```bash
TEAM="<team-name>"
TEAM_DIR="$HOME/.claude/teams/$TEAM"
TASKS_DIR="$HOME/.claude/tasks/$TEAM"
```

然后在解读 UI 状态之前，先确认预期的文件确实存在：

```bash
test -d "$TEAM_DIR" && find "$TEAM_DIR" -maxdepth 2 -type f | sort | sed -n '1,80p'
test -d "$TASKS_DIR" && find "$TASKS_DIR" -maxdepth 1 -name '*.json' | sort | sed -n '1,40p'
```

::: warning 证据优先
不要仅凭一个卡住的徽章就去修改 prompt、提供方设置或清理进程。请先将 UI 与持久化文件、启动产物以及运行时证据相互印证。
:::

## 团队无法启动

按顺序逐项检查：

1. **运行时可用** —— 所选 CLI（`claude`、`codex`、`opencode`）已安装
2. **PATH 可达** —— 二进制文件在环境 `PATH` 中可用
3. **模型访问** —— 提供方有权访问所请求的模型字符串（尤其对于 OpenCode，精确的提供方/模型名称至关重要）
4. **项目路径** —— 项目目录存在且可读
5. **网络 / VPN** —— 某些提供方会在 VPN 处于激活状态时丢弃流量

::: tip
在终端中运行运行时二进制文件以验证 `PATH` 和认证。例如：`claude --version` 或 `opencode --version`。
:::

### OpenCode：已注册但引导未确认

如果 OpenCode 显示 `registered` 但引导未确认，请先检查产物，然后再更改团队 prompt。

贡献者/调试细节见[贡献者架构](/zh/reference/contributor-architecture)，其中链接到权威的智能体团队调试操作手册。

查看最新的启动失败产物：

```bash
LATEST_FAILURE="$TEAM_DIR/launch-failure-artifacts/latest.json"
MANIFEST_PATH="$(jq -r '.manifestPath' "$LATEST_FAILURE")"
jq '.classification, .bootstrapTransportBreadcrumb, .memberSpawnStatuses' "$MANIFEST_PATH"
```

`latest.json` 指向最新打包的产物目录及其 `manifest.json`。该 manifest 包含：

- `classification` —— 此次启动被判定为失败的原因
- `bootstrapTransportBreadcrumb` —— 所使用的投递路径
- 成员 spawn 状态
- 已脱敏的日志和追踪

同时检查通道（lane）manifest：

```bash
jq '.lanes' "$TEAM_DIR/.opencode-runtime/lanes.json" 2>/dev/null
find "$TEAM_DIR/.opencode-runtime/lanes" -maxdepth 2 -name manifest.json -print -exec jq '.activeRunId, .entries' {} \; 2>/dev/null
```

::: tip 不要凭 UI 猜测
始终将 UI 诊断与持久化文件（`launch-state.json`、`bootstrap-journal.jsonl`）以及运行时专有证据相互印证。
:::

## 通用诊断

从磁盘上的持久化文件开始，而不是仅看 UI。

### 团队根目录

```bash
printf '%s\n' "$TEAM_DIR"
```

关键文件及其所能告诉你的信息：

- `launch-state.json` —— 成员启动/存活状态（`.teamLaunchState`、`.summary`、`.members`）
- `bootstrap-journal.jsonl` —— 来自 CLI/运行时的有序引导事件（`tail -80`）
- `bootstrap-state.json` —— 引导阶段摘要
- `config.json` —— 提供方、模型和项目配置
- `inboxes/*.json` 和 `sentMessages.json` —— 消息投递状态

```bash
jq '.teamLaunchState, .summary, .members' "$TEAM_DIR/launch-state.json"
tail -80 "$TEAM_DIR/bootstrap-journal.jsonl" 2>/dev/null
```

### OpenCode 运行时证据

对于 OpenCode 队友，会话证据位于通道（lane）运行时存储中：

- `.opencode-runtime/lanes.json` —— 带状态的通道索引
- `.opencode-runtime/lanes/<lane>/manifest.json` —— `activeRunId` 和证据条目
- `.opencode-runtime/lanes/<lane>/opencode-sessions.json` —— 已提交的会话记录

预期的健康状态：通道状态为 `active`，manifest 带有 `activeRunId` 且至少有一个证据条目，成员的 `bootstrapConfirmed: true`。

```bash
jq '.lanes' "$TEAM_DIR/.opencode-runtime/lanes.json" 2>/dev/null
find "$TEAM_DIR/.opencode-runtime" -maxdepth 3 -type f | sort
```

### 启动失败产物

当一次启动被标记为失败时，检查 `latest.json`：

```bash
LATEST_FAILURE="$TEAM_DIR/launch-failure-artifacts/latest.json"
jq '.' "$LATEST_FAILURE"
jq '.' "$(jq -r '.manifestPath' "$LATEST_FAILURE")"
```

该 manifest 包含：
- `classification` —— 此次启动被判定为失败的原因
- `bootstrapTransportBreadcrumb` —— 所使用的投递路径
- 成员 spawn 状态以及已脱敏的日志/追踪

## 智能体回复缺失

打开任务日志和队友消息。回复缺失常常源于：

- **运行时投递重试** —— 智能体可能已经作答，但消息未投递到应用。请检查投递账本（ledger）。
- **解析或过滤** —— 智能体输出未包含预期的标记或任务引用。
- **任务归属** —— 工作确实在会话期间发生，但因为输出中缺少正确的任务 id 而未与任务关联。

::: warning 不要把沉默当成忽略
在日志确认之前，不要假定模型忽略了消息。
:::

使用持久化的消息状态来区分“未发送”和“已发送但未渲染”：

```bash
jq '.' "$TEAM_DIR/inboxes/user.json" 2>/dev/null
jq '.' "$TEAM_DIR/sentMessages.json" 2>/dev/null
```

检查 `from`、`to`、`messageId`、`relayOfMessageId` 和 `taskRefs`。对于 OpenCode 队友，在假定模型忽略了 prompt 之前，还要检查运行时投递证据。

## 任务未关联到变更

使用任务专属日志和代码审查链接。如果某个 diff 看起来是脱离关联的：

- 检查智能体输出中是否包含了任务 id 或任务引用。
- 验证智能体在进行编辑之前是否调用了 `task_add_comment`。
- 确保智能体调用了 `task_start`，以便看板知道工作已开始。

对于 OpenCode 队友，证明某个会话属于某个任务的权威证据位于 `opencode-sessions.json` 和通道（lane）manifest 条目中，而不仅仅是 UI 消息流。

### 任务日志分诊

当任务日志看起来不完整时，按任务 id 在任务 JSON、收件箱（inboxes）和引导事件中进行搜索：

```bash
TASK="<short-or-full-task-id>"
rg -n "$TASK" "$TASKS_DIR" "$TEAM_DIR/inboxes" "$TEAM_DIR/bootstrap-journal.jsonl" 2>/dev/null
```

仔细解读结果：

| 证据 | 它能证明什么 | 它不能证明什么 |
| --- | --- | --- |
| 消息已投递 | 应用写入或转发了一条 prompt | 智能体取得了进展 |
| 任务评论 | 智能体发布了看板可见的文本 | 该评论是有意义的进展 |
| 原生工具行 | 运行时在某个会话中做了工作 | 除非归属匹配，否则该工作属于此任务 |
| 变更账本条目 | 应用记录了文件变更 | 实现是正确的 |

对于 OpenCode，健康的任务日志通常包含原生运行时行，如 `read`、`bash`、`edit` 或 `write`，外加 Agent Teams MCP 行。如果你只看到 `agent-teams_*` 行，请在扩大日志匹配范围之前先确认任务归属和会话边界。

## 速率限制

如果提供方报告了一个已知的重置时间，Agent Teams 可以在冷却结束后提醒 lead 继续。如果重置时间未知，则等待或切换提供方/运行时路径。

| 提供方行为 | 建议操作 |
| --- | --- |
| 显示了已知的重置时间 | 等待冷却后继续 |
| 未显示重置时间 | 切换提供方或运行时路径 |
| 反复出现 429 | 降低并发或使用不同的模型通道（lane） |

## CLI 认证问题

### `claude login` 未持久化

如果 CLI 在某个终端中已认证，但应用却说未认证，请验证认证是否已保存到预期的配置路径，以及应用进程是否看到相同的 `$HOME`。

### OpenCode 提供方密钥被拒绝

- 仔细核对 `config.json` 中的提供方名称是否与模型字符串中的提供方前缀匹配
- 确保密钥未在提供方控制台中过期或被吊销

### 认证诊断日志

每次调用 `CliInstallerService.getStatus()` 都会向 Electron 日志文件夹中的 `claude-cli-auth-diag.ndjson` 追加一行（在 macOS 上通常为 `~/Library/Logs/<product-name>/`）。如果该文件超过 **512 KiB**，则会在下一次写入之前被截断为空。

如果你在打包后的应用中看到 “Not logged in” 或认证错误，请检查此文件。

## 通道（lane）引导卡住

对于 OpenCode 次级通道（secondary lane）：

- 缺少 `inboxes/<member>.json` 并不自动意味着这是 bug。OpenCode 通道在启动之前不必先由主收件箱创建。
- 如果 UI 显示团队仍在启动，而主成员已经可用，那么“所有队友已加入”正在等待次级通道。
- 如果 `Prepared communication channels for X/Y members` 卡住，请验证 `Y` 是否错误地把次级 OpenCode 成员计算在内。

### 通道（lane）manifest 条目为空

如果桥接（bridge）声称引导成功，但 `manifest.json` 显示 `entries: []`，问题在于**证据提交**，而不是模型行为。在 `opencode-sessions.json` 及其 manifest 条目存在之前，不得将该成员视为可投递。

## 常见成员状态

| 状态 | 含义 |
| --- | --- |
| `confirmed_alive` + `bootstrapConfirmed` | 健康且就绪 |
| `registered` / `runtime_pending_bootstrap` | 进程或通道存在，但引导证据尚未提交 |
| `failed_to_start` + `runtime_process` | 进程存在，但启动门控失败。请检查诊断 |
| `failed_to_start` + `stale_metadata` | 已保存的 pid/session 已过期或已失效 |

::: warning
`member_briefing` 本身并不是运行时证据。对于 OpenCode，权威证据是已提交的运行时证据，例如 `opencode-sessions.json` 和 manifest 条目。
:::

## 运行时调试模式

对于本地调试，你可以强制队友在 tmux 窗格中运行：

```bash
# Launch from a terminal
CLAUDE_TEAM_TEAMMATE_MODE=tmux pnpm dev

# Or add to custom CLI args
--teammate-mode tmux
```

用它来检查交互式 CLI 行为。不要将其视为与进程后端完全等价。

## 冒烟检查

正常验证请使用桌面 Electron 应用。浏览器/Web 开发模式不包含完整的桌面运行时、IPC、提供方认证、终端或团队生命周期行为。

### 仅文档的变更

从仓库根目录：

```bash
pnpm --dir landing docs:build
git diff --check -- landing/product-docs
```

### 团队生命周期变更

先收窄范围，再逐步扩展：

```bash
pnpm test -- test/main/services/team/TeamProvisioningService.test.ts
pnpm test -- test/main/services/team/TeamAgentLaunchMatrix.safe-e2e.test.ts
pnpm typecheck
git diff --check
```

### 实时团队冒烟测试

使用一个小型团队和一个受 Git 跟踪的一次性项目：

1. 用 `pnpm dev` 启动桌面应用。
2. 创建一个 lead 加一个 builder。
3. 请求一个带有明确验证命令的微小变更。
4. 确认任务从 `pending` -> `in_progress` -> `completed` 移动。
5. 打开任务日志，验证工具行、任务评论和文件变更相互对应。
6. 清理时只停止冒烟测试自有的团队/进程。

::: warning 仅做收窄清理
在清理一次冒烟运行时，不要杀掉所有 OpenCode 主机、无关的 tmux 窗格或用户团队。
:::

## 安全清理

清理过期进程时：

1. 识别 pid 并确认它属于当前团队 / 通道。
2. 只停止明确属于冒烟测试或你正在调试的那次启动的进程。
3. **不要**为了图省事而杀掉所有 OpenCode 或共享主机进程。

## 何时收集证据

在寻求帮助之前，收集：

- 任务 id（短的或完整的）
- 团队名称
- 运行时路径（`claude`、`codex` 或 `opencode`）
- 启动日志摘录（来自 `latest.json` 或 `bootstrap-journal.jsonl`）
- 提供方 / 模型字符串
- 问题发生的确切时间窗口

这些数据通常足以调试启动和任务生命周期问题。

::: tip
如果问题仍然存在，打开团队位于 `~/.claude/teams/<teamName>/` 下的持久化文件，并在更改代码之前将 UI 诊断与实时进程状态相互印证。
:::
