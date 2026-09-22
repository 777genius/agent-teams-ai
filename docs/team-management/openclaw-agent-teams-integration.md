# OpenClaw Integration With Agent Teams

- **Status:** local-first integration guide
- **Audience:** OpenClaw or any outside AI client that can run MCP tools or call a local REST API
- **Primary use case:** let an outside AI create, inspect, launch, and cross-check Agent Teams work
- **Recommended first implementation:** MCP-first, REST as a lifecycle/debug fallback

## 1. Executive Summary

Yes, this integration is feasible.

The clean local architecture is:

```text
OpenClaw
  starts agent-teams-mcp over stdio
    calls Agent Teams desktop HTTP control API
      controls shared Agent Teams runtime and shared ~/.claude state
```

There are two integration surfaces:

1. **MCP surface**
   - Best fit for an AI agent like OpenClaw.
   - OpenClaw starts `agent-teams-mcp` as a child process.
   - The MCP server exposes tools such as `team_list`, `team_create`, `team_get`, `team_launch`, `task_create`, `message_send`, `review_request`, and more.

2. **REST control API**
   - Best fit for lifecycle automation, health checks, debugging, and simple wrappers.
   - Runs inside the Agent Teams desktop app.
   - Defaults to `http://127.0.0.1:3456`.
   - Currently covers team lifecycle/runtime control. It does not replace the full board/message MCP tool surface.

For the original request - "can OpenClaw call Agent Teams for complex tasks and cross-checking?" - the answer is:

```text
Use MCP for normal AI-to-Agent-Teams interaction.
Use REST for lifecycle/debug or if OpenClaw cannot use MCP yet.
```

## 2. The Mental Model

### 2.1 What Runs Where

```text
Mac mini or local Mac

Agent Teams Desktop App
  - owns Electron UI
  - owns team runtime process management
  - owns local HTTP control API
  - writes current control API URL to ~/.claude/team-control-api.json

agent-teams-mcp
  - stdio MCP server process
  - started by each MCP client that needs it
  - does not listen on a port
  - forwards lifecycle operations to the desktop HTTP control API
  - uses ~/.claude for team/task/message controller state

OpenClaw
  - external AI client
  - can start agent-teams-mcp as an MCP server
  - can optionally call REST directly
```

### 2.2 One Control Plane, Many MCP Processes

Multiple MCP processes are expected and safe.

```text
Agent 1 MCP process \
Agent 2 MCP process  -> one Agent Teams desktop HTTP API -> shared teams/tasks/runtime
OpenClaw MCP process/
```

This is safe because `agent-teams-mcp` is a stdio process:

- it does not bind a port;
- it does not own global runtime state;
- it does not create a second app server;
- it uses the shared desktop app control API for lifecycle operations;
- it uses the shared Claude data directory for team/task/message state.

The thing that must be singular is the **desktop control plane**, not the MCP process.

### 2.3 What Can Conflict

MCP processes themselves should not conflict.

Possible conflicts are logical, not port/process conflicts:

- two clients create the same `teamName`;
- two clients launch or stop the same team at the same time;
- two clients edit the same task concurrently;
- one client changes the board while another client is using stale state.

These are normal shared-state coordination issues. They are not caused by multiple MCP servers.

## 3. Recommended Integration Choice

### Option A: MCP-first integration

Scores: 🎯 9/10 🛡️ 8/10 🧠 4/10

Expected OpenClaw changes: roughly `20-80 LOC` plus configuration.

Use this if OpenClaw supports stdio MCP servers.

Why it is the recommended path:

- it matches how AI clients naturally call tools;
- it exposes the richer board/task/message/review surface;
- each OpenClaw run can start its own MCP process safely;
- it avoids writing a custom task/message client against internal files;
- it keeps OpenClaw integration close to the tools Agent Teams already gives team agents.

Use REST only for health checks and debugging in this option.

### Option B: REST-first lifecycle integration

Scores: 🎯 7/10 🛡️ 7/10 🧠 5/10

Expected OpenClaw changes: roughly `80-180 LOC`.

Use this if OpenClaw cannot run MCP yet.

Important limitation:

```text
REST currently covers team lifecycle/runtime control.
It is not the full board/task/message/review control surface.
```

REST can:

- list teams;
- create draft team configs;
- get team snapshots;
- launch teams;
- stop teams;
- poll runtime/provisioning state.

REST should not be treated as the full replacement for task/message MCP tools.

### Option C: Hybrid integration

Scores: 🎯 8/10 🛡️ 8/10 🧠 7/10

Expected OpenClaw changes: roughly `120-260 LOC`.

Use MCP for normal AI tool calls, and REST for operational checks.

Good split:

- MCP: team operations, task creation, messages, reviews, process registry.
- REST: "is the desktop app alive?", "what is the runtime state?", "what is the current run status?"

This is the best long-term shape if OpenClaw needs both agentic workflows and a supervisory dashboard.

## 4. Local Setup Checklist

### 4.1 Start Agent Teams Desktop App

The desktop app must be running. It owns the runtime and local HTTP API.

### 4.2 Enable Browser Access / Server Mode

In the desktop app:

```text
Settings -> Browser Access -> Enable server mode
```

When enabled, the app starts a local Fastify HTTP server.

Default:

```text
http://127.0.0.1:3456
```

If port `3456` is busy, the app tries the next ports.

### 4.3 Discover the Current Control API URL

The desktop app writes the active URL to:

```text
~/.claude/team-control-api.json
```

Example:

```json
{
  "baseUrl": "http://127.0.0.1:3456",
  "pid": 12345,
  "updatedAt": "2026-04-29T10:00:00.000Z"
}
```

Check it:

```bash
cat ~/.claude/team-control-api.json
```

Then verify REST:

```bash
curl -s http://127.0.0.1:3456/api/teams
```

If the file shows a different port, use that `baseUrl`.

### 4.4 Local vs Remote OpenClaw

If OpenClaw runs on the same Mac:

```text
No tunnel needed.
Use http://127.0.0.1:<port>.
```

If OpenClaw runs on another machine:

```text
127.0.0.1 points to the OpenClaw machine, not to the Mac running Agent Teams.
Use an SSH tunnel, reverse tunnel, VPN, or another secure local-network setup.
```

Basic SSH tunnel example:

```bash
ssh -N -L 3456:127.0.0.1:3456 user@mac-mini-host
```

Then OpenClaw can use:

```text
http://127.0.0.1:3456
```

from the machine where the tunnel is open.

## 5. MCP Integration

### 5.1 What OpenClaw Needs To Do

OpenClaw should register `agent-teams-mcp` as a stdio MCP server.

That means OpenClaw starts a process and speaks MCP JSON-RPC over stdin/stdout.

OpenClaw does **not** connect to an MCP URL.

The URL belongs to the desktop HTTP control API and is passed to MCP through:

- `CLAUDE_TEAM_CONTROL_URL`, or
- `~/.claude/team-control-api.json`, or
- per-tool `controlUrl`.

### 5.2 Dev Checkout MCP Config

Use this while testing from the repository checkout:

```json
{
  "mcpServers": {
    "agent-teams": {
      "command": "pnpm",
      "args": ["--dir", "/Users/belief/dev/projects/claude/claude_team/mcp-server", "dev"],
      "env": {
        "AGENT_TEAMS_MCP_CLAUDE_DIR": "/Users/belief/.claude",
        "CLAUDE_TEAM_CONTROL_URL": "http://127.0.0.1:3456"
      }
    }
  }
}
```

Adjust:

- repo path;
- Claude data directory;
- control URL port.

### 5.3 Built MCP Config

Build:

```bash
pnpm --filter agent-teams-mcp build
```

Configure OpenClaw:

```json
{
  "mcpServers": {
    "agent-teams": {
      "command": "node",
      "args": ["/Users/belief/dev/projects/claude/claude_team/mcp-server/dist/index.js"],
      "env": {
        "AGENT_TEAMS_MCP_CLAUDE_DIR": "/Users/belief/.claude",
        "CLAUDE_TEAM_CONTROL_URL": "http://127.0.0.1:3456"
      }
    }
  }
}
```

### 5.4 If OpenClaw Supports `cwd`

Some MCP clients allow a `cwd` field. If OpenClaw supports it, this is cleaner:

```json
{
  "mcpServers": {
    "agent-teams": {
      "command": "pnpm",
      "args": ["dev"],
      "cwd": "/Users/belief/dev/projects/claude/claude_team/mcp-server",
      "env": {
        "AGENT_TEAMS_MCP_CLAUDE_DIR": "/Users/belief/.claude",
        "CLAUDE_TEAM_CONTROL_URL": "http://127.0.0.1:3456"
      }
    }
  }
}
```

If OpenClaw does not support `cwd`, use the `pnpm --dir ... dev` form.

### 5.5 MCP URL Discovery Order

For lifecycle tools such as `team_list`, `team_get`, `team_create`, and `team_launch`, the control URL is resolved in this order:

1. tool argument `controlUrl`;
2. `~/.claude/team-control-api.json`;
3. environment variable `CLAUDE_TEAM_CONTROL_URL`.

Passing `CLAUDE_TEAM_CONTROL_URL` is the most explicit OpenClaw setup.

Passing `controlUrl` per tool call is useful for debugging or tunnels.

### 5.6 MCP Tool Surface

Current tool groups:

| Group             | Tools                                                                                                                                                                                                                                                                                                                                    |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Team lifecycle    | `team_list`, `team_get`, `team_create`                                                                                                                                                                                                                                                                                                   |
| Runtime lifecycle | `team_launch`, `team_stop`                                                                                                                                                                                                                                                                                                               |
| Task board        | `task_create`, `task_create_from_message`, `task_get`, `task_get_comment`, `task_list`, `task_start`, `task_complete`, `task_set_owner`, `task_set_status`, `task_add_comment`, `task_link`, `task_unlink`, `task_set_clarification`, `task_restore`, `task_attach_file`, `task_attach_comment_file`, `task_briefing`, `member_briefing` |
| Lead briefing     | `lead_briefing`                                                                                                                                                                                                                                                                                                                          |
| Review            | `review_request`, `review_start`, `review_approve`, `review_request_changes`                                                                                                                                                                                                                                                             |
| Messages          | `message_send`                                                                                                                                                                                                                                                                                                                           |
| Cross-team        | `cross_team_send`, `cross_team_list_targets`, `cross_team_get_outbox`                                                                                                                                                                                                                                                                    |
| Kanban            | `kanban_get`, `kanban_set_column`, `kanban_clear`, `kanban_list_reviewers`, `kanban_add_reviewer`, `kanban_remove_reviewer`                                                                                                                                                                                                              |
| Process registry  | `process_register`, `process_list`, `process_stop`, `process_unregister`                                                                                                                                                                                                                                                                 |
| Runtime bridge    | `runtime_bootstrap_checkin`, `runtime_deliver_message`, `runtime_task_event`, `runtime_heartbeat`                                                                                                                                                                                                                                        |

Most OpenClaw integrations need:

```text
team_list
team_get
team_create
team_launch
team_stop
task_create
task_list
task_get
message_send
review_request
review_request_changes
review_approve
```

The `runtime_*` tools are low-level OpenCode runtime bridge tools. Do not use them for ordinary user/team messaging.

## 6. MCP Workflow Examples

The exact call UI depends on OpenClaw. The examples below show the arguments conceptually.

### 6.1 List Teams

Tool:

```text
team_list
```

Arguments:

```json
{
  "controlUrl": "http://127.0.0.1:3456"
}
```

`controlUrl` can be omitted if `~/.claude/team-control-api.json` exists and points to the running desktop app.

### 6.2 Get a Team

Tool:

```text
team_get
```

Arguments:

```json
{
  "teamName": "openclaw-review"
}
```

For a draft team, the response includes `pendingCreate` and `savedRequest`.

For a configured team, the response is the normal team snapshot.

### 6.3 Create a Draft Review Team

Tool:

```text
team_create
```

Arguments:

```json
{
  "teamName": "openclaw-review",
  "displayName": "OpenClaw Review",
  "description": "Team used by OpenClaw to cross-check complex work",
  "cwd": "/Users/belief/dev/projects/example-project",
  "providerId": "codex",
  "providerBackendId": "codex-native",
  "model": "gpt-5.4",
  "effort": "high",
  "fastMode": "inherit",
  "limitContext": true,
  "skipPermissions": false,
  "members": [
    {
      "name": "reviewer",
      "role": "Reviewer",
      "workflow": "Review OpenClaw work for bugs, missing tests, incorrect assumptions, and integration risks.",
      "providerId": "codex",
      "providerBackendId": "codex-native",
      "model": "gpt-5.4",
      "effort": "high",
      "fastMode": "inherit"
    },
    {
      "name": "critic",
      "role": "Critical reviewer",
      "workflow": "Look for edge cases, concurrency issues, unsafe assumptions, and architectural regressions.",
      "providerId": "anthropic",
      "model": "claude-opus-4-6",
      "effort": "high"
    }
  ]
}
```

This creates a draft team config. It does not start the runtime.

Important:

- Put provider/backend/model/fast-mode defaults into `team_create`.
- MCP `team_launch` currently accepts a smaller runtime override shape.
- When launching a draft through MCP, saved draft fields are reused.

### 6.4 Launch the Team

Tool:

```text
team_launch
```

Arguments:

```json
{
  "teamName": "openclaw-review",
  "cwd": "/Users/belief/dev/projects/example-project",
  "prompt": "Cross-check OpenClaw latest work. Focus on bugs, missing tests, and architectural risks. Return concise actionable findings.",
  "waitForReady": true,
  "waitTimeoutMs": 180000
}
```

`team_launch` works for:

- a draft team created by `team_create`;
- an existing configured team.

Current MCP `team_launch` launch overrides are intentionally smaller than `team_create`:

```text
cwd
prompt
model
effort: low | medium | high
clearContext
skipPermissions
worktree
extraCliArgs
waitForReady
waitTimeoutMs
```

Do not pass `providerId`, `providerBackendId`, `fastMode`, or `limitContext` to MCP `team_launch`.
Put those into `team_create` so the saved draft can be reused at launch time.

If `waitForReady` is true, the tool waits for provisioning to reach `ready` or fail.

### 6.5 Create a Review Task After Launch

Use this if OpenClaw wants the team to track review work on the board.

Tool:

```text
task_create
```

Arguments:

```json
{
  "teamName": "openclaw-review",
  "subject": "Review OpenClaw latest patch",
  "description": "Check correctness, tests, edge cases, and integration risks. Report concrete findings only.",
  "owner": "reviewer",
  "createdBy": "user",
  "startImmediately": true
}
```

`task_create` requires a configured team, so launch the team first.

This is the raw headless MCP payload. Headless calls do not receive the desktop UI's user
defaults: `owner` by itself creates a `pending` task. If `createdBy`/`from` is also omitted,
the task records no creation actor; assigning it to the team lead produces no inbox row because
lead self-notification is suppressed. Use `createdBy: "user"` plus `startImmediately: true` when
the task should be `in_progress` and delivered once to the owner. The actor/sender must be either
`user` or a configured team member; an arbitrary integration name is rejected and does not create
an inbox row. A blocked task remains pending even with `startImmediately: true`.

### 6.6 Send a Message To the Team

Tool:

```text
message_send
```

Arguments:

```json
{
  "teamName": "openclaw-review",
  "to": "reviewer",
  "from": "openclaw",
  "text": "Please review the latest changes. Focus on regressions and missing tests.",
  "summary": "Review request from OpenClaw"
}
```

Use `message_send` for normal visible messages.

Do not use `runtime_deliver_message` for ordinary OpenClaw-to-team communication.

### 6.7 Stop the Team

Tool:

```text
team_stop
```

Arguments:

```json
{
  "teamName": "openclaw-review",
  "waitForStop": true
}
```

## 7. Suggested OpenClaw Policy

OpenClaw should not call Agent Teams for every small task. Use it when parallel review or team behavior matters.

Suggested policy:

```text
Use the agent-teams MCP server when the task is complex, high-risk, user-visible, or needs independent cross-checking.

Prefer the existing team "openclaw-review".
Call team_get first.
If it does not exist, call team_create.
Call team_launch with a focused prompt.
If the review should be tracked, create a task with task_create.
Use message_send for visible follow-up messages.
Do not create duplicate teams with the same purpose.
Do not call runtime_* tools unless implementing an OpenCode runtime bridge.
Do not expose the local control API outside localhost without a secure tunnel.
```

Recommended task routing:

1. Small code change: OpenClaw handles it alone.
2. Medium risk: OpenClaw launches `openclaw-review` for cross-checking.
3. High risk: OpenClaw creates explicit review tasks for multiple reviewers.
4. Release/blocking work: OpenClaw uses task/review tools and waits for explicit review outcome.

## 8. Direct REST API Integration

REST is useful when:

- OpenClaw cannot run MCP yet;
- you need a simple health/lifecycle wrapper;
- you are debugging the desktop control API;
- you want a non-agent script to create or launch teams.

REST is **not** currently the full board/message/review surface.

Use MCP for task board and messaging operations.

### 8.1 Base URL

Default:

```text
http://127.0.0.1:3456
```

Discover current:

```bash
cat ~/.claude/team-control-api.json
```

Use:

```bash
BASE_URL="$(
  node <<'NODE'
const fs = require('fs');
const path = require('path');

const statePath = path.join(process.env.HOME, '.claude', 'team-control-api.json');

if (fs.existsSync(statePath)) {
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  console.log(state.baseUrl || 'http://127.0.0.1:3456');
} else {
  console.log('http://127.0.0.1:3456');
}
NODE
)"
echo "$BASE_URL"
```

Or set manually:

```bash
BASE_URL="http://127.0.0.1:3456"
```

### 8.2 REST Endpoint Summary

| Method | Path                             | Purpose                           |
| ------ | -------------------------------- | --------------------------------- |
| `GET`  | `/api/teams`                     | List teams                        |
| `POST` | `/api/teams`                     | Create a draft team configuration |
| `GET`  | `/api/teams/:teamName`           | Get a draft or configured team    |
| `POST` | `/api/teams/:teamName/launch`    | Launch a draft or configured team |
| `POST` | `/api/teams/:teamName/stop`      | Stop a running team               |
| `GET`  | `/api/teams/:teamName/runtime`   | Get runtime state for one team    |
| `GET`  | `/api/teams/provisioning/:runId` | Poll launch/provisioning status   |
| `GET`  | `/api/teams/runtime/alive`       | List alive team runtime states    |

Advanced OpenCode runtime bridge endpoints:

| Method | Path                                                      |
| ------ | --------------------------------------------------------- |
| `POST` | `/api/teams/:teamName/opencode/runtime/bootstrap-checkin` |
| `POST` | `/api/teams/:teamName/opencode/runtime/deliver-message`   |
| `POST` | `/api/teams/:teamName/opencode/runtime/task-event`        |
| `POST` | `/api/teams/:teamName/opencode/runtime/heartbeat`         |

Do not use the OpenCode runtime bridge endpoints for normal OpenClaw user/team messages.

### 8.3 List Teams

```bash
curl -s "$BASE_URL/api/teams" | jq .
```

### 8.4 Create a Draft Team

```bash
curl -s \
  -X POST "$BASE_URL/api/teams" \
  -H 'content-type: application/json' \
  -d '{
    "teamName": "openclaw-review",
    "displayName": "OpenClaw Review",
    "description": "Team used by OpenClaw to cross-check complex work",
    "cwd": "/Users/belief/dev/projects/example-project",
    "providerId": "codex",
    "providerBackendId": "codex-native",
    "model": "gpt-5.4",
    "effort": "high",
    "fastMode": "inherit",
    "limitContext": true,
    "skipPermissions": false,
    "members": [
      {
        "name": "reviewer",
        "role": "Reviewer",
        "workflow": "Review OpenClaw work for correctness, regressions, and missing tests.",
        "providerId": "codex",
        "providerBackendId": "codex-native",
        "model": "gpt-5.4",
        "effort": "high"
      }
    ]
  }' | jq .
```

Expected response:

```json
{
  "teamName": "openclaw-review"
}
```

### 8.5 Get a Draft or Existing Team

```bash
curl -s "$BASE_URL/api/teams/openclaw-review" | jq .
```

Draft shape:

```json
{
  "teamName": "openclaw-review",
  "pendingCreate": true,
  "savedRequest": {
    "teamName": "openclaw-review",
    "cwd": "/Users/belief/dev/projects/example-project",
    "providerId": "codex",
    "members": [
      {
        "name": "reviewer",
        "role": "Reviewer"
      }
    ]
  }
}
```

Configured teams return the normal Agent Teams team snapshot.

### 8.6 Launch a Team

```bash
curl -s \
  -X POST "$BASE_URL/api/teams/openclaw-review/launch" \
  -H 'content-type: application/json' \
  -d '{
    "cwd": "/Users/belief/dev/projects/example-project",
    "prompt": "Cross-check OpenClaw latest work. Focus on bugs, missing tests, and architectural risks.",
    "providerId": "codex",
    "providerBackendId": "codex-native",
    "model": "gpt-5.4",
    "effort": "high",
    "fastMode": "inherit",
    "skipPermissions": false
  }' | jq .
```

Expected response:

```json
{
  "runId": "..."
}
```

For draft teams, missing launch fields fall back to the saved draft request where supported.

For existing configured teams, the launch payload is the runtime override for this launch.

⚠️ `limitContext` should be set during `team_create` for this integration path.
Do not depend on it as a configured-team REST launch override unless the route parser is extended.

### 8.7 Poll Launch Status

```bash
RUN_ID="paste-run-id-here"
curl -s "$BASE_URL/api/teams/provisioning/$RUN_ID" | jq .
```

Terminal states:

- `ready`
- `failed`
- `disconnected`
- `cancelled`

Successful launch:

```json
{
  "state": "ready"
}
```

### 8.8 Get Runtime State

```bash
curl -s "$BASE_URL/api/teams/openclaw-review/runtime" | jq .
```

### 8.9 Stop a Team

```bash
curl -s \
  -X POST "$BASE_URL/api/teams/openclaw-review/stop" \
  -H 'content-type: application/json' \
  -d '{}' | jq .
```

## 9. JavaScript REST Client Example

This is a minimal lifecycle-only helper for OpenClaw.

It does not implement task/message/review operations. Use MCP for those.

```js
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

async function getAgentTeamsBaseUrl() {
  if (process.env.CLAUDE_TEAM_CONTROL_URL) {
    return process.env.CLAUDE_TEAM_CONTROL_URL;
  }

  const statePath = path.join(os.homedir(), '.claude', 'team-control-api.json');
  const raw = await fs.readFile(statePath, 'utf8');
  const parsed = JSON.parse(raw);
  if (!parsed.baseUrl) {
    throw new Error('team-control-api.json does not contain baseUrl');
  }
  return parsed.baseUrl;
}

async function requestJson(pathname, options = {}) {
  const baseUrl = await getAgentTeamsBaseUrl();
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: options.method ?? 'GET',
    headers: {
      accept: 'application/json',
      ...(options.body ? { 'content-type': 'application/json' } : {}),
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(payload?.error || `${response.status} ${response.statusText}`);
  }
  return payload;
}

async function teamExists(teamName) {
  try {
    return await requestJson(`/api/teams/${encodeURIComponent(teamName)}`);
  } catch (error) {
    const message = String(error.message || '').toLowerCase();
    if (message.includes('not found')) {
      return null;
    }
    throw error;
  }
}

export async function ensureReviewTeam({ cwd = process.cwd() } = {}) {
  const teamName = 'openclaw-review';
  const existing = await teamExists(teamName);
  if (existing) {
    return existing;
  }

  await requestJson('/api/teams', {
    method: 'POST',
    body: {
      teamName,
      displayName: 'OpenClaw Review',
      description: 'Team used by OpenClaw to cross-check complex work',
      cwd,
      providerId: 'codex',
      providerBackendId: 'codex-native',
      model: 'gpt-5.4',
      effort: 'high',
      fastMode: 'inherit',
      limitContext: true,
      skipPermissions: false,
      members: [
        {
          name: 'reviewer',
          role: 'Reviewer',
          workflow: 'Cross-check OpenClaw work for bugs, missing tests, and risky assumptions.',
          providerId: 'codex',
          providerBackendId: 'codex-native',
          model: 'gpt-5.4',
          effort: 'high',
          fastMode: 'inherit',
        },
      ],
    },
  });

  return requestJson(`/api/teams/${encodeURIComponent(teamName)}`);
}

export async function launchReviewTeam({ cwd = process.cwd(), prompt }) {
  const teamName = 'openclaw-review';
  await ensureReviewTeam({ cwd });

  const launch = await requestJson(`/api/teams/${encodeURIComponent(teamName)}/launch`, {
    method: 'POST',
    body: {
      cwd,
      prompt,
      providerId: 'codex',
      providerBackendId: 'codex-native',
      model: 'gpt-5.4',
      effort: 'high',
      fastMode: 'inherit',
      skipPermissions: false,
    },
  });

  return launch;
}

export async function waitForReady(runId, { timeoutMs = 180000, pollMs = 1000 } = {}) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const status = await requestJson(`/api/teams/provisioning/${encodeURIComponent(runId)}`);
    if (status.state === 'ready') {
      return status;
    }
    if (['failed', 'disconnected', 'cancelled'].includes(status.state)) {
      throw new Error(`Team launch ended in ${status.state}: ${status.error || 'no details'}`);
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }

  throw new Error(`Timed out waiting for run ${runId}`);
}
```

Example use:

```js
const launch = await launchReviewTeam({
  cwd: '/Users/belief/dev/projects/example-project',
  prompt: 'Cross-check the latest OpenClaw changes. Return concrete bugs and missing tests.',
});

await waitForReady(launch.runId);
```

## 10. Validation Rules

### 10.1 Team Names

Team names must be kebab-case:

```text
lowercase alphanumeric segments separated by single hyphens, max 64 chars
```

Good:

```text
openclaw-review
repo-audit-1
security-check
```

Bad:

```text
OpenClaw Review
openclaw_review
review team
review--team
-review
review-
```

### 10.2 Member Names

Avoid reserved names:

- `user`
- `team-lead`

Good:

```text
reviewer
critic
tester
architect
```

### 10.3 Providers and Runtime Fields

Provider IDs:

```text
anthropic
codex
gemini
opencode
```

Provider backend IDs:

```text
auto
adapter
api
cli-sdk
codex-native
```

Fast mode:

```text
inherit
on
off
```

Effort values are provider-dependent. Common values include:

```text
low
medium
high
```

Codex-oriented create flows may also use values such as:

```text
none
minimal
xhigh
max
```

Use values supported by the selected provider/runtime.

## 11. Error Behavior

Common REST status codes:

| Status | Meaning                                                             |
| ------ | ------------------------------------------------------------------- |
| `400`  | Invalid request payload                                             |
| `404`  | Team or run id not found                                            |
| `409`  | Conflict, for example team already exists or stale runtime evidence |
| `501`  | Team control service is not available in this mode                  |
| `500`  | Unexpected server/runtime error                                     |

Common MCP failures:

| Symptom                             | Likely cause                                                                                         |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Control API unavailable             | Desktop app not running, server mode disabled, wrong `CLAUDE_TEAM_CONTROL_URL`, or wrong `~/.claude` |
| `team_create` conflict              | Team already exists                                                                                  |
| `team_launch` timeout               | Runtime auth/model/cwd/provisioning issue                                                            |
| Task tools fail after `team_create` | Team is still a draft. Launch it first                                                               |
| Remote OpenClaw cannot connect      | Missing tunnel or wrong host mapping                                                                 |

## 12. Troubleshooting

### 12.1 Confirm Desktop Control API

```bash
cat ~/.claude/team-control-api.json
curl -s http://127.0.0.1:3456/api/teams | jq .
```

If the file has another port, use that port.

### 12.2 Confirm MCP Starts

From the repo:

```bash
pnpm --dir /Users/belief/dev/projects/claude/claude_team/mcp-server dev
```

This starts the stdio server and waits for MCP JSON-RPC input. It will not print a normal HTTP URL.

In a real OpenClaw setup, OpenClaw starts this process itself.

### 12.3 MCP Starts But Tool Calls Fail

Check:

- `AGENT_TEAMS_MCP_CLAUDE_DIR` points to the same Claude root as the app;
- `CLAUDE_TEAM_CONTROL_URL` points to the app's current local HTTP URL;
- Agent Teams desktop app is running;
- Browser Access / server mode is enabled;
- OpenClaw is on the same machine or has a working tunnel.

### 12.4 `team_create` Says Team Already Exists

Use:

```text
team_get
```

Then reuse the existing team, or pick another `teamName`.

### 12.5 `team_launch` Hangs

With REST, poll:

```bash
curl -s "$BASE_URL/api/teams/provisioning/<runId>" | jq .
```

With MCP, use `waitForReady: true` and a larger `waitTimeoutMs`.

Possible causes:

- model unavailable;
- provider authentication missing;
- invalid working directory;
- provisioning failure;
- already-running/stale runtime state.

### 12.6 Remote OpenClaw Cannot Connect

This is expected without a tunnel.

The desktop API binds to `127.0.0.1`, so a remote process cannot see it directly.

Use SSH tunnel or VPN. Do not publish the control API to a public interface without authentication.

## 13. Security Notes

- Treat the control API as runtime control access.
- Keep it local by default.
- Prefer SSH tunnels for remote use.
- Do not expose it publicly without authentication and transport security.
- Do not share `~/.claude` with untrusted processes.
- Remember that an AI client with this MCP server can create, launch, stop, and coordinate teams.

## 14. What To Tell The User

Use this short explanation:

```text
Yes, this is feasible.

Agent Teams can expose a local control API from the desktop app, and an outside AI like OpenClaw can access it through the agent-teams MCP server.

OpenClaw would start agent-teams-mcp as a stdio MCP server. That MCP process does not listen on a port, so it is fine if multiple agents and OpenClaw each start their own copy. They all point back to the same local Agent Teams desktop control API and shared ~/.claude state.

For a local Mac mini setup, this is straightforward:
1. Run the Agent Teams desktop app.
2. Enable Browser Access / server mode.
3. Configure OpenClaw with the agent-teams MCP server.
4. Let OpenClaw call team_list, team_get, team_create, and team_launch.
5. Use task/message/review MCP tools for deeper coordination.

REST is also available for lifecycle calls like list/create/get/launch/stop, but MCP is the better integration surface for actual AI-to-team work.
```

## 15. Final Recommendation

Start with MCP-first local integration.

Use this minimum viable flow:

```text
1. OpenClaw starts agent-teams-mcp.
2. OpenClaw calls team_get("openclaw-review").
3. If missing, OpenClaw calls team_create(...).
4. OpenClaw calls team_launch(..., waitForReady: true).
5. OpenClaw creates a review task with task_create or sends a message with message_send.
6. OpenClaw reads results via task_get/task_list/message flow.
```

This gives OpenClaw the team coordination behavior without inventing a separate orchestration layer.
