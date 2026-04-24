# OpenCode Native Semantic Messaging Plan

Status: planning document
Scope: `claude_team` + `agent_teams_orchestrator`
Goal: make OpenCode teammates use the correct app MCP messaging protocol without breaking Codex/Claude native teammates.

## Problem

OpenCode teammates currently run in a different tool environment than Codex/Claude native teammates.

Native teammates can use `SendMessage`.
OpenCode teammates must use app MCP tools exposed by the `agent-teams` server, especially:

- `agent-teams_message_send`
- `agent-teams_cross_team_send` for messages to other teams
- `agent-teams_member_briefing`
- `agent-teams_runtime_bootstrap_checkin`
- board tools such as `task_briefing`, `task_start`, `task_add_comment`, `task_complete`

The current code already tells OpenCode to use `agent-teams_message_send` in some places, but other downstream prompts still contain hardcoded `SendMessage`. That creates inconsistent instructions:

- OpenCode launch prompt says: use `agent-teams_message_send`.
- `member_briefing` says: use `SendMessage`.
- task assignment notification says: use `SendMessage`.
- clarification protocol says: use `SendMessage`.

This can make OpenCode teammates look started but not answer through the Messages UI.

## Decision

Chosen approach: OpenCode-native semantic messaging seam.

Option 1: frontend-only display patch - 🎯 2 🛡️ 2 🧠 2, about 50-120 LOC
This hides symptoms only. It does not fix the wrong tool instructions sent to OpenCode.

Option 2: orchestrator-only patch - 🎯 6 🛡️ 6 🧠 4, about 180-320 LOC
This is necessary for runtime identity and MCP proof, but not sufficient because `member_briefing` and task assignment messages are produced in `claude_team`.

Option 3: orchestrator + `claude_team` controller/MCP semantic seam - 🎯 9 🛡️ 9 🧠 7, about 1300-2200 LOC with tests
This fixes the actual contract. Orchestrator owns OpenCode session identity. `claude_team` owns team protocol text and MCP tool schemas.

## Extra Research Corrections

This section records the higher-risk places that were checked after the first draft.

- `member_briefing` is not the only source of `SendMessage` wording. `buildAssignmentMessage()` and `buildMemberTaskProtocol()` also contain hardcoded native instructions, so the fix must cover assignment and clarification paths too.
- Controller member resolution currently drops provider metadata. Without preserving `providerId`/`provider`, task assignment notifications cannot reliably choose OpenCode wording for an OpenCode owner.
- `message_send` storage already supports `taskRefs`, but MCP schema does not expose it yet. If prompts mention task traceability, schema must accept `taskRefs` or the plan creates another mismatch.
- `message_send` currently uses the raw `to` value as the inbox filename. If an agent sends to the alias `team-lead` while the configured lead is actually named `lead`, the row can land in `inboxes/team-lead.json` and bypass lead relay. `message_send` must canonicalize local recipients and sender aliases before persistence.
- OpenCode tool names appear through multiple aliases: `agent-teams_message_send`, `agent_teams_message_send`, `mcp__agent-teams__message_send`, `mcp__agent_teams__message_send`, and sometimes plain `message_send`. Capture/logging code must not hardcode only one spelling.
- `runtime_bootstrap_checkin` needs `runtimeSessionId`. The adapter cannot know it. Only orchestrator knows `record.opencodeSessionId` after `ensureSession()`, so identity injection belongs in `agent_teams_orchestrator`.
- `runtime_bootstrap_checkin` does not accept `laneId`. `laneId` is bridge/session routing state, not an MCP tool argument. The plan must not show examples with unsupported payload fields.
- `runtime_deliver_message` is a real delivery tool, not a dummy readiness marker. It writes through `RuntimeDeliveryService` into app-owned destinations. That makes it dangerous to leave ambiguous: OpenCode may choose it for ordinary replies unless descriptions/prompts clearly say normal human/team replies use `message_send` in v1.
- The required app-tool proof must cover all teammate-operational tools that `member_briefing` can instruct, not just `message_send` and four task tools.
- `claude_team` already exports `AGENT_TEAMS_TEAMMATE_OPERATIONAL_TOOL_NAMES` from `agent-teams-controller`; app-side required tools should derive from that instead of duplicating a second list.
- Orchestrator direct `mcp:tools/list` proof sees plain MCP names like `message_send`, not OpenCode canonical ids. Do not compare direct stdio results against `agent_teams_message_send` or `agent-teams_message_send`.
- However, orchestrator readiness currently exposes `toolProof.observedTools` through `readiness.evidence.observedMcpTools`. Direct proof should match plain names internally, but bridge output should keep a clearly named field if canonical OpenCode ids are needed later. Do not silently change `observedMcpTools` semantics.
- `agent_teams_orchestrator` does not currently depend on `agent-teams-controller`. Do not import the controller catalog into the orchestrator in v1 unless intentionally adding a new cross-repo/package dependency.
- The old project-proof gate was removed from OpenCode launch readiness. Do not reintroduce project-scoped launch blocking for selected models; runtime readiness should be based on inventory, capabilities, runtime stores, app MCP tool proof, and the execution probe.
- Current controller teammate-operational catalog includes more than the obvious message/task-start tools: `task_attach_comment_file`, `task_attach_file`, `task_create`, `task_create_from_message`, `task_link`, and `task_unlink` are also teammate-operational and must be included in any explicit orchestrator v1 list.
- `mcp-server/src/agent-teams-controller.d.ts` and `src/types/agent-teams-controller.d.ts` mirror controller signatures and must be updated when `memberBriefing(memberName, options)` is added.
- `agent-teams-controller` is CommonJS and existing TS code imports it as `import * as agentTeamsControllerModule from 'agent-teams-controller'`; use that pattern in new app-side imports instead of assuming a default ESM export.
- `agentTeamsToolNames.ts` currently canonicalizes only `mcp__agent-teams__` and `mcp__agent_teams__`. Its regex helper for task-boundary lines must be updated with the same alias prefixes as the canonicalizer, or task logs can keep missing OpenCode `agent-teams_task_start` style tool names.
- `TeamProvisioningService.captureSendMessages()` intentionally ignores normal non-native `message_send` after cross-team fallback handling because the MCP tool itself persists the inbox row. Alias support must not turn OpenCode `message_send` into a second live lead-process message.
- `OpenCodeSessionBridge.promptAsync()` returns after enqueueing the prompt, and `runLaunch()` currently reconciles immediately. A tool-only/bootstrap response can arrive just after that first reconcile, so launch confirmation needs a short bounded settle/preview step before final launch-state mapping.
- `cross_team_send` is a separate teammate-operational transport, not a recipient for `message_send`. The semantic seam must keep local/user/team-lead messages separate from cross-team messages.
- Large `SendMessage` blocks in `TeamProvisioningService`, `teamBootstrapPromptBuilder`, `useInboxPoller`, and native swarm prompts are mostly native runtime contracts. Do not mass-rewrite them. Instead, add routing tests proving OpenCode teammates receive the OpenCode runtime adapter/orchestrator prompt path, while native teammates keep the native `SendMessage` path.
- `OpenCodeSendMessageCommandBody` is declared twice in `OpenCodeBridgeCommandContract.ts`. TypeScript interface merging makes it compile, but it is a high-risk edit point because a future change can update only one declaration. Consolidate it before adding run-id recovery semantics.
- `RuntimeRunTombstoneStore.assertEvidenceAccepted()` rejects OpenCode runtime evidence when `currentRunId` is null. The durable `activeRunId` is not in `lanes.json`; it lives in the lane-scoped `RuntimeStoreManifest`. Evidence acceptance and message delivery recovery must read that manifest after app restart instead of adding a second run-id source to `lanes.json`.
- `cross_team_send` schema currently lacks `taskRefs` even though shared cross-team types already include `taskRefs`. Either keep cross-team taskRefs out of v1 prompts or wire it end-to-end. Do not let the semantic helper generate unsupported `taskRefs` for cross-team messages.
- UI direct-message delivery currently persists a native `memberDeliveryText` that tells teammates to use `SendMessage`, then sends the same text to OpenCode. `OpenCodeTeamRuntimeAdapter` recovers by saying "treat SendMessage as abstraction" and regex-parsing the recipient from that text. This is fragile. OpenCode runtime delivery should receive explicit recipient/actionMode/taskRefs metadata and OpenCode-native wording, not parse native prompt text.
- UI direct-message delivery currently starts OpenCode runtime delivery with `void provisioning.deliverOpenCodeMemberMessage(...)` after the inbox write succeeds. Native teammates can still read the persisted inbox row, but OpenCode lanes do not watch that inbox path. For OpenCode, a post-persist runtime delivery failure can be invisible unless the result is surfaced in `SendMessageResult` or an equivalent observable channel.
- Renderer `sendTeamMessage` is typed as `Promise<void>` and catches IPC errors without rethrowing. Call sites in `MessagesPanel` and `TeamDetailView` attach `.catch(...)` to clear pending replies, but that catch path is currently dead. The semantic seam must not add more delivery states on top of a store action that hides failure from callers.
- `message_send` to a non-lead OpenCode teammate can be only a file write to `inboxes/<member>.json`. Codex/Claude native teammates read their inbox files, but OpenCode secondary lanes do not. UI direct-send has a runtime bridge escape hatch, but OpenCode-to-OpenCode teammate messages, task/system notifications, and other persisted inbox routes need an OpenCode-targeted runtime relay or they can silently sit unread.
- Runtime delivery has two event shapes: `RuntimeDeliveryTeamChangeEvent` carries `data.detail`, while public `TeamChangeEvent` carries top-level `detail`. `TeamProvisioningService.createOpenCodeRuntimeDeliveryService()` currently adapts this shape before emitting to the app. Keep this adapter explicit and tested, because renderer refreshes are type-based but relay/notification/detail-sensitive app branches expect `event.detail`.
- `message_send.from` is optional today. If an OpenCode teammate calls `message_send` to `user` without `from`, `messageStore.buildMessage()` defaults to `from: "user"`. That makes the reply durable but semantically wrong: `MessagesPanel` clears pending replies by `message.to === "user"` and `message.from === memberName`. Add a guard so user-directed MCP messages require a real sender instead of silently writing a user-to-user row.

## Non Goals

- Do not rewrite the whole toolset abstraction.
- Do not rename native `SendMessage`.
- Do not make `runtime_deliver_message` the normal reply path.
- Do not implement a broad frontend workaround.
- Do not change Codex/Claude native flow except where a helper default keeps current wording.

## Architecture

### Runtime contracts

Native teammate contract:

```text
Use SendMessage with fields:
to, summary, message
```

OpenCode teammate contract:

```text
Use MCP tool agent-teams_message_send with fields:
teamName, to, from, text, summary
For messages to other teams, use agent-teams_cross_team_send with:
teamName, toTeam, fromMember, text, summary, conversationId?, replyToConversationId?
```

OpenCode bootstrap contract:

```text
1. Call agent-teams_runtime_bootstrap_checkin with runtime identity: teamName, runId, memberName, runtimeSessionId.
2. Call agent-teams_member_briefing with runtimeProvider="opencode".
3. Use agent-teams_message_send for visible local team/user messages.
4. Use agent-teams_cross_team_send for messages to other teams.
5. Do not answer app/team messages only as plain assistant text when message_send is available.
```

### Why not `runtime_deliver_message`

`runtime_deliver_message` is low-level runtime evidence delivery. It requires:

- `idempotencyKey`
- `runId`
- `teamName`
- `fromMemberName`
- `runtimeSessionId`
- `to`
- `text`
- current-run/tombstone validation

That is too fragile as the main LLM-visible reply API. It should remain an audit/runtime channel, not the normal human-facing message tool.

This is a conscious v1 choice, not because `runtime_deliver_message` cannot write messages. It can write through `RuntimeDeliveryService`, but making it the normal reply API would require a different contract:

- prompts must teach idempotency key generation
- user/member/cross-team destination semantics must be unified around `to`
- taskRefs must use runtime delivery envelope shape
- UI capture must normalize runtime-delivered messages with normal `message_send` rows
- all native runtimes would still need their existing `SendMessage` abstraction

V1 keeps the simpler visible-message contract:

- OpenCode normal reply: `agent-teams_message_send`
- OpenCode cross-team reply: `agent-teams_cross_team_send`
- OpenCode runtime evidence/liveness: `runtime_bootstrap_checkin`, `runtime_heartbeat`, `runtime_task_event`
- OpenCode low-level idempotent runtime delivery: `runtime_deliver_message`, only when a prompt explicitly instructs the runtime-evidence flow

### Runtime Tool Schema Guard

`runtime_bootstrap_checkin` currently accepts:

```ts
{
  teamName: string;
  runId: string;
  memberName: string;
  runtimeSessionId: string;
  claudeDir?: string;
  controlUrl?: string;
  waitTimeoutMs?: number;
  observedAt?: string;
  diagnostics?: string[];
  metadata?: Record<string, unknown>;
}
```

It does not accept `laneId`.

Implementation rule:

- Use `laneId` only to find the stored OpenCode session and route bridge commands.
- Do not include `laneId` in the MCP tool payload shown to the model.
- Add a test or assertion that the identity block example does not contain `"laneId"` inside the `runtime_bootstrap_checkin` JSON.

## File Map

`claude_team` files:

- `/Users/belief/dev/projects/claude/claude_team/src/main/services/team/runtime/OpenCodeTeamRuntimeAdapter.ts`
- `/Users/belief/dev/projects/claude/claude_team/src/main/services/team/TeamProvisioningService.ts`
- `/Users/belief/dev/projects/claude/claude_team/src/main/services/team/agentTeamsToolNames.ts`
- `/Users/belief/dev/projects/claude/claude_team/agent-teams-controller/src/internal/tasks.js`
- `/Users/belief/dev/projects/claude/claude_team/agent-teams-controller/src/internal/messages.js`
- `/Users/belief/dev/projects/claude/claude_team/agent-teams-controller/src/internal/runtimeHelpers.js`
- `/Users/belief/dev/projects/claude/claude_team/agent-teams-controller/src/internal/memberMessagingProtocol.js`
- `/Users/belief/dev/projects/claude/claude_team/agent-teams-controller/src/mcpToolCatalog.js`
- `/Users/belief/dev/projects/claude/claude_team/mcp-server/src/tools/taskTools.ts`
- `/Users/belief/dev/projects/claude/claude_team/mcp-server/src/tools/messageTools.ts`
- `/Users/belief/dev/projects/claude/claude_team/mcp-server/src/agent-teams-controller.d.ts`
- `/Users/belief/dev/projects/claude/claude_team/src/types/agent-teams-controller.d.ts`
- `/Users/belief/dev/projects/claude/claude_team/src/main/services/team/opencode/mcp/OpenCodeMcpToolAvailability.ts`
- `/Users/belief/dev/projects/claude/claude_team/src/main/services/team/opencode/bridge/OpenCodeReadinessBridge.ts`
- `/Users/belief/dev/projects/claude/claude_team/src/main/services/team/opencode/delivery/RuntimeDeliveryService.ts`
- `/Users/belief/dev/projects/claude/claude_team/src/main/services/team/opencode/store/OpenCodeRuntimeManifestEvidenceReader.ts`
- `/Users/belief/dev/projects/claude/claude_team/src/main/services/team/taskLogs/stream/OpenCodeTaskLogStreamSource.ts`
- `/Users/belief/dev/projects/claude/claude_team/src/main/services/team/taskLogs/stream/BoardTaskLogStreamService.ts`

`agent_teams_orchestrator` files:

- `/Users/belief/dev/projects/claude/agent_teams_orchestrator/src/services/opencode/OpenCodeBridgeCommandHandler.ts`
- `/Users/belief/dev/projects/claude/agent_teams_orchestrator/src/services/opencode/OpenCodeBridgeCommandHandler.test.ts`
- `/Users/belief/dev/projects/claude/agent_teams_orchestrator/src/services/opencode/OpenCodeEventTranslator.test.ts`
- `/Users/belief/dev/projects/claude/agent_teams_orchestrator/src/services/teamBootstrap/teamBootstrapPromptBuilder.ts`
- `/Users/belief/dev/projects/claude/agent_teams_orchestrator/src/hooks/useInboxPoller.ts`

## Implementation Steps

### Step 1 - Add a small messaging protocol helper in controller

Preferred location:

```text
/Users/belief/dev/projects/claude/claude_team/agent-teams-controller/src/internal/memberMessagingProtocol.js
```

Keep it tiny. It should produce instructions only, not send messages itself.

Example:

```js
function normalizeRuntimeProvider(value) {
  const normalized = String(value || '')
    .trim()
    .toLowerCase();
  return normalized === 'opencode' ? 'opencode' : 'native';
}

function createMemberMessagingProtocol(runtimeProvider) {
  const provider = normalizeRuntimeProvider(runtimeProvider);

  if (provider === 'opencode') {
    return {
      runtimeProvider: 'opencode',
      sendToolName: 'agent-teams_message_send',
      sendToolAliases: [
        'agent-teams_message_send',
        'agent_teams_message_send',
        'mcp__agent-teams__message_send',
        'mcp__agent_teams__message_send',
        'message_send',
      ],
      sendLeadPhrase: 'call MCP tool agent-teams_message_send',
      crossTeamPhrase: 'call MCP tool agent-teams_cross_team_send',
      buildLeadMessageExample({ teamName, leadName, fromName, text, summary }) {
        return `agent-teams_message_send { teamName: "${teamName}", to: "${leadName}", from: "${fromName}", text: "${text}", summary: "${summary}" }`;
      },
      buildCrossTeamMessageExample({ teamName, toTeam, fromName, text, summary }) {
        return `agent-teams_cross_team_send { teamName: "${teamName}", toTeam: "${toTeam}", fromMember: "${fromName}", text: "${text}", summary: "${summary}" }`;
      },
    };
  }

  return {
    runtimeProvider: 'native',
    sendToolName: 'SendMessage',
    sendToolAliases: ['SendMessage'],
    sendLeadPhrase: 'use SendMessage',
    crossTeamPhrase: 'use the cross-team MCP tool cross_team_send',
    buildLeadMessageExample({ leadName, text, summary }) {
      return `SendMessage { to: "${leadName}", summary: "${summary}", message: "${text}" }`;
    },
    buildCrossTeamMessageExample({ teamName, toTeam, fromName, text, summary }) {
      return `cross_team_send { teamName: "${teamName}", toTeam: "${toTeam}", fromMember: "${fromName}", text: "${text}", summary: "${summary}" }`;
    },
  };
}

function isOpenCodeMember(member) {
  const provider = String(member?.providerId || member?.provider || '')
    .trim()
    .toLowerCase();
  return provider === 'opencode';
}

module.exports = {
  createMemberMessagingProtocol,
  isOpenCodeMember,
  normalizeRuntimeProvider,
};
```

Acceptance:

- No UI code depends on this helper.
- No runtime side effects.
- Native default stays `SendMessage`.
- OpenCode wording says to use the exposed alias if the exact canonical name differs.
- Cross-team wording stays on `cross_team_send`; never instruct `message_send` with `to: "cross_team_send"` or a remote team as if it were a local teammate.

### Step 2 - Preserve provider metadata in controller member resolution

File:

```text
/Users/belief/dev/projects/claude/claude_team/agent-teams-controller/src/internal/runtimeHelpers.js
```

Current risk:

`normalizeMemberRecord()` keeps `name`, `role`, `workflow`, `agentType`, `color`, `cwd`, `removedAt`, but drops provider/model metadata. Task assignment notification cannot know that an owner is OpenCode, and future controller-side protocol inference can drift away from UI/runtime metadata.

Edit pattern:

```js
function copyTrimmedString(member, key) {
  return typeof member[key] === 'string' && member[key].trim() ? { [key]: member[key].trim() } : {};
}
```

Then preserve fields:

```js
return {
  name,
  ...(typeof member.role === 'string' && member.role.trim() ? { role: member.role.trim() } : {}),
  ...(typeof member.workflow === 'string' && member.workflow.trim()
    ? { workflow: member.workflow.trim() }
    : {}),
  ...(typeof member.agentType === 'string' && member.agentType.trim()
    ? { agentType: member.agentType.trim() }
    : {}),
  ...(typeof member.color === 'string' && member.color.trim()
    ? { color: member.color.trim() }
    : {}),
  ...(typeof member.cwd === 'string' && member.cwd.trim() ? { cwd: member.cwd.trim() } : {}),
  ...copyTrimmedString(member, 'providerId'),
  ...copyTrimmedString(member, 'providerBackendId'),
  ...copyTrimmedString(member, 'provider'),
  ...copyTrimmedString(member, 'model'),
  ...copyTrimmedString(member, 'effort'),
  ...copyTrimmedString(member, 'fastMode'),
  ...(typeof member.removedAt === 'number' ? { removedAt: member.removedAt } : {}),
};
```

Also merge those fields in `mergeResolvedMember()`:

```js
...(source.providerId ? { providerId: source.providerId } : {}),
...(source.providerBackendId ? { providerBackendId: source.providerBackendId } : {}),
...(source.provider ? { provider: source.provider } : {}),
...(source.model ? { model: source.model } : {}),
...(source.effort ? { effort: source.effort } : {}),
...(source.fastMode ? { fastMode: source.fastMode } : {}),
```

Acceptance:

- Existing members without provider metadata behave unchanged.
- OpenCode owners can be detected from resolved team metadata.
- `members.meta.json` can override or fill provider fields from `config.json` without dropping model/effort/backend details.

### Step 3 - Add `runtimeProvider` to `member_briefing`

File:

```text
/Users/belief/dev/projects/claude/claude_team/mcp-server/src/tools/taskTools.ts
```

Add optional schema field:

```ts
runtimeProvider: z.enum(['native', 'opencode']).optional(),
```

Update execute:

```ts
execute: async ({ teamName, claudeDir, memberName, runtimeProvider }) => ({
  content: [
    {
      type: 'text' as const,
      text: await getController(teamName, claudeDir).tasks.memberBriefing(memberName, {
        runtimeProvider,
      }),
    },
  ],
}),
```

Then update the controller method signature.

File:

```text
/Users/belief/dev/projects/claude/claude_team/agent-teams-controller/src/internal/tasks.js
```

Change:

```js
async function memberBriefing(context, memberName) {
```

To:

```js
async function memberBriefing(context, memberName, options = {}) {
```

Inside the function:

```js
const explicitRuntimeProvider = options.runtimeProvider;
const inferredRuntimeProvider =
  explicitRuntimeProvider || (isOpenCodeMember(effectiveMember) ? 'opencode' : 'native');
const messagingProtocol = createMemberMessagingProtocol(inferredRuntimeProvider);
```

Update the TypeScript declaration too.

Files:

```text
/Users/belief/dev/projects/claude/claude_team/mcp-server/src/agent-teams-controller.d.ts
/Users/belief/dev/projects/claude/claude_team/src/types/agent-teams-controller.d.ts
```

Change:

```ts
memberBriefing(memberName: string): Promise<string>;
```

To:

```ts
memberBriefing(
  memberName: string,
  options?: { runtimeProvider?: 'native' | 'opencode' }
): Promise<string>;
```

Why this matters:

`mcp-server/src/tools/taskTools.ts` and app main-process TS code call into the JS controller through declarations. If both declarations are not updated, the implementation may work at runtime but fail typecheck or drift again later.

Acceptance:

- `member_briefing` with `runtimeProvider: "opencode"` emits OpenCode-safe instructions.
- `member_briefing` without `runtimeProvider` falls back to resolved member provider metadata.
- `member_briefing` without `runtimeProvider` and without OpenCode provider metadata remains native.
- `pnpm --filter agent-teams-mcp typecheck` stays green.

### Step 4 - Replace hardcoded `SendMessage` in member briefing and task protocol

File:

```text
/Users/belief/dev/projects/claude/claude_team/agent-teams-controller/src/internal/tasks.js
```

Change:

```js
function buildMemberTaskProtocol(teamName) {
```

To:

```js
function buildMemberTaskProtocol(teamName, messagingProtocol) {
```

Replace hardcoded lines like:

```text
After task_complete, notify your team lead via SendMessage.
```

Do not only change `buildMemberTaskProtocol()`. Current `memberBriefing()` also pushes direct top-level lines before `buildMemberTaskProtocol()`:

```text
CRITICAL: ... A SendMessage to the lead is NOT a substitute ...
After task_complete, notify your team lead via SendMessage ...
```

Those lines must also be generated from `messagingProtocol`; otherwise OpenCode still receives contradictory briefing text even if the long task protocol is fixed.

Also replace these protocol fragments:

```text
When sending a message about a specific task, include its short display label like #<displayId> in your SendMessage summary field...
STEP 3 - THEN, send a message to your team lead via SendMessage so they notice it promptly.
```

For OpenCode, the equivalent must mention `agent-teams_message_send` and its `summary` field, not `SendMessage`.

With protocol-specific text:

```js
const notifyLeadExample = messagingProtocol.buildLeadMessageExample({
  teamName,
  leadName: '<lead-name>',
  fromName: '<your-name>',
  text: '#abcd1234 done. Full details in task comment e5f6a7b8. Moving to #efgh5678.',
  summary: '#abcd1234 done',
});
```

Then use:

```text
After task_complete, notify your team lead via ${messagingProtocol.sendLeadPhrase}.
Example: ${notifyLeadExample}
```

Important OpenCode wording:

```text
When using agent-teams_message_send, always include teamName, to, from, text, and summary.
Always set from to your teammate name.
Do not answer only as plain assistant text when agent-teams_message_send is available.
For cross-team replies or messages to another team, use agent-teams_cross_team_send with toTeam/fromMember. Do not put "cross_team_send" or a remote team name into message_send.to.
```

Acceptance:

- Native text still uses `SendMessage`.
- OpenCode text does not instruct the model to call `SendMessage`.
- Board comment remains the durable primary result channel for both runtimes.
- Cross-team instructions remain on `cross_team_send`, not `message_send`.

### Step 5 - Fix task assignment notification protocol

File:

```text
/Users/belief/dev/projects/claude/claude_team/agent-teams-controller/src/internal/tasks.js
```

Current function:

```js
function buildAssignmentMessage(context, task, options = {}) {
```

Change to compute protocol:

```js
function buildAssignmentMessage(context, task, options = {}) {
  const messagingProtocol = options.messagingProtocol || createMemberMessagingProtocol('native');
  const ownerName = typeof task.owner === 'string' ? task.owner.trim() : '';
  const leadName = runtimeHelpers.inferLeadName(context.paths);
  ...
}
```

Where owner notification is sent, pass OpenCode protocol if owner is OpenCode:

```js
const owner = resolved.members.find(
  (member) => normalizeMemberName(member.name) === normalizeMemberName(task.owner)
);

const messagingProtocol = createMemberMessagingProtocol(
  isOpenCodeMember(owner) ? 'opencode' : 'native'
);

text: buildAssignmentMessage(context, task, {
  ...options,
  messagingProtocol,
}),
```

Acceptance:

- OpenCode owner receives assignment instructions using `agent-teams_message_send`.
- Native owner still receives `SendMessage`.

### Step 6 - Extend `message_send` with `taskRefs`

File:

```text
/Users/belief/dev/projects/claude/claude_team/mcp-server/src/tools/messageTools.ts
```

Storage already supports `taskRefs` in:

```text
/Users/belief/dev/projects/claude/claude_team/agent-teams-controller/src/internal/messageStore.js
```

Add schema:

```ts
taskRefs: z
  .array(
    z.object({
      taskId: z.string().min(1),
      displayId: z.string().min(1),
      teamName: z.string().min(1),
    })
  )
  .optional(),
```

Forward it:

```ts
...(taskRefs?.length ? { taskRefs } : {}),
```

Acceptance:

- OpenCode can include the same traceability metadata native prompts already mention.
- Existing `message_send` callers remain valid.
- `message_send({ to: "user", from: "<member>" })` continues to write `inboxes/user.json`, which the existing Messages feed already reads.

### Step 6.1 - Guard `message_send` replies to user against missing sender

Files:

```text
/Users/belief/dev/projects/claude/claude_team/mcp-server/src/tools/messageTools.ts
/Users/belief/dev/projects/claude/claude_team/agent-teams-controller/src/internal/messages.js
/Users/belief/dev/projects/claude/claude_team/agent-teams-controller/src/internal/messageStore.js
```

Current risk:

```js
from:
  typeof flags.from === 'string' && flags.from.trim()
    ? flags.from.trim()
    : defaults.from || 'user',
```

For `message_send({ teamName, to: "user", text: "done" })`, this writes:

```json
{ "from": "user", "to": "user", "text": "done" }
```

That row is durable, but it is not a teammate reply. It will not reliably clear pending reply state and can make the user think the OpenCode agent ignored the message.

Do not make `from` required for every `message_send` call in v1. That can break older/manual uses where `message_send` is acting as user-to-member delivery.

Preferred narrow guard:

```js
function assertUserDirectedMessageHasSender(context, flags) {
  const to = typeof flags.to === 'string' ? flags.to.trim().toLowerCase() : '';
  if (to !== 'user') return;

  const from = typeof flags.from === 'string' ? flags.from.trim() : '';
  if (!from || from.toLowerCase() === 'user') {
    throw new Error('message_send to user requires from to be the responding team member name');
  }

  runtimeHelpers.assertExplicitTeamMemberName(context.paths, from, 'from', {
    allowLeadAliases: true,
  });
}
```

Call it in `agent-teams-controller/src/internal/messages.js` before `messageStore.sendInboxMessage(...)`:

```js
function sendMessage(context, flags) {
  assertUserDirectedMessageHasSender(context, flags || {});
  return messageStore.sendInboxMessage(context.paths, flags);
}
```

Keep the MCP schema `from: z.string().optional()` so existing non-user-directed callers remain valid, but update the tool description:

```text
When to is "user", from is required and must be your configured teammate name.
```

Reason:

- OpenCode is instructed to include `from`, but model compliance is not a safety boundary.
- A tool error is better than a wrong durable `from: "user"` message row.
- This guard affects the generic Agent Teams MCP path, not only OpenCode, but only for semantically invalid user-directed messages.

Acceptance:

- `message_send({ to: "user", from: "bob" })` succeeds and writes `from: "bob"`.
- `message_send({ to: "user" })` fails with a clear actionable error.
- `message_send({ to: "user", from: "user" })` fails.
- `message_send({ to: "alice", text: "..." })` still succeeds and defaults to user-origin delivery for legacy/manual uses.
- OpenCode prompt examples continue to include `from: "<member>"`.

### Step 6.2 - Disambiguate `message_send` from `runtime_deliver_message`

Files:

```text
/Users/belief/dev/projects/claude/claude_team/mcp-server/src/tools/messageTools.ts
/Users/belief/dev/projects/claude/claude_team/mcp-server/src/tools/runtimeTools.ts
/Users/belief/dev/projects/claude/claude_team/src/main/services/team/runtime/OpenCodeTeamRuntimeAdapter.ts
/Users/belief/dev/projects/claude/claude_team/agent-teams-controller/src/internal/tasks.js
```

Current risk:

- `runtime_deliver_message` is visible in the same Agent Teams MCP server as `message_send`.
- Its description says it delivers an OpenCode runtime message to app-owned destinations.
- It really can write user/member/cross-team destinations through `RuntimeDeliveryService`.
- If prompts say "deliver a message" loosely, OpenCode can choose `runtime_deliver_message` instead of the v1 semantic reply tool.

Do not hide `runtime_deliver_message` from readiness or app tool availability proof. It is still required for runtime evidence and journal recovery paths.

Instead, make tool descriptions and OpenCode prompts explicitly route normal replies:

```ts
description: 'Send a visible team/user message. OpenCode teammates should use this for normal replies to the human user, lead, or same-team teammates. When to is "user", from is required and must be your configured teammate name.';
```

```ts
description: 'Low-level OpenCode runtime delivery journal tool. Use only when the runtime/app prompt explicitly provides runId, runtimeSessionId, idempotencyKey, and asks for runtime delivery. For normal visible replies, use message_send.';
```

OpenCode-specific prompt wording should avoid generic "deliver message" language:

```text
For normal visible replies, call agent-teams_message_send.
Do not use runtime_deliver_message for ordinary replies unless a runtime-delivery prompt explicitly asks for runId/runtimeSessionId/idempotencyKey delivery.
```

Acceptance:

- `message_send` description is the most obvious visible-message tool for OpenCode replies.
- `runtime_deliver_message` description says it is low-level and not the normal reply path.
- OpenCode launch/direct-message/task prompts do not use ambiguous "deliver a message" phrasing without naming `agent-teams_message_send`.
- Readiness still requires runtime tools where appropriate; this is prompt/tool-description disambiguation, not a capability removal.

### Step 6.3 - Canonicalize `message_send` recipients before persistence

Files:

```text
/Users/belief/dev/projects/claude/claude_team/agent-teams-controller/src/internal/messages.js
/Users/belief/dev/projects/claude/claude_team/agent-teams-controller/src/internal/messageStore.js
/Users/belief/dev/projects/claude/claude_team/agent-teams-controller/src/internal/runtimeHelpers.js
/Users/belief/dev/projects/claude/claude_team/mcp-server/src/tools/messageTools.ts
```

Current risk:

```js
const memberName =
  typeof flags.member === 'string' && flags.member.trim()
    ? flags.member.trim()
    : typeof flags.to === 'string' && flags.to.trim()
      ? flags.to.trim()
      : '';
appendRow(getInboxPath(paths, memberName), payload);
```

This writes the raw `to` string as the inbox filename.

Bad cases:

- `to: "team-lead"` when the actual configured lead is `lead` writes `inboxes/team-lead.json`; lead relay reads `inboxes/lead.json`.
- `to: "lead"` when the configured lead is `team-lead` can create a separate alias inbox.
- `to: "cross_team_send"` creates a misleading local inbox instead of a clear error telling the agent to use `cross_team_send`.
- `from: "team-lead"` can be stored as an alias instead of the canonical lead name, which breaks pending-reply and activity attribution.

Add a controller-level normalizer before `messageStore.sendInboxMessage()`:

```js
function normalizeMessageSendFlags(context, flags) {
  const next = { ...(flags || {}) };
  const rawTo = typeof next.to === 'string' ? next.to.trim() : '';

  if (!rawTo) {
    throw new Error('message_send requires to');
  }

  if (rawTo.toLowerCase() === 'user') {
    next.to = 'user';
  } else {
    const resolvedTo = runtimeHelpers.resolveExplicitTeamMemberName(context.paths, rawTo, {
      allowLeadAliases: true,
    });
    if (!resolvedTo && runtimeHelpers.looksLikeCrossTeamRecipient?.(rawTo)) {
      throw new Error('message_send cannot target another team. Use cross_team_send with toTeam.');
    }
    if (!resolvedTo && runtimeHelpers.looksLikeCrossTeamToolRecipient?.(rawTo)) {
      throw new Error(
        'message_send cannot target cross_team_send. Use cross_team_send with toTeam.'
      );
    }
    if (!resolvedTo) {
      throw new Error(`Unknown to: ${rawTo}. Use a configured team member name.`);
    }
    next.to = resolvedTo;
    next.member = next.to;
  }

  if (typeof next.from === 'string' && next.from.trim()) {
    const rawFrom = next.from.trim();
    if (rawFrom.toLowerCase() !== 'user') {
      next.from = runtimeHelpers.assertExplicitTeamMemberName(context.paths, rawFrom, 'from', {
        allowLeadAliases: true,
      });
    }
  }

  return next;
}
```

Then run the user-directed sender guard on the normalized flags.

Important:

- `to: "user"` remains a special destination and does not require a configured member named `user`.
- Local member/lead recipients must resolve to configured member names.
- Cross-team team names and cross-team tool names should not be silently treated as local inboxes. The error should tell the model to use `cross_team_send`.
- If the existing app intentionally supports dotted local member names, do not reject them when they are configured members. Resolve against config/members.meta before applying cross-team heuristics.
- If `runtimeHelpers` does not export cross-team recipient predicates today, add a small shared helper there instead of duplicating ad hoc regexes in `messages.js`.

Acceptance:

- `message_send({ to: "team-lead", from: "bob" })` writes to the actual configured lead inbox.
- `message_send({ to: "lead", from: "bob" })` also writes to the actual configured lead inbox when `lead` is a lead alias.
- `message_send({ to: "alice", from: "team-lead" })` stores `from` as the canonical configured lead name.
- `message_send({ to: "unknown", from: "bob" })` fails clearly instead of creating `inboxes/unknown.json`.
- `message_send({ to: "cross_team_send", from: "bob" })` fails with a `use cross_team_send` error.
- `message_send({ to: "user", from: "bob" })` remains valid and writes to `inboxes/user.json`.

### Step 6.4 - Decide cross-team `taskRefs` policy before helper generalization

Files:

```text
/Users/belief/dev/projects/claude/claude_team/mcp-server/src/tools/crossTeamTools.ts
/Users/belief/dev/projects/claude/claude_team/agent-teams-controller/src/internal/crossTeam.js
/Users/belief/dev/projects/claude/claude_team/src/shared/types/team.ts
```

Current fact:

- `CrossTeamMessage` and `CrossTeamSendRequest` already include `taskRefs`.
- `cross_team_send` MCP schema does not expose `taskRefs`.
- `agent-teams-controller/src/internal/crossTeam.js` does not persist `taskRefs` to target inbox or `sent-cross-team.json`.

Options:

Option A: keep cross-team `taskRefs` out of v1 prompts - 🎯 8 🛡️ 8 🧠 2, about 0-25 LOC
Safest if we want the smallest messaging seam. The helper must not accept or render `taskRefs` for `buildCrossTeamMessageExample()` yet.

Option B: wire cross-team `taskRefs` end-to-end now - 🎯 8 🛡️ 9 🧠 4, about 70-150 LOC
Best if the helper is meant to be a real semantic messaging seam with uniform traceability. Add `taskRefs` to `cross_team_send` schema, normalize it in controller, store it in target inbox row, append it to sent message, and persist it in `sent-cross-team.json`.

Chosen for v1 if Step 1 helper has a generic `taskRefs` option: Option B.
Chosen for v1 if Step 1 helper only renders static examples: Option A.

Implementation for Option B:

```ts
taskRefs: z
  .array(
    z.object({
      taskId: z.string().min(1),
      displayId: z.string().min(1),
      teamName: z.string().min(1),
    })
  )
  .optional(),
```

Controller storage should use the same shape as `messageStore.normalizeTaskRefs()`:

```js
const taskRefs = normalizeTaskRefs(flags.taskRefs);

list.push({
  ...,
  ...(taskRefs ? { taskRefs } : {}),
});

messageStore.appendSentMessage(context.paths, {
  ...,
  ...(taskRefs ? { taskRefs } : {}),
});

outList.push({
  ...,
  ...(taskRefs ? { taskRefs } : {}),
});
```

Acceptance:

- The helper never emits unsupported `taskRefs` for `cross_team_send`.
- If cross-team taskRefs are enabled, they persist in target inbox, local sent message, and `sent-cross-team.json`.
- `message_send` and `cross_team_send` taskRefs use identical validation rules.

### Step 7 - Centralize Agent Teams tool-name alias matching

Files:

```text
/Users/belief/dev/projects/claude/claude_team/src/main/services/team/agentTeamsToolNames.ts
/Users/belief/dev/projects/claude/claude_team/src/main/services/team/TeamProvisioningService.ts
/Users/belief/dev/projects/claude/claude_team/src/main/services/team/taskLogs/stream/OpenCodeTaskLogStreamSource.ts
/Users/belief/dev/projects/claude/claude_team/src/main/services/team/taskLogs/stream/BoardTaskLogStreamService.ts
```

Current risk:

`TeamProvisioningService.captureSendMessages()` recognizes only:

```ts
part.name === 'mcp__agent-teams__message_send';
```

But OpenCode and MCP tooling can expose names as:

```text
message_send
agent-teams_message_send
agent_teams_message_send
mcp__agent-teams__message_send
mcp__agent_teams__message_send
```

Add shared helpers:

```ts
const AGENT_TEAMS_PREFIXES = [
  'mcp__agent-teams__',
  'mcp__agent_teams__',
  'agent-teams_',
  'agent_teams_',
] as const;

export function canonicalizeAgentTeamsToolName(rawName: string): string {
  const normalized = rawName.trim().replace(/^proxy_/, '');
  for (const prefix of AGENT_TEAMS_PREFIXES) {
    if (normalized.startsWith(prefix)) {
      return normalized.slice(prefix.length);
    }
  }
  return normalized;
}

export function isAgentTeamsToolName(rawName: string, canonicalName: string): boolean {
  return canonicalizeAgentTeamsToolName(rawName).toLowerCase() === canonicalName.toLowerCase();
}
```

Do not treat every plain `message_send` in every transcript as Agent Teams. Add a stricter predicate for plain tool names:

```ts
export function isAgentTeamsToolUse(input: {
  rawName: string;
  canonicalName: string;
  toolInput?: Record<string, unknown>;
  currentTeamName?: string;
}): boolean {
  const rawName = input.rawName.trim();
  const canonical = canonicalizeAgentTeamsToolName(rawName);
  if (canonical.toLowerCase() !== input.canonicalName.toLowerCase()) {
    return false;
  }

  const hasKnownPrefix =
    rawName !== canonical || AGENT_TEAMS_PREFIXES.some((prefix) => rawName.startsWith(prefix));
  if (hasKnownPrefix) {
    return true;
  }

  // Plain names are accepted only when the payload looks like our app MCP contract.
  if (input.canonicalName === 'message_send') {
    return (
      typeof input.toolInput?.teamName === 'string' &&
      input.toolInput.teamName === input.currentTeamName &&
      typeof input.toolInput?.to === 'string' &&
      typeof input.toolInput?.text === 'string'
    );
  }

  return false;
}
```

This keeps OpenCode plain direct-MCP aliases working without broadening capture to arbitrary third-party tools with the same short name.

Then update `captureSendMessages()`:

```ts
const canonicalToolName = canonicalizeAgentTeamsToolName(part.name);
const isNativeSendMessage = part.name === 'SendMessage';
const isTeamMessageSendTool = isAgentTeamsToolUse({
  rawName: part.name,
  canonicalName: 'message_send',
  toolInput: input as Record<string, unknown>,
  currentTeamName: run.teamName,
});
const isDirectCrossTeamSendTool = isAgentTeamsToolUse({
  rawName: part.name,
  canonicalName: 'cross_team_send',
  toolInput: input as Record<string, unknown>,
  currentTeamName: run.teamName,
});
```

Keep the existing no-duplicate-persistence rule:

```ts
if (isDirectCrossTeamSendTool) {
  // Use this only to trigger cross-team refresh/fallback handling.
  continue;
}

if (!isNativeSendMessage) {
  // message_send persists through the MCP tool handler itself.
  // Do not also push a lead-process message here.
  continue;
}
```

Also update `TASK_BOUNDARY_TOOL_LINE_PATTERN` in the same file to include the same aliases as `canonicalizeAgentTeamsToolName()`:

```ts
const AGENT_TEAMS_PREFIXES = [
  'mcp__agent-teams__',
  'mcp__agent_teams__',
  'agent-teams_',
  'agent_teams_',
] as const;
```

Acceptance:

- Logs/capture/task-log code recognizes the same aliases that prompts and readiness allow.
- Existing `mcp__agent-teams__...` names still work.
- Plain `message_send` is only treated as Agent Teams when it appears in the known app/team runtime context and its input has our `teamName/to/text` shape for the current team.
- This does not automatically loosen production readiness. If readiness currently requires canonical OpenCode ids, keep that policy explicit and test it separately from transcript/capture alias parsing.
- Normal MCP `message_send` is not double-persisted as a lead-process message.
- Task boundary detection works for `agent-teams_task_start`, `agent_teams_task_start`, `mcp__agent-teams__task_start`, and proxy-prefixed forms.

### Step 8 - Move OpenCode runtime identity injection to orchestrator

File:

```text
/Users/belief/dev/projects/claude/agent_teams_orchestrator/src/services/opencode/OpenCodeBridgeCommandHandler.ts
```

Related app contract file:

```text
/Users/belief/dev/projects/claude/claude_team/src/main/services/team/opencode/bridge/OpenCodeBridgeCommandContract.ts
```

First clean up the duplicate app-side `OpenCodeSendMessageCommandBody` declarations in `OpenCodeBridgeCommandContract.ts`. TypeScript currently merges them, but this is too easy to edit incorrectly when adding run-id recovery. Keep a single declaration:

```ts
export interface OpenCodeSendMessageCommandBody {
  runId?: string;
  laneId: string;
  teamId: string;
  teamName: string;
  projectPath: string;
  memberName: string;
  text: string;
  messageId?: string;
  agent?: string;
  noReply?: boolean;
}
```

Current launch flow:

```ts
record = await openCodeSessionBridge.ensureSession(...)
await openCodeSessionBridge.promptAsync(record, {
  text: prompt,
  agent: 'teammate',
})
```

Add a helper:

```ts
function buildOpenCodeRuntimeIdentityBlock(input: {
  teamName: string;
  memberName: string;
  runId: string;
  runtimeSessionId: string;
}): string {
  const checkinPayload = {
    teamName: input.teamName,
    runId: input.runId,
    memberName: input.memberName,
    runtimeSessionId: input.runtimeSessionId,
  };

  const briefingPayload = {
    teamName: input.teamName,
    memberName: input.memberName,
    runtimeProvider: 'opencode',
  };

  return [
    '<opencode_runtime_identity>',
    'You are an OpenCode teammate managed by the desktop app.',
    'Your first app-team MCP action must be runtime bootstrap check-in.',
    `Call the exposed Agent Teams runtime_bootstrap_checkin tool, usually agent-teams_runtime_bootstrap_checkin or mcp__agent-teams__runtime_bootstrap_checkin, with: ${JSON.stringify(checkinPayload)}`,
    'After check-in succeeds, request your teammate rules.',
    `Call the exposed Agent Teams member_briefing tool, usually agent-teams_member_briefing or mcp__agent-teams__member_briefing, with: ${JSON.stringify(briefingPayload)}`,
    'For visible team/app messages, use the exposed Agent Teams message_send tool, usually agent-teams_message_send or mcp__agent-teams__message_send. Do not use SendMessage.',
    '</opencode_runtime_identity>',
  ].join('\n');
}
```

Wrap launch prompt:

```ts
const runtimeIdentityBlock = buildOpenCodeRuntimeIdentityBlock({
  teamName: teamId,
  memberName: name,
  runId,
  runtimeSessionId: record.opencodeSessionId,
});

await openCodeSessionBridge.promptAsync(record, {
  text: `${runtimeIdentityBlock}\n\n${prompt}`,
  agent: 'teammate',
});
```

Then add a bounded launch-settle helper before mapping the member as final `created`/`confirmed_alive`.

Reason:

`promptAsync()` only enqueues the OpenCode prompt. The current immediate `reconcileSession(record)` can run before the assistant/tool message materializes. That produces a false `created` state even when the teammate is about to call `runtime_bootstrap_checkin` or `member_briefing`.

Do not add this as a serial wait inside the existing member loop.

Options:

Option A: serial settle inside the existing loop - 🎯 4 🛡️ 5 🧠 2, about 30-60 LOC
Easy, but bad for UX. Three OpenCode teammates with an 8 second preview cap can add 24 seconds of launch latency.

Option B: two-phase launch with bounded concurrent settle - 🎯 8 🛡️ 8 🧠 5, about 140-260 LOC
First ensure sessions and enqueue prompts for all members. Then run bounded preview/reconcile concurrently per prompted member with a small local concurrency cap. This fixes early false `created` without multiplying wait time by teammate count or opening one preview stream per teammate in large teams.

Option C: no settle, rely only on later reconcile - 🎯 5 🛡️ 6 🧠 1, about 0-20 LOC
Avoids launch delay, but keeps the stale/early UI state that caused OpenCode teammates to look unspawned or stuck.

Chosen for v1: Option B with a local cap of 3 concurrent settle observers. Do not add a dependency just for this; use a tiny local mapper/helper in the orchestrator testable unit.

Example:

```ts
async function reconcileAfterOpenCodeLaunchPrompt(record: OpenCodeSessionRecord) {
  await openCodeSessionBridge
    .observePreview(record, {
      timeoutMs: 8_000,
      idleTimeoutMs: 1_500,
    })
    .catch(() => null);

  return openCodeSessionBridge.reconcileSession(record, { limit: 50 });
}
```

Restructure `runLaunch()` into two phases:

```ts
const promptedMembers: Array<{
  name: string;
  record: OpenCodeSessionRecord;
}> = [];

for (const item of membersRaw) {
  const record = await openCodeSessionBridge.ensureSession(...);
  await openCodeSessionBridge.promptAsync(record, {
    text: `${runtimeIdentityBlock}\n\n${prompt}`,
    agent: 'teammate',
  });
  promptedMembers.push({ name, record });
}

const settledMembers = await mapWithConcurrency(promptedMembers, 3, async ({ name, record }) => ({
    name,
    record,
    reconciled: await reconcileAfterOpenCodeLaunchPrompt(record),
  })
);
```

Keep per-member prompt/ensure failures isolated. If one member fails before prompt enqueue, mark only that member failed and still prompt/settle the rest.

Use the same bounded helper after permission-answer recovery paths where the UI expects launch state to advance, but keep it concurrent across lane records.

Do not wait indefinitely and do not convert preview timeout into `failed`. A settle timeout should fall back to the current reconcile result and leave the member in `runtime_pending_bootstrap`/`created` rather than producing a false hard failure.

Acceptance:

- Adapter does not need to know `opencodeSessionId`.
- Every OpenCode teammate receives exact session identity.
- `member_briefing` gets `runtimeProvider: "opencode"`.
- Identity prompt names the canonical OpenCode tool ids and acceptable exposed aliases, not only one spelling.
- `laneId` stays in `runLaunch()` as bridge/session routing context only.
- The identity helper should not accept `laneId`, so nobody accidentally serializes it into the MCP payload later.
- Launch state gets one short chance to observe tool-only/bootstrap assistant activity before deciding the bridge member state.
- Launch settle runs bounded-concurrently across OpenCode members, not serially and not unbounded.
- A launch-settle timeout is not a launch failure.

Also add a smaller recovery prefix in `runSendMessage()` when `body.runId` is present.

Reason:

If the initial launch prompt was interrupted before check-in, a later user message can help the OpenCode teammate self-heal. Do not invent a `runId` if `body.runId` is absent.

Example:

```ts
const runId = asString(body.runId);
const identityReminder = runId
  ? buildOpenCodeRuntimeIdentityBlock({
      teamName: teamId,
      memberName,
      runId,
      runtimeSessionId: record.opencodeSessionId,
    })
  : null;

await openCodeSessionBridge.promptAsync(record, {
  text: identityReminder ? `${identityReminder}\n\n${text}` : text,
  agent: asString(body.agent) ?? 'teammate',
  noReply: body.noReply === true,
});
```

Post-send reconcile must not redefine prompt acceptance.

Current `runSendMessage()` shape:

```ts
await openCodeSessionBridge.promptAsync(record, { text, agent, noReply });
const reconciled = await openCodeSessionBridge.reconcileSession(record, { limit: 50 });
return { accepted: true, diagnostics: reconciled.summary.diagnostics };
```

Risk:

- If `promptAsync()` succeeds but `reconcileSession()` throws or times out, the prompt may already be enqueued in OpenCode.
- Reporting `accepted: false` in that case makes the app retry a message that the agent might already process.
- That creates duplicate OpenCode prompts while the inbox row may still look unread.

Use this semantic split:

```ts
let reconcileDiagnostics: TeamDiagnostic[] = [];
let runtimePid: number | undefined;

await openCodeSessionBridge.promptAsync(record, {
  text: identityReminder ? `${identityReminder}\n\n${text}` : text,
  agent: asString(body.agent) ?? 'teammate',
  noReply: body.noReply === true,
});

try {
  const reconciled = await openCodeSessionBridge.reconcileSession(record, { limit: 50 });
  runtimePid = resolvedRuntimePidFrom(record, reconciled);
  reconcileDiagnostics = reconciled.summary.diagnostics.map((message) =>
    teamDiagnostic('opencode_send_reconcile', message, 'info')
  );
} catch (error) {
  reconcileDiagnostics = [
    teamDiagnostic(
      'opencode_send_reconcile_failed_after_prompt_accept',
      error instanceof Error ? error.message : String(error),
      'warning'
    ),
  ];
}

return {
  accepted: true,
  sessionId: record.opencodeSessionId,
  memberName,
  ...(runtimePid ? { runtimePid } : {}),
  diagnostics: reconcileDiagnostics,
};
```

Only `promptAsync()` failure should make `accepted: false` or throw as delivery failure. Reconcile failure after prompt acceptance is a warning diagnostic because it affects fresh runtime evidence, not whether the app handed the message to OpenCode.

Acceptance:

- `runSendMessage()` can repair missing check-in when it has a run id.
- `runSendMessage()` does not fabricate runtime identity when no run id exists.
- `runSendMessage()` returns `accepted: true` when `promptAsync()` succeeds even if post-send reconcile fails.
- `runSendMessage()` returns a warning diagnostic for post-accept reconcile failure, not a false delivery failure.
- App-side inbox relay can mark read after prompt acceptance without waiting for assistant reply text.

### Step 9 - Keep adapter prompt generic and non-conflicting

File:

```text
/Users/belief/dev/projects/claude/claude_team/src/main/services/team/runtime/OpenCodeTeamRuntimeAdapter.ts
```

Current prompt says:

```text
If available, your first app-team action is to call MCP tool agent-teams_member_briefing...
```

Change it so it does not conflict with orchestrator identity block:

```text
The desktop bridge may prepend runtime identity and bootstrap instructions. Follow those first.
After runtime identity check-in, call agent-teams_member_briefing with runtimeProvider="opencode" if you have not already done so.
```

Keep this line:

```text
When you need to message the human user, team lead, or another teammate, call MCP tool agent-teams_message_send...
```

Acceptance:

- No duplicate "first action" conflict.
- OpenCode launch remains understandable even if the orchestrator identity block is absent during tests.

### Step 9.5 - Guard native-only prompt boundaries

Files to audit:

```text
/Users/belief/dev/projects/claude/claude_team/src/main/services/team/TeamProvisioningService.ts
/Users/belief/dev/projects/claude/agent_teams_orchestrator/src/services/teamBootstrap/teamBootstrapPromptBuilder.ts
/Users/belief/dev/projects/claude/agent_teams_orchestrator/src/hooks/useInboxPoller.ts
/Users/belief/dev/projects/claude/agent_teams_orchestrator/src/utils/swarm/teammatePromptAddendum.ts
```

These files contain many valid native-runtime `SendMessage` instructions. They should not be bulk-replaced.

Risk:

- A naive global replacement breaks Codex/Claude native agents.
- Leaving them untouched is safe only if OpenCode teammates do not receive these native prompt paths.

Add routing guard tests instead of rewriting native prompts:

```ts
it('does not send native member spawn prompt to OpenCode runtime members', async () => {
  // Create mixed team with native alice and OpenCode bob.
  // Spy on native Agent/Codex spawn prompt builder and OpenCodeTeamRuntimeAdapter.launch.
  // Assert bob launch uses OpenCodeTeamRuntimeAdapter prompt.
  // Assert bob prompt contains agent-teams_message_send.
  // Assert bob prompt does not contain "Use the SendMessage tool".
});
```

```ts
it('keeps native teammate prompt using SendMessage', async () => {
  // Create native alice.
  // Assert native spawn prompt still contains SendMessage guidance.
});
```

For `teamBootstrapPromptBuilder` and `useInboxPoller`, add an explicit comment/test boundary:

```ts
// Native persistent-teammate bootstrap only. OpenCode runtime bootstrap is
// injected by OpenCodeBridgeCommandHandler and must not use this prompt path.
```

Acceptance:

- OpenCode teammates never receive generic native spawn/reconnect prompts that mention only `SendMessage`.
- Codex/Claude/Gemini native prompts are unchanged unless a runtime-specific helper is explicitly introduced.
- Future maintainers see that remaining `SendMessage` strings are not missed OpenCode work by default.

### Step 9.6 - Make OpenCode direct-message delivery explicit

Files:

```text
/Users/belief/dev/projects/claude/claude_team/src/main/ipc/teams.ts
/Users/belief/dev/projects/claude/claude_team/src/main/services/team/TeamProvisioningService.ts
/Users/belief/dev/projects/claude/claude_team/src/main/services/team/runtime/OpenCodeTeamRuntimeAdapter.ts
/Users/belief/dev/projects/claude/claude_team/src/main/services/team/runtime/index.ts
```

Current flow:

```ts
const memberDeliveryText = buildMessageDeliveryText(baseText, {
  actionMode,
  isLeadRecipient,
  replyRecipient: typeof payload.from === 'string' ? payload.from : 'user',
});

await sendMessage(... text: memberDeliveryText ...);

void provisioning.deliverOpenCodeMemberMessage(tn, {
  memberName,
  text: memberDeliveryText,
  messageId: result.messageId,
});
```

Then OpenCode-specific code does this:

```ts
const replyRecipient = extractRequestedReplyRecipient(input.text);
```

Risk:

- OpenCode receives native-only hidden wording that says `SendMessage`.
- Recipient routing depends on regex matching English prompt text.
- If `buildMessageDeliveryText()` wording changes, OpenCode may send to the wrong recipient or fall back to vague "requested recipient".
- `taskRefs` and action mode are embedded as text instead of explicit runtime metadata.

Options:

Option A: keep current text parsing - 🎯 4 🛡️ 5 🧠 1, about 0-15 LOC
Smallest, but fragile and contradicts the semantic seam goal.

Option B: pass explicit metadata while still sending the native stored text to OpenCode - 🎯 7 🛡️ 7 🧠 3, about 50-100 LOC
Better recipient reliability, but still leaves confusing `SendMessage` wording inside the OpenCode prompt.

Option C: keep native inbox text only for native recipients, persist base text for OpenCode recipients, and deliver an OpenCode-native runtime message - 🎯 9 🛡️ 9 🧠 6, about 180-320 LOC with tests
Best shape. Codex/Claude keep the existing persisted inbox text because they read inbox files directly. OpenCode inbox rows stay clean/retryable with base user text, while OpenCode receives explicit runtime delivery metadata through the adapter/relay.

Chosen for v1: Option C.

Add explicit fields:

```ts
import type { AgentActionMode, TaskRef } from '@shared/types';

export interface OpenCodeTeamRuntimeMessageInput {
  runId?: string;
  teamName: string;
  laneId: string;
  memberName: string;
  cwd: string;
  text: string;
  messageId?: string;
  replyRecipient?: string;
  actionMode?: AgentActionMode;
  taskRefs?: TaskRef[];
}
```

Update IPC call:

```ts
const baseText = payload.text!.trim();
const replyRecipient = typeof payload.from === 'string' && payload.from.trim()
  ? payload.from.trim()
  : 'user';
const memberDeliveryText = buildMessageDeliveryText(baseText, {
  actionMode,
  isLeadRecipient,
  replyRecipient,
});
const isOpenCodeRecipient = await provisioning.isOpenCodeRuntimeRecipient(tn, memberName);
const inboxText = isOpenCodeRecipient ? baseText : memberDeliveryText;

const result = await sendMessage(... text: inboxText ...);

if (isOpenCodeRecipient) {
  await provisioning.relayOpenCodeMemberInboxMessages(tn, memberName, {
    onlyMessageId: result.messageId,
    source: 'ui-send',
    deliveryMetadata: {
      replyRecipient,
      actionMode,
      taskRefs: validatedTaskRefs.value,
    },
  });
}
```

Keep the native inbox write unchanged for native recipients. For OpenCode recipients, do not persist native hidden `SendMessage` instructions into the inbox row; runtime delivery builds the OpenCode-native wrapper from metadata. This keeps FileWatcher retry safe after a transient OpenCode bridge failure.

Update `deliverOpenCodeMemberMessage()` signature:

```ts
input: {
  memberName: string;
  text: string;
  messageId?: string;
  replyRecipient?: string;
  actionMode?: AgentActionMode;
  taskRefs?: TaskRef[];
}
```

Update `buildOpenCodeRuntimeMessageText()`:

```ts
function buildOpenCodeRuntimeMessageText(input: OpenCodeTeamRuntimeMessageInput): string {
  const replyRecipient = input.replyRecipient?.trim() || 'user';
  const taskRefs = input.taskRefs?.length ? JSON.stringify(input.taskRefs) : null;

  return [
    '<opencode_app_message_delivery>',
    'You are running in OpenCode.',
    `Use agent-teams_message_send with teamName="${input.teamName}", to="${replyRecipient}", from="${input.memberName}", text, and summary.`,
    'Do not answer only as plain assistant text when agent-teams_message_send is available.',
    input.actionMode ? `Action mode for this message: ${input.actionMode}.` : null,
    taskRefs ? `If your reply is about these tasks, include taskRefs exactly: ${taskRefs}` : null,
    input.messageId ? `Inbound app messageId: ${input.messageId}.` : null,
    '</opencode_app_message_delivery>',
    '',
    input.text,
  ]
    .filter((line): line is string => line !== null)
    .join('\n');
}
```

Keep `extractRequestedReplyRecipient()` only as a fallback for older callers/tests, not as the normal path:

```ts
const replyRecipient =
  input.replyRecipient?.trim() || extractRequestedReplyRecipient(input.text) || 'user';
```

Acceptance:

- Stored member inbox text for native teammates remains unchanged.
- Stored member inbox text for OpenCode teammates is base user/team text, not native hidden `SendMessage` delivery instructions.
- OpenCode runtime delivery prompt does not contain native-only "CRITICAL: Reply using the SendMessage tool" wording.
- OpenCode recipient routing does not depend on regex-parsing hidden native instructions.
- `replyRecipient`, `actionMode`, and `taskRefs` are available to OpenCode as structured runtime metadata.
- Existing callers without `replyRecipient` still work through fallback parsing.

### Step 9.7 - Make OpenCode runtime delivery outcome observable

Files:

```text
/Users/belief/dev/projects/claude/claude_team/src/shared/types/team.ts
/Users/belief/dev/projects/claude/claude_team/src/main/ipc/teams.ts
/Users/belief/dev/projects/claude/claude_team/src/renderer/store/slices/teamSlice.ts
/Users/belief/dev/projects/claude/claude_team/src/renderer/components/team/messages/MessageComposer.tsx
/Users/belief/dev/projects/claude/claude_team/src/renderer/components/team/dialogs/SendMessageDialog.tsx
```

Current flow after persisting an inbox row:

```ts
if (!isLeadRecipient && isAlive) {
  void provisioning
    .deliverOpenCodeMemberMessage(tn, {
      memberName,
      text: memberDeliveryText,
      messageId: result.messageId,
    })
    .then(...)
    .catch(...);
}
```

Risk:

- The IPC call returns success before OpenCode runtime delivery succeeds or fails.
- Native teammates can still read the persisted inbox file, so fire-and-forget is acceptable there.
- OpenCode secondary lanes do not watch the member inbox file, so runtime delivery failure means the visible UI send can be a silent no-op for the agent.
- `SendMessageDialog` auto-closes on any `lastResult`, so adding a warning field without changing UI behavior can still hide the problem.
- Renderer `sendTeamMessage` currently returns `Promise<void>` and swallows IPC errors after setting store state. Existing caller `.catch(...)` blocks for pending-reply cleanup do not run.

Options:

Option A: keep fire-and-forget and add more logs - 🎯 5 🛡️ 5 🧠 1, about 10-30 LOC
This helps debugging but keeps the user-facing contract dishonest.

Option B: await OpenCode runtime relay for live OpenCode non-lead sends, return additive delivery status, and fix renderer action result/error propagation - 🎯 9 🛡️ 9 🧠 5, about 160-300 LOC with tests
This keeps native persistence behavior unchanged, makes OpenCode failure visible, keeps retry routing in one OpenCode inbox relay path, and fixes the existing dead caller catch path that controls pending-reply cleanup.

Option C: add a durable OpenCode delivery queue with retries and UI retry state - 🎯 8 🛡️ 10 🧠 8, about 350-700 LOC
This is the best long-term reliability shape, but it is too much to bundle into the semantic messaging seam unless delivery reliability remains flaky after v1.

Chosen for v1: Option B.

Add an optional result field:

```ts
export interface SendMessageRuntimeDeliveryResult {
  providerId?: TeamProviderId;
  attempted: boolean;
  delivered: boolean;
  reason?: string;
  diagnostics?: string[];
}

export interface SendMessageResult {
  deliveredToInbox: boolean;
  deliveredViaStdin?: boolean;
  messageId: string;
  deduplicated?: boolean;
  runtimeDelivery?: SendMessageRuntimeDeliveryResult;
}
```

Update `handleSendMessage()` after the inbox write:

```ts
let runtimeDelivery: SendMessageResult['runtimeDelivery'];

if (!isLeadRecipient && isAlive) {
  const delivery = await withTimeout(
    provisioning.relayOpenCodeMemberInboxMessages(tn, memberName, {
      onlyMessageId: result.messageId,
      source: 'ui-send',
      deliveryMetadata: {
        replyRecipient,
        actionMode,
        taskRefs: validatedTaskRefs.value,
      },
    }),
    12_000,
    { attempted: 1, delivered: 0, failed: 1, diagnostics: ['opencode_runtime_delivery_timeout'] }
  );

  if (delivery.attempted > 0) {
    const delivered = delivery.failed === 0 && delivery.delivered > 0;
    runtimeDelivery = {
      providerId: 'opencode',
      attempted: true,
      delivered,
      ...(!delivered
        ? { reason: delivery.diagnostics[0] ?? 'opencode_runtime_delivery_failed' }
        : {}),
      ...(delivery.diagnostics?.length ? { diagnostics: delivery.diagnostics } : {}),
    };
  }
}

return runtimeDelivery ? { ...result, runtimeDelivery } : result;
```

The timeout helper can be local to `teams.ts`. It must not cancel the underlying OpenCode bridge operation unless a cancellation primitive already exists; it only bounds the IPC response.

Renderer behavior:

```ts
function isRuntimeDeliveryFailed(result: SendMessageResult | null | undefined): boolean {
  return Boolean(result?.runtimeDelivery?.attempted && !result.runtimeDelivery.delivered);
}
```

Change the store action contract:

```ts
sendTeamMessage: (teamName: string, request: SendMessageRequest) => Promise<SendMessageResult>;
```

and implementation:

```ts
sendTeamMessage: async (teamName, request) => {
  set({ sendingMessage: true, sendMessageError: null, lastSendMessageResult: null });
  try {
    const result = await unwrapIpc('team:sendMessage', () =>
      api.teams.sendMessage(teamName, request)
    );
    // existing optimistic row and state update
    return result;
  } catch (error) {
    set({
      sendingMessage: false,
      lastSendMessageResult: null,
      sendMessageError: mapSendMessageError(error),
    });
    throw error;
  }
};
```

Update call sites so pending-reply state reflects actual delivery truth:

```ts
const result = await sendTeamMessage(teamName, request);
if (isRuntimeDeliveryFailed(result)) {
  clearPendingReplyFor(member, sentAtMs);
}
```

- `SendMessageDialog` should not auto-close when `isRuntimeDeliveryFailed(lastResult)` is true.
- `MessageComposer` and `SendMessageDialog` should show a concise warning such as: `Message saved, but OpenCode runtime delivery failed: <reason>`.
- Keep the optimistic user-sent message row, because the inbox write did succeed and is useful audit state.
- Do not surface `recipient_is_not_opencode`; native recipients should behave as before.

Acceptance:

- Sending to a native teammate returns the same result shape as today unless another existing field applies.
- Sending to a live OpenCode teammate returns `runtimeDelivery: { attempted: true, delivered: true }` when bridge delivery accepts the prompt.
- Sending to a live OpenCode teammate with bridge/runtime failure returns `runtimeDelivery.delivered === false`, leaves the message persisted, and keeps the dialog/composer warning visible.
- IPC/send failures reject the renderer store action after updating `sendMessageError`, so existing caller cleanup code runs.
- Pending-reply state is cleared when OpenCode runtime delivery fails, because the agent did not actually receive the live prompt.
- OpenCode runtime delivery uses base user text plus explicit metadata from Step 9.6, not native `memberDeliveryText`.
- IPC remains bounded; an OpenCode delivery hang cannot hang the UI indefinitely.

### Step 9.8 - Relay persisted OpenCode-targeted inbox messages to runtime lanes

Files:

```text
/Users/belief/dev/projects/claude/claude_team/src/main/index.ts
/Users/belief/dev/projects/claude/claude_team/src/main/ipc/teams.ts
/Users/belief/dev/projects/claude/claude_team/src/main/services/team/TeamProvisioningService.ts
/Users/belief/dev/projects/claude/claude_team/src/main/services/team/TeamInboxReader.ts
/Users/belief/dev/projects/claude/claude_team/src/main/services/team/TeamInboxWriter.ts
```

Current delivery split:

- Native teammates read their own `inboxes/<member>.json` files.
- Native lead does not read inbox files, so FileWatcher calls `relayLeadInboxMessages()` and that path writes into the native CLI stdin.
- UI-to-OpenCode direct messages are manually pushed through `deliverOpenCodeMemberMessage()`.
- OpenCode teammates do not watch inbox files, so a generic `message_send` into an OpenCode teammate inbox is not enough.
- Pure OpenCode runtime-adapter launches are marked alive through `runtimeAdapterRunByTeam`, but they do not create a `ProvisioningRun.child`; `relayLeadInboxMessages()` currently returns `0` in that shape.
- The current OpenCode bridge launch handler iterates `body.members` and creates teammate sessions only. `leadPrompt` is carried in the command body, but it does not currently create a stored `team-lead` OpenCode session.
- Existing `relayMemberInboxMessages()` is a native-lead-mediated relay. It sends an internal turn to the native lead and asks it to forward with `SendMessage`; do not reuse it for OpenCode-native runtime delivery.

Risk examples:

- OpenCode `bob` calls `agent-teams_message_send({ to: "jack", from: "bob", text: "please review" })`, and `jack` is also OpenCode.
- Task/system notification writes `inboxes/jack.json` for an OpenCode teammate.
- FileWatcher sees `inboxes/jack.json`, but current code intentionally skips non-lead relay because native teammates read their inbox files.
- A pure OpenCode team gets `message_send({ to: "team-lead", ... })`. FileWatcher treats it like a lead inbox, but there is no native stdin process and no proven OpenCode lead session to receive it. Marking it read would lose the message.

Options:

Option A: only support UI direct-send to OpenCode in v1 - 🎯 5 🛡️ 5 🧠 2, about 0-40 LOC
This leaves OpenCode-to-OpenCode and system notification routes unreliable. It is not enough for a real team messaging seam.

Option B: add OpenCode-targeted inbox runtime relay with messageId dedupe/read marking, plus explicit unsupported-lead diagnostics - 🎯 9 🛡️ 9 🧠 6, about 240-440 LOC with tests
This preserves native behavior, routes only recipients whose provider is OpenCode, and makes any persisted inbox row deliverable to live OpenCode lanes.

Option C: replace both native and OpenCode inbox handling with a new durable delivery queue - 🎯 8 🛡️ 10 🧠 9, about 600-1200 LOC
Architecturally clean long-term, but too large for this seam and risky with existing native watchers.

Chosen for v1: Option B.

Add one shared recipient-provider predicate and reuse it from both IPC send and relay:

```ts
async isOpenCodeRuntimeRecipient(teamName: string, memberName: string): Promise<boolean> {
  // Use the same config + members.meta provider resolution as deliverOpenCodeMemberMessage().
  // Do not infer solely from model label if explicit providerId/provider metadata exists.
}
```

This avoids a split-brain bug where `handleSendMessage()` persists base text because it thinks the recipient is OpenCode, while relay later treats the same recipient as native or unavailable.

Add a small routing selector so FileWatcher does not encode provider-specific details:

```ts
async relayInboxFileToLiveRecipient(
  teamName: string,
  inboxName: string,
  opts?: {
    source?: 'watcher' | 'ui-send' | 'manual';
    onlyMessageId?: string;
    deliveryMetadata?: {
      replyRecipient?: string;
      actionMode?: AgentActionMode;
      taskRefs?: TaskRef[];
    };
  }
): Promise<OpenCodeInboxRelayResult | NativeLeadRelayResult | InboxRelayNoopResult> {
  // 1. Resolve canonical lead name from config/data service.
  // 2. If inboxName is the lead and there is a current native run child, call relayLeadInboxMessages().
  // 3. If inboxName is OpenCode and there is a stored OpenCode session for that recipient, use OpenCode runtime relay.
  // 4. If inboxName is OpenCode lead but no lead session exists, return a visible diagnostic and do not mark rows read.
  // 5. If inboxName is native non-lead, no-op because native teammates read inbox files directly.
}
```

Do not make FileWatcher call `relayLeadInboxMessages()` directly after this change. The service selector owns the distinction between native lead, OpenCode member, unsupported OpenCode lead, and native teammate.

Add a provisioning service method for OpenCode runtime-addressable recipients:

```ts
async relayOpenCodeMemberInboxMessages(
  teamName: string,
  memberName: string,
  opts?: {
    onlyMessageId?: string;
    source?: 'watcher' | 'ui-send' | 'manual';
    deliveryMetadata?: {
      replyRecipient?: string;
      actionMode?: AgentActionMode;
      taskRefs?: TaskRef[];
    };
  }
): Promise<{ attempted: number; delivered: number; failed: number; diagnostics: string[] }> {
  // 1. Return immediately if recipient is not OpenCode.
  // 2. Read inboxes/<memberName>.json.
  // 3. Select unread messages with stable messageId, optionally restricted to onlyMessageId.
  // 4. Skip messageIds already delivered in a per-team/member dedupe set.
  // 5. For each message, call deliverOpenCodeMemberMessage() with:
  //    text: visible message text
  //    messageId
  //    replyRecipient: opts.deliveryMetadata?.replyRecipient || message.from || 'user'
  //    actionMode: opts.deliveryMetadata?.actionMode
  //    taskRefs: opts.deliveryMetadata?.taskRefs || message.taskRefs
  // 6. Mark successfully delivered rows read.
  // 7. Keep failed rows unread for retry unless the failure is terminal, e.g. recipient_removed.
}
```

Delivery commit semantics:

- The v1 relay is at-least-once with no data loss, not a new exactly-once queue.
- The durable commit is the inbox row read flag. A relay attempt is "successful" only after OpenCode prompt delivery is accepted and the specific inbox message is marked read.
- In-memory messageId dedupe is only for same-process FileWatcher bursts and UI-send/watch double events. Do not rely on it after app restart.
- If OpenCode accepts the prompt but `markInboxMessagesRead()` fails, return a diagnostic like `opencode_inbox_mark_read_failed_after_delivery`. The row remains retryable and may be delivered again. That is safer than marking an undelivered message read.
- Do not mark an OpenCode-targeted inbox row read before the bridge accepts the runtime prompt.
- Do not reuse `RuntimeDeliveryJournal` for this direction without a separate design. That journal models OpenCode runtime writing to app destinations via `runtime_deliver_message`; this relay is app-to-OpenCode prompt delivery.

OpenCode lead rule:

- Mixed team with native Codex/Claude/Gemini lead: keep the existing `relayLeadInboxMessages()` path.
- OpenCode teammate or secondary lane: use `relayOpenCodeMemberInboxMessages()`.
- Pure OpenCode lead inbox in v1: do not mark messages read and do not report delivery success unless a real stored OpenCode `team-lead` session exists. Return a diagnostic like `opencode_lead_runtime_session_missing`.
- Do not fake lead delivery by sending to a random teammate session. That would make messages appear delivered while the actual recipient never saw them.
- A future explicit OpenCode lead lane can reuse this selector by teaching the bridge to create/store a `team-lead` session and by passing `agent: "team-lead"` where the bridge supports it. That is not part of this v1 seam.

FileWatcher change:

```ts
return teamProvisioningService.relayInboxFileToLiveRecipient(teamName, inboxName, {
  source: 'watcher',
});
```

UI direct-send integration:

```ts
const result = await getTeamDataService().sendMessage(...);
const runtimeDelivery = await provisioning.relayOpenCodeMemberInboxMessages(tn, memberName, {
  onlyMessageId: result.messageId,
  source: 'ui-send',
  deliveryMetadata: { replyRecipient, actionMode, taskRefs: validatedTaskRefs.value },
});
```

For UI direct-send, Step 9.6 must persist base text for OpenCode recipients, not native `memberDeliveryText`. Then retry through FileWatcher is safe because the inbox row no longer contains native-only `SendMessage` instructions.

Do not add per-message schema fields unless needed. V1 can pass rich metadata directly for the immediate `ui-send` relay. Watcher/manual retries can fall back to `message.from`, `message.taskRefs`, and default action mode.

Acceptance:

- FileWatcher calls a single provisioning-service relay selector instead of embedding lead/member/provider routing itself.
- Native lead inbox messages still go through `relayLeadInboxMessages()` internally.
- FileWatcher still does not relay native teammate inbox messages.
- FileWatcher does relay unread inbox messages for OpenCode recipients through `deliverOpenCodeMemberMessage()`.
- Pure OpenCode lead inbox messages are not marked read or reported as delivered unless a real OpenCode lead runtime session exists.
- Pure OpenCode lead inbox messages without a runtime session produce an explicit diagnostic instead of silently returning success.
- UI direct-send to OpenCode does not double-deliver after FileWatcher sees the inbox write.
- Successful OpenCode runtime relay marks that specific inbox message read; in-memory dedupe only coalesces duplicate events before the read commit is visible.
- Failed transient OpenCode runtime relay leaves the row retryable and reports diagnostics.
- Prompt-accepted-but-mark-read-failed returns a diagnostic instead of pretending exactly-once success.
- OpenCode-to-OpenCode `message_send` becomes live-delivered to the target OpenCode lane.

### Step 10 - Expand OpenCode app MCP readiness proof

File:

```text
/Users/belief/dev/projects/claude/agent_teams_orchestrator/src/services/opencode/OpenCodeBridgeCommandHandler.ts
```

First decide how the required teammate-operational tool list is owned.

Option A: import `agent-teams-controller` into `agent_teams_orchestrator` - 🎯 5 🛡️ 6 🧠 6, about 80-160 LOC
This removes list duplication, but it adds a new package dependency from the runtime/orchestrator repo into the app controller package. That is a larger architecture decision than this fix needs.

Option B: keep an explicit direct-MCP required list in orchestrator v1 - 🎯 8 🛡️ 8 🧠 3, about 60-140 LOC
This matches the current repo boundary. The orchestrator only needs plain MCP names for direct `Client.listTools()` proof. Add tests that fail when critical teammate tools like `message_send`, `member_briefing`, `task_start`, or `cross_team_send` are missing.

Option C: generate a shared protocol contract artifact consumed by both repos - 🎯 8 🛡️ 9 🧠 7, about 250-450 LOC
This is the best long-term shape, but it needs generation, publishing, and CI checks. Treat it as a follow-up after v1 proves the semantic seam.

Chosen for v1: Option B. Do not import `agent-teams-controller` into `agent_teams_orchestrator` in this change.

Before editing, snapshot the current controller catalog from `claude_team`:

```bash
cd /Users/belief/dev/projects/claude/claude_team
node - <<'NODE'
const catalog = require('./agent-teams-controller/src/mcpToolCatalog.js')
console.log(catalog.AGENT_TEAMS_TEAMMATE_OPERATIONAL_TOOL_NAMES.join('\n'))
NODE
```

Use that output as the explicit orchestrator list for v1. This keeps the repo boundary clean while making the duplication intentional and reviewable.

Current proof only checks runtime tools:

```ts
const REQUIRED_AGENT_TEAMS_RUNTIME_TOOLS = [
  'runtime_bootstrap_checkin',
  'runtime_deliver_message',
  'runtime_task_event',
  'runtime_heartbeat',
] as const;
```

Change to route-specific direct MCP names.

Important:

- `Client.listTools()` returns plain names such as `message_send`.
- Do not prefix direct stdio results with `agent-teams_`.
- Only OpenCode app/API tool-id proof should deal with canonical ids like `agent-teams_message_send`.
- `agent_teams_message_send` is an accepted alias, not the canonical id produced by `buildOpenCodeCanonicalMcpToolId('agent-teams', 'message_send')`.
- The orchestrator explicit list should be treated as a boundary adapter, not as the source of truth for app-side UI/readiness.
- Keep `readiness.evidence.observedMcpTools` canonical if it is exposed through the bridge. If direct proof needs plain diagnostics, add a second private/internal field such as `observedDirectToolNames`.

```ts
const REQUIRED_AGENT_TEAMS_RUNTIME_PROOF_TOOLS = [
  'runtime_bootstrap_checkin',
  'runtime_deliver_message',
  'runtime_task_event',
  'runtime_heartbeat',
] as const;

const REQUIRED_AGENT_TEAMS_TEAMMATE_OPERATIONAL_TOOLS = [
  'member_briefing',
  'task_add_comment',
  'task_attach_comment_file',
  'task_attach_file',
  'task_briefing',
  'task_complete',
  'task_create',
  'task_create_from_message',
  'task_get',
  'task_get_comment',
  'task_link',
  'task_list',
  'task_set_clarification',
  'task_set_owner',
  'task_set_status',
  'task_start',
  'task_unlink',
  'review_approve',
  'review_request',
  'review_request_changes',
  'review_start',
  'message_send',
  'process_list',
  'process_register',
  'process_stop',
  'process_unregister',
  'cross_team_send',
  'cross_team_list_targets',
  'cross_team_get_outbox',
] as const;

const REQUIRED_AGENT_TEAMS_DIRECT_MCP_TOOL_NAMES = [
  ...REQUIRED_AGENT_TEAMS_RUNTIME_PROOF_TOOLS,
  ...REQUIRED_AGENT_TEAMS_TEAMMATE_OPERATIONAL_TOOLS,
] as const;
```

Update direct listTools mapping:

```ts
return (result.tools ?? [])
  .map((tool) => tool.name)
  .filter((name): name is string => typeof name === 'string' && name.trim().length > 0);
```

Compare plain names internally:

```ts
function matchAppMcpTools(observedDirectToolNames: string[], route: string): AppMcpToolProof {
  const observedDirect = new Set(observedDirectToolNames)
  const missingTools = REQUIRED_AGENT_TEAMS_DIRECT_MCP_TOOL_NAMES.filter(
    tool => !observedDirect.has(tool)
  )
  ...
}
```

But emit canonical ids for bridge readiness/evidence:

```ts
function buildOpenCodeCanonicalMcpToolId(toolName: string): string {
  return `${OPEN_CODE_APP_MCP_SERVER_NAME}_${toolName}`;
}

function matchAppMcpTools(observedDirectToolNames: string[], route: string): AppMcpToolProof {
  const observedDirect = new Set(observedDirectToolNames);
  const missingTools = REQUIRED_AGENT_TEAMS_DIRECT_MCP_TOOL_NAMES.filter(
    (tool) => !observedDirect.has(tool)
  );

  return {
    ok: missingTools.length === 0,
    observedTools: uniqueSortedStrings(
      observedDirectToolNames.map(buildOpenCodeCanonicalMcpToolId)
    ),
    observedDirectToolNames: uniqueSortedStrings(observedDirectToolNames),
    missingTools,
    diagnostics:
      missingTools.length === 0
        ? []
        : [`OpenCode app MCP tools missing from ${route}: ${missingTools.join(', ')}`],
    route,
  };
}
```

If you do not want to widen `AppMcpToolProof`, skip `observedDirectToolNames`, but still keep `observedTools` canonical because `readiness.evidence.observedMcpTools` feeds production evidence.

Acceptance:

- Readiness fails before launch if OpenCode cannot see a tool that `member_briefing` may instruct it to use.
- Cache/dedupe behavior stays unchanged.
- The list intentionally excludes lead-only tools like `lead_briefing` and non-teammate groups, but includes all teammate-operational catalog groups including cross-team.
- Diagnostics can still display `agent-teams/<tool>` labels, but matching must use plain direct MCP names.
- Public readiness/evidence still exposes canonical ids like `agent-teams_message_send`, not plain direct names, so production evidence remains comparable to `REQUIRED_AGENT_TEAMS_APP_TOOL_IDS`.

### Step 11 - Expand app-side OpenCode MCP tool availability proof

File:

```text
/Users/belief/dev/projects/claude/claude_team/src/main/services/team/opencode/mcp/OpenCodeMcpToolAvailability.ts
/Users/belief/dev/projects/claude/claude_team/src/main/services/team/opencode/bridge/OpenCodeReadinessBridge.ts
```

Current required tools only include runtime tools. Add separate lists and make every app-side place that expresses "launch-visible Agent Teams MCP tools" use the full app tool list.

Important current-shape note:

- Normal UI launch readiness goes through `OpenCodeTeamRuntimeAdapter -> OpenCodeReadinessBridge -> agent_teams_orchestrator`.
- `OpenCodeTeamLaunchReadinessService` and `OpenCodeMcpToolAvailabilityProbe` still have tests and policy helpers, but they are not the only production launch path.
- Therefore this step is mostly about shared app-side constants and production gate expectations. The actual live proof still happens in the orchestrator direct MCP preflight from Step 10.

Preferred pattern:

```ts
import * as agentTeamsControllerModule from 'agent-teams-controller';

const AGENT_TEAMS_TEAMMATE_OPERATIONAL_TOOL_NAMES =
  agentTeamsControllerModule.AGENT_TEAMS_TEAMMATE_OPERATIONAL_TOOL_NAMES;

export const REQUIRED_AGENT_TEAMS_RUNTIME_PROOF_TOOLS = [
  'runtime_bootstrap_checkin',
  'runtime_deliver_message',
  'runtime_task_event',
  'runtime_heartbeat',
] as const;

export const REQUIRED_AGENT_TEAMS_TEAMMATE_OPERATIONAL_TOOLS: readonly string[] = [
  ...AGENT_TEAMS_TEAMMATE_OPERATIONAL_TOOL_NAMES,
] as const;

export const REQUIRED_AGENT_TEAMS_APP_TOOLS: readonly string[] = [
  ...REQUIRED_AGENT_TEAMS_RUNTIME_PROOF_TOOLS,
  ...REQUIRED_AGENT_TEAMS_TEAMMATE_OPERATIONAL_TOOLS,
] as const;

export const REQUIRED_AGENT_TEAMS_APP_TOOL_IDS = REQUIRED_AGENT_TEAMS_APP_TOOLS.map((tool) =>
  buildOpenCodeCanonicalMcpToolId('agent-teams', tool)
);
```

Why typed as `readonly string[]`:

- The controller catalog is a CommonJS runtime export typed by `.d.ts`, not a literal tuple inside this TS file.
- Keeping app/full lists as `readonly string[]` avoids pretending the spread catalog is a compile-time literal tuple.
- `REQUIRED_AGENT_TEAMS_RUNTIME_PROOF_TOOLS` remains a literal tuple because runtime schema contracts depend on exact names.

Add a small import-shape test:

```ts
it('loads teammate-operational tool names from agent-teams-controller package main', () => {
  expect(REQUIRED_AGENT_TEAMS_TEAMMATE_OPERATIONAL_TOOLS).toContain('message_send');
  expect(REQUIRED_AGENT_TEAMS_TEAMMATE_OPERATIONAL_TOOLS).toContain('cross_team_send');
  expect(REQUIRED_AGENT_TEAMS_TEAMMATE_OPERATIONAL_TOOLS).not.toContain('lead_briefing');
});
```

Acceptance:

- App-side readiness policy and orchestrator readiness proof agree semantically, even though the orchestrator matches plain direct names and the app production gate expects canonical OpenCode ids.
- Missing app tools are classified as launch-blocking.
- Runtime schema verification still only applies to runtime tools. Operational tools can be name-proven first unless their schemas become part of the launch-critical contract.
- The app-side list follows `agent-teams-controller/src/mcpToolCatalog.js`, so adding a new teammate-operational tool updates readiness automatically.
- Existing callers that truly mean runtime schema tools should use `REQUIRED_AGENT_TEAMS_RUNTIME_PROOF_TOOLS`, not the full app list.
- Existing callers that mean launch-visible app tools should use `REQUIRED_AGENT_TEAMS_APP_TOOLS` or `REQUIRED_AGENT_TEAMS_APP_TOOL_IDS`.

### Step 12 - Keep app tool proof in readiness only

Files:

```text
/Users/belief/dev/projects/claude/claude_team/src/main/services/team/opencode/bridge/OpenCodeReadinessBridge.ts
/Users/belief/dev/projects/claude/claude_team/src/main/services/team/opencode/mcp/OpenCodeMcpToolAvailability.ts
```

Current rule:

- OpenCode launch readiness should not require a project-scoped proof artifact.
- App tool proof belongs in the live readiness path through capability, runtime-store, MCP tool, and execution checks.
- If tool requirements change, update `OpenCodeMcpToolAvailability` and readiness tests directly.

Acceptance:

- `message_send`, `member_briefing`, `task_start`, and `cross_team_send` are covered by readiness tests.
- Missing app MCP tools fails readiness directly with a clear diagnostic.
- No project-specific artifact is required to create or launch a team.

### Step 13 - Resolve secondary lane current-run evidence from lane manifest

Files:

```text
/Users/belief/dev/projects/claude/claude_team/src/main/services/team/TeamProvisioningService.ts
/Users/belief/dev/projects/claude/claude_team/src/main/services/team/opencode/store/OpenCodeRuntimeManifestEvidenceReader.ts
/Users/belief/dev/projects/claude/claude_team/src/main/services/team/opencode/store/RuntimeStoreManifest.ts
```

Important correction after code inspection:

- `OpenCodeRuntimeLaneIndexEntry` currently has `laneId`, `state`, `updatedAt`, and `diagnostics`.
- The durable run identity is already represented by `RuntimeStoreManifest.activeRunId`.
- Do not add `activeRunId` to `lanes.json` in v1. That would create a second source of truth and a new drift path.
- Use `lanes.json` only as the active/degraded/stopped lane directory index.
- Use the lane-scoped manifest as the authoritative durable run identity.

Current lane index shape should stay narrow:

```ts
export interface OpenCodeRuntimeLaneIndexEntry {
  laneId: string;
  state: 'active' | 'stopped' | 'degraded';
  updatedAt: string;
  diagnostics?: string[];
}
```

Use the existing manifest reader:

```ts
const evidence = await new OpenCodeRuntimeManifestEvidenceReader({
  teamsBasePath: getTeamsBasePath(),
}).read(teamName, laneId);

const activeRunId = evidence.activeRunId?.trim() || null;
```

Add a narrow helper in `TeamProvisioningService`:

```ts
private async resolveDurableOpenCodeRuntimeRunId(
  teamName: string,
  laneId: string
): Promise<string | null> {
  const live = this.getCurrentOpenCodeRuntimeRunId(teamName, laneId);
  if (live) return live;

  const laneIndex = await readOpenCodeRuntimeLaneIndex(getTeamsBasePath(), teamName).catch(
    () => null
  );
  const laneEntry = laneIndex?.lanes[laneId];
  if (laneEntry?.state !== 'active') {
    return null;
  }

  const manifest = await new OpenCodeRuntimeManifestEvidenceReader({
    teamsBasePath: getTeamsBasePath(),
  })
    .read(teamName, laneId)
    .catch(() => null);

  return manifest?.activeRunId?.trim() || null;
}
```

Do not let `read()` legacy fallback accidentally revive unrelated lanes. The helper must first require `lanes.json` to say the specific lane is `active`; then it may read the lane-scoped manifest. If the lane is `degraded` or missing, return `null` and let the existing stale-lane recovery path handle it.

Then consume the durable run id in three places.

1. Runtime evidence acceptance:

Current risk:

```ts
currentRunId: this.getCurrentOpenCodeRuntimeRunId(input.teamName, input.laneId),
```

`getCurrentOpenCodeRuntimeRunId()` currently uses in-memory maps. After app restart, a still-running OpenCode lane can call `runtime_bootstrap_checkin`, but `RuntimeRunTombstoneStore.assertEvidenceAccepted()` rejects it with `current_run_missing`.

Change to async durable resolution:

```ts
const currentRunId = await this.resolveDurableOpenCodeRuntimeRunId(input.teamName, input.laneId);

await store.assertEvidenceAccepted({
  teamName: input.teamName,
  runId: input.runId,
  currentRunId,
  evidenceKind: input.evidenceKind,
});
```

2. Message delivery recovery:

Current risk:

```ts
if (!trackedRunId) {
  const laneIndex = await readOpenCodeRuntimeLaneIndex(...)
  if (laneIndex?.lanes[laneIdentity.laneId]?.state !== 'active') {
    return { delivered: false, reason: 'opencode_runtime_not_active' };
  }
}

const result = await adapter.sendMessageToMember({
  ...(trackedRunId ? { runId: trackedRunId } : {}),
  ...
});
```

This checks durable active state but drops durable `activeRunId`, so `runSendMessage()` cannot prepend the identity reminder after restart.

Use a resolved run id:

```ts
const durableRunId = trackedRunId
  ? trackedRunId
  : await this.resolveDurableOpenCodeRuntimeRunId(teamName, laneIdentity.laneId);
if (!trackedRunId && !durableRunId) {
  return { delivered: false, reason: 'opencode_runtime_not_active' };
}

const result = await adapter.sendMessageToMember({
  ...(durableRunId ? { runId: durableRunId } : {}),
  ...
});
```

3. Runtime delivery service current-run resolver:

Current risk:

```ts
getCurrentRunId: async (candidateTeamName) =>
  this.getCurrentOpenCodeRuntimeRunId(candidateTeamName, laneId),
```

This is used by `runtime_deliver_message` delivery journaling. After restart, it has the same in-memory-only weakness. Change it to:

```ts
getCurrentRunId: async (candidateTeamName) =>
  this.resolveDurableOpenCodeRuntimeRunId(candidateTeamName, laneId),
```

Acceptance:

- Do not add `activeRunId` to `lanes.json` in v1.
- `runtime_bootstrap_checkin` and `runtime_heartbeat` can be accepted after app restart when `lanes.json` says the lane is active and the lane-scoped manifest has `activeRunId`.
- UI/user messages to an OpenCode secondary lane after app restart pass the manifest `activeRunId` to `opencode.sendMessage`, allowing identity reminder recovery.
- `runtime_deliver_message` current-run checks use the same durable manifest fallback.
- Stale lane recovery still degrades missing lane state.
- This supports `runtime_bootstrap_checkin`; normal messages still use `message_send`.

### Step 14 - Guard runtime delivery team-change event shape

Files:

```text
/Users/belief/dev/projects/claude/claude_team/src/main/services/team/TeamProvisioningService.ts
/Users/belief/dev/projects/claude/claude_team/src/main/services/team/opencode/delivery/RuntimeDeliveryService.ts
/Users/belief/dev/projects/claude/claude_team/src/shared/types/team.ts
/Users/belief/dev/projects/claude/claude_team/src/main/index.ts
```

Current contracts:

```ts
export interface RuntimeDeliveryTeamChangeEvent {
  type: string;
  teamName: string;
  data?: Record<string, unknown>;
}
```

```ts
export interface TeamChangeEvent {
  type: TeamChangeEventType;
  teamName: string;
  runId?: string;
  detail?: string;
  taskId?: string;
}
```

Do not leak `RuntimeDeliveryTeamChangeEvent` directly to renderer or `src/main/index.ts`.

Keep the adapter in `createOpenCodeRuntimeDeliveryService()` explicit:

```ts
emit: (event) => {
  this.teamChangeEmitter?.({
    type: event.type as TeamChangeEvent['type'],
    teamName: event.teamName,
    detail: typeof event.data?.detail === 'string' ? event.data.detail : undefined,
  });
};
```

Reason:

- `TeamMessageFeedService` cache invalidation currently happens on `type === "inbox"` or `type === "lead-message"`, so OpenCode replies can still become visible by type alone.
- Renderer message refresh also schedules on `event.type`, not `event.detail`.
- But app-side relay, native notification, and several filesystem-derived branches inspect top-level `event.detail`, not `event.data.detail`.
- If future code emits `data.detail` directly, the UI may still refresh sometimes, while relay/notification behavior silently diverges.

Acceptance:

- Runtime delivery destination ports may continue returning local `data.detail`.
- Only the app-facing `TeamChangeEvent` crosses the `TeamProvisioningService` boundary.
- App-facing runtime delivery events expose top-level `detail` for `inboxes/user.json`, `sentMessages.json`, and cross-team outbox changes.
- No frontend fake refresh is added.
- No change is required to `RuntimeDeliveryService` itself unless tests show the local event shape has already leaked outside the adapter.

### Step 15 - Keep frontend changes bounded and truth-based

Expected frontend changes: store action contract plus warning/display behavior only.

Reason:

- `TeamInboxReader` already reads `inboxes/user.json`.
- `TeamMessageFeedService` already merges inbox messages.
- `src/renderer/store/index.ts` schedules message refresh on `event.type === "inbox"` and `event.type === "lead-message"`.
- `MessagesPanel` already clears pending replies when a message has `to === "user"`.
- Step 9.7 requires the renderer store action to return `SendMessageResult` and rethrow real send failures after setting store error state.
- Step 9.7 requires `MessagesPanel`/`SendMessageDialog` to surface OpenCode runtime delivery failure as a warning, not as a fake agent reply.

Do not add a frontend fake "agent answered" path. Frontend may show "message saved but runtime delivery failed" because that is real delivery state; it must not synthesize teammate thoughts/replies.

## Remaining Uncertainty Register

These are the places most likely to produce regressions if implemented casually.

1. Canonical OpenCode MCP id spelling - 🎯 8 🛡️ 8 🧠 3, about 20-50 LOC in tests
   `buildOpenCodeCanonicalMcpToolId('agent-teams', 'message_send')` keeps the dash in `agent-teams_message_send`. Direct MCP stdio proof uses plain `message_send`. Transcript parsing accepts aliases. Add tests for these contexts so nobody normalizes everything to underscore by accident.

2. Orchestrator explicit teammate tool list drift - 🎯 7 🛡️ 7 🧠 4, about 40-90 LOC in tests
   The v1 orchestrator list is duplicated by design to avoid adding a dependency. This is acceptable only if tests cover the current controller teammate-operational catalog snapshot, including attachment/link/create/cross-team tools. If this fails repeatedly, move to Option C from Step 10: generated shared protocol contract.

3. Runtime provider inference - 🎯 7 🛡️ 8 🧠 4, about 60-120 LOC with tests
   `runtimeProvider: "opencode"` is the most reliable signal and should be sent by orchestrator. Provider metadata inference is a fallback for controller-generated messages and manual briefing calls. Native fallback must remain default when neither explicit runtimeProvider nor OpenCode metadata is present.

4. Production evidence freshness - 🎯 8 🛡️ 9 🧠 3, about 30-80 LOC in tests
   Old evidence that proves runtime tools only must fail production gate after this change. This is intentional. The diagnostic must explain which app MCP tools are missing so regeneration is obvious.

5. Model compliance versus protocol availability - 🎯 6 🛡️ 8 🧠 5, about 80-180 LOC with event tests
   The protocol can make the correct tools visible and instruct the model correctly, but the model may still answer in plain text. The reliable app truth should be: runtime check-in proves the lane is alive, `message_send` proves visible user/team response, and tool-only assistant events still count as `latestAssistantMessageId` for launch liveness.

6. OpenCode send-message command durability - 🎯 7 🛡️ 7 🧠 4, about 40-120 LOC if kept direct, 140-260 LOC if moved into the state-changing bridge
   `OpenCodeReadinessBridge.sendOpenCodeTeamMessage()` currently executes `opencode.sendMessage` directly, while launch/reconcile/stop go through `OpenCodeStateChangingBridgeCommandService`. For this seam, do not expand scope unless needed: keep direct send, require adapter callers to pass `runId`, and use the runId only for identity reminder/recovery. Treat `promptAsync()` success as delivery acceptance; post-send reconcile failure is a warning, not a false delivery failure. If stale-send bugs continue, promote `opencode.sendMessage` into the state-changing command service as a separate reliability pass.

7. Cross-team transport split - 🎯 8 🛡️ 9 🧠 4, about 50-120 LOC in prompt helper/tests
   OpenCode needs two visible messaging transports: `message_send` for local user/lead/member messages, and `cross_team_send` for remote teams. Collapsing both into `message_send` would resurrect the exact bug existing prompts warn about: treating `cross_team_send` as a recipient. The helper should expose both phrases/examples, but implementation remains narrow because it only affects wording and tests.

8. Direct-proof output shape - 🎯 8 🛡️ 9 🧠 4, about 40-100 LOC in orchestrator/tests
   The orchestrator direct MCP proof must match plain names from `Client.listTools()`, but `readiness.evidence.observedMcpTools` should remain canonical ids because production evidence consumes it. This is a boundary-shape risk, not a model behavior risk. Add tests that plain direct names pass matching while public bridge evidence contains `agent-teams_message_send`.

8.1 Plain tool-name false positives - 🎯 8 🛡️ 8 🧠 3, about 25-70 LOC with tests
Alias parsing must accept plain `message_send` for OpenCode direct MCP proof/capture, but a plain name alone is not enough in arbitrary transcripts. For capture/log paths, require Agent Teams payload shape and current team match before treating a plain short name as our tool. Canonical/prefixed names remain accepted directly.

9. Durable run id consumption - 🎯 9 🛡️ 9 🧠 5, about 90-180 LOC with tests
   `activeRunId` already lives in the lane-scoped `RuntimeStoreManifest`; `lanes.json` only proves lane state. Bootstrap evidence acceptance, runtime delivery journaling, and message delivery must read the manifest when in-memory run maps are empty after app restart. Without this, OpenCode lanes can be active in `lanes.json` but still reject check-in or send messages without identity recovery. Do not add a duplicate run id field to `lanes.json` in v1.

10. Cross-team taskRefs mismatch - 🎯 7 🛡️ 8 🧠 4, about 0-25 LOC if forbidden in v1, 70-150 LOC if wired end-to-end
    Shared types already include `taskRefs` for cross-team messages, but `cross_team_send` schema/controller do not persist them. The semantic helper must not generate unsupported fields. Either explicitly forbid cross-team taskRefs in v1 helper examples or wire schema/storage/tests now.

11. OpenCode direct-message metadata - 🎯 9 🛡️ 9 🧠 5, about 120-220 LOC with tests
    OpenCode runtime delivery should not parse native `SendMessage` prompt text to discover the reply recipient. Pass `replyRecipient`, `actionMode`, and `taskRefs` as explicit adapter metadata, and build a separate OpenCode-native delivery prompt. This lowers model confusion and removes regex coupling to `buildMessageDeliveryText()`.

12. Runtime delivery event adapter shape - 🎯 9 🛡️ 9 🧠 3, about 20-60 LOC in tests
    `RuntimeDeliveryService` uses a local `data.detail` envelope, but the app uses `TeamChangeEvent.detail`. The existing adapter maps it correctly. Test this so a future refactor does not bypass the adapter and make OpenCode replies visible in some UI paths while relay/notification/detail-sensitive paths silently miss the change.

13. User-directed `message_send` sender identity - 🎯 9 🛡️ 9 🧠 3, about 35-90 LOC with tests
    The protocol cannot rely only on prompt text saying "include from". If `from` is absent for `to: "user"`, the controller currently creates a durable user-to-user row. Add a narrow guard that rejects missing/invalid sender only for user-directed MCP messages, while keeping legacy user-to-member `message_send` defaults intact.

14. OpenCode direct-message delivery acknowledgement - 🎯 9 🛡️ 9 🧠 5, about 130-260 LOC with tests
    The send-message IPC path currently treats inbox persistence as success and starts OpenCode runtime delivery asynchronously. That is okay for native teammates because they watch/read inbox files, but not for OpenCode lanes. Add an additive runtime delivery result and fix the renderer store action to return/rethrow, so UI can distinguish "message saved" from "OpenCode runtime actually received the prompt" and pending replies do not hang on hidden failures.

15. Runtime delivery tool ambiguity - 🎯 8 🛡️ 8 🧠 3, about 25-70 LOC with tests
    `runtime_deliver_message` can write real destinations, so it is not safe to rely on the name alone and hope the model chooses `message_send`. V1 should keep it available for runtime evidence but make descriptions/prompts explicit that normal visible replies use `message_send`, while runtime delivery is a low-level idempotent path only when explicitly requested.

16. OpenCode-targeted inbox relay - 🎯 9 🛡️ 9 🧠 6, about 240-440 LOC with tests
    The app currently has special relay for native lead inboxes and native teammate file-watch behavior, but OpenCode teammates do not watch `inboxes/<member>.json`. Any plan that only fixes UI direct-send still leaves OpenCode-to-OpenCode and system notification routes unreliable. Add recipient-provider-aware runtime relay with at-least-once semantics, read-flag commit, duplicate-event dedupe, and explicit unsupported OpenCode lead diagnostics. Do not reuse native `relayMemberInboxMessages()`.

17. `message_send` recipient canonicalization - 🎯 9 🛡️ 9 🧠 4, about 70-150 LOC with tests
    Raw recipient names currently become inbox filenames. This is fragile because prompts and tests use lead aliases like `team-lead` while teams can have a custom lead name. Resolve `to` and `from` against configured members before persistence, with `user` as the only special local destination and cross-team tool names rejected clearly.

18. OpenCode lead runtime session gap - 🎯 8 🛡️ 9 🧠 5, about 60-140 LOC for v1 diagnostics, 300-700 LOC if adding a real lead lane
    The app-side OpenCode adapter passes `leadPrompt`, but the orchestrator launch handler currently creates sessions from `body.members` only. `relayLeadInboxMessages()` also requires native `run.child`. V1 must not pretend pure OpenCode lead inbox delivery works. Either route to an existing stored `team-lead` OpenCode session if one is later introduced, or leave rows unread with an explicit diagnostic. Creating a real OpenCode lead lane is a separate feature, not a hidden side effect of this messaging seam.

## Tests

### `claude_team` MCP/controller tests

File:

```text
/Users/belief/dev/projects/claude/claude_team/mcp-server/test/tools.test.ts
/Users/belief/dev/projects/claude/claude_team/agent-teams-controller/test/controller.test.js
```

Add tests:

```ts
it('returns OpenCode-safe member briefing when runtimeProvider is opencode', async () => {
  const briefing = await getTool('member_briefing').execute({
    claudeDir,
    teamName,
    memberName: 'bob',
    runtimeProvider: 'opencode',
  });

  const text = (briefing as { content: Array<{ text: string }> }).content[0]?.text ?? '';
  expect(text).toContain('agent-teams_message_send');
  expect(text).not.toMatch(/via SendMessage|SendMessage summary field/);
});
```

```ts
it('keeps native member briefing using SendMessage by default', async () => {
  const briefing = await getTool('member_briefing').execute({
    claudeDir,
    teamName,
    memberName: 'alice',
  });

  const text = (briefing as { content: Array<{ text: string }> }).content[0]?.text ?? '';
  expect(text).toContain('SendMessage');
  expect(text).not.toContain('runtimeProvider: "opencode"');
});
```

```ts
it('infers OpenCode-safe member briefing from provider metadata when runtimeProvider is omitted', async () => {
  // Configure bob with providerId: 'opencode'.
  const briefing = await getTool('member_briefing').execute({
    claudeDir,
    teamName,
    memberName: 'bob',
  });

  const text = (briefing as { content: Array<{ text: string }> }).content[0]?.text ?? '';
  expect(text).toContain('agent-teams_message_send');
  expect(text).not.toMatch(/via SendMessage|SendMessage summary field/);
});
```

```ts
it('persists taskRefs through message_send', async () => {
  await getTool('message_send').execute({
    claudeDir,
    teamName,
    to: 'user',
    from: 'bob',
    text: 'Done',
    summary: '#abcd1234 done',
    taskRefs: [{ teamName, taskId: 'task-1', displayId: 'abcd1234' }],
  });

  const rows = JSON.parse(
    fs.readFileSync(path.join(claudeDir, 'teams', teamName, 'inboxes', 'user.json'), 'utf8')
  );
  expect(rows[0].taskRefs).toEqual([{ teamName, taskId: 'task-1', displayId: 'abcd1234' }]);
});
```

```ts
it('rejects user-directed message_send without a teammate sender', async () => {
  await expect(
    getTool('message_send').execute({
      claudeDir,
      teamName,
      to: 'user',
      text: 'Done',
    })
  ).rejects.toThrow(/to user requires from/i);
});
```

```ts
it('keeps legacy user-to-member message_send valid without from', async () => {
  await getTool('message_send').execute({
    claudeDir,
    teamName,
    to: 'alice',
    text: 'Please check this',
  });

  const rows = JSON.parse(
    fs.readFileSync(path.join(claudeDir, 'teams', teamName, 'inboxes', 'alice.json'), 'utf8')
  );
  expect(rows.at(-1)).toMatchObject({
    from: 'user',
    to: 'alice',
    text: 'Please check this',
  });
});
```

```ts
it('rejects user-directed message_send when from is not a configured team member', async () => {
  await expect(
    getTool('message_send').execute({
      claudeDir,
      teamName,
      to: 'user',
      from: 'unknown-agent',
      text: 'Done',
    })
  ).rejects.toThrow(/unknown from|configured team member/i);
});
```

```ts
it('canonicalizes message_send lead aliases before writing inbox files', async () => {
  // Configure lead member with name "lead", not "team-lead".
  await getTool('message_send').execute({
    claudeDir,
    teamName,
    to: 'team-lead',
    from: 'bob',
    text: 'Need help',
  });

  expect(fs.existsSync(path.join(claudeDir, 'teams', teamName, 'inboxes', 'lead.json'))).toBe(true);
  expect(fs.existsSync(path.join(claudeDir, 'teams', teamName, 'inboxes', 'team-lead.json'))).toBe(
    false
  );
});
```

```ts
it('canonicalizes message_send sender aliases before persistence', async () => {
  // Configure lead member with name "lead", not "team-lead".
  await getTool('message_send').execute({
    claudeDir,
    teamName,
    to: 'alice',
    from: 'team-lead',
    text: 'Please review',
  });

  const rows = JSON.parse(
    fs.readFileSync(path.join(claudeDir, 'teams', teamName, 'inboxes', 'alice.json'), 'utf8')
  );
  expect(rows.at(-1)).toMatchObject({ from: 'lead', to: 'alice' });
});
```

```ts
it('rejects message_send to unknown local recipients instead of creating arbitrary inboxes', async () => {
  await expect(
    getTool('message_send').execute({
      claudeDir,
      teamName,
      to: 'unknown-agent',
      from: 'bob',
      text: 'Hello',
    })
  ).rejects.toThrow(/unknown to|configured team member/i);
});
```

```ts
it('rejects message_send to cross_team_send pseudo recipient with a clear tool hint', async () => {
  await expect(
    getTool('message_send').execute({
      claudeDir,
      teamName,
      to: 'cross_team_send',
      from: 'bob',
      text: 'Hello',
    })
  ).rejects.toThrow(/use cross_team_send/i);
});
```

```ts
it('rejects message_send to qualified external recipients after local roster lookup fails', async () => {
  await expect(
    getTool('message_send').execute({
      claudeDir,
      teamName,
      to: 'other-team.team-lead',
      from: 'bob',
      text: 'Hello',
    })
  ).rejects.toThrow(/use cross_team_send/i);
});
```

```ts
it('keeps configured dotted local members valid before applying cross-team heuristics', async () => {
  // Configure a local member named "qa.bot".
  await getTool('message_send').execute({
    claudeDir,
    teamName,
    to: 'qa.bot',
    from: 'bob',
    text: 'Local dotted member',
  });

  expect(fs.existsSync(path.join(claudeDir, 'teams', teamName, 'inboxes', 'qa.bot.json'))).toBe(
    true
  );
});
```

```ts
it('describes message_send as the normal visible reply tool for OpenCode', () => {
  const tool = getRegisteredTool('message_send');
  expect(tool.description).toMatch(/visible.*message|normal replies/i);
  expect(tool.description).toMatch(/to is "user".*from is required/i);
});
```

```ts
it('describes runtime_deliver_message as low-level and not the normal reply path', () => {
  const tool = getRegisteredTool('runtime_deliver_message');
  expect(tool.description).toMatch(/low-level|runtime delivery journal/i);
  expect(tool.description).toMatch(/normal visible replies.*message_send/i);
});
```

Add cross-team `taskRefs` tests only if Step 6.4 chooses Option B:

```ts
it('persists taskRefs through cross_team_send when enabled', async () => {
  await getTool('cross_team_send').execute({
    claudeDir,
    teamName,
    toTeam: 'review-team',
    fromMember: 'bob',
    text: 'Please review task #abcd1234',
    summary: '#abcd1234 review request',
    taskRefs: [{ teamName, taskId: 'task-1', displayId: 'abcd1234' }],
  });

  const targetInbox = JSON.parse(
    fs.readFileSync(
      path.join(claudeDir, 'teams', 'review-team', 'inboxes', 'team-lead.json'),
      'utf8'
    )
  );
  expect(targetInbox.at(-1).taskRefs).toEqual([
    { teamName, taskId: 'task-1', displayId: 'abcd1234' },
  ]);

  const outbox = JSON.parse(
    fs.readFileSync(path.join(claudeDir, 'teams', teamName, 'sent-cross-team.json'), 'utf8')
  );
  expect(outbox.at(-1).taskRefs).toEqual([{ teamName, taskId: 'task-1', displayId: 'abcd1234' }]);
});
```

Add controller-level tests:

```js
it('preserves provider metadata when resolving team members', () => {
  // Create team config with bob providerId opencode.
  // Resolve members through controller/runtime helper path.
  // Assert bob.providerId === 'opencode'.
});
```

```js
it('uses OpenCode messaging protocol in assignment notifications for OpenCode owners', () => {
  // Create bob as providerId opencode.
  // Create task with owner bob and notifyOwner true.
  // Read bob inbox.
  // Assert inbox text contains agent-teams_message_send.
  // Assert inbox text does not match /via SendMessage|SendMessage summary field/.
});
```

```js
it('keeps cross-team replies on cross_team_send for OpenCode briefings', async () => {
  const briefing = await controller.tasks.memberBriefing('bob', {
    runtimeProvider: 'opencode',
  });

  expect(briefing).toContain('agent-teams_cross_team_send');
  expect(briefing).toContain('toTeam');
  expect(briefing).not.toMatch(/message_send[^\\n]+cross_team_send/);
});
```

```js
it('keeps native assignment notifications using SendMessage', () => {
  // Create alice without providerId.
  // Create task with owner alice.
  // Assert inbox text still contains SendMessage.
});
```

Add alias tests for app capture/log support:

```ts
it.each([
  'message_send',
  'agent-teams_message_send',
  'agent_teams_message_send',
  'mcp__agent-teams__message_send',
  'mcp__agent_teams__message_send',
])('canonicalizes %s to message_send', (toolName) => {
  expect(canonicalizeAgentTeamsToolName(toolName)).toBe('message_send');
});
```

```ts
it.each([
  '"name":"agent-teams_task_start"',
  '"name":"agent_teams_task_start"',
  '"name":"mcp__agent-teams__task_start"',
  '"name":"proxy_agent-teams_task_complete"',
])('detects task boundary aliases in raw log line %s', (line) => {
  expect(lineHasAgentTeamsTaskBoundaryToolName(line)).toBe(true);
});
```

```ts
it('does not double-persist MCP message_send as a lead-process message', () => {
  // Feed captureSendMessages a message_send tool_use to a normal local teammate.
  // Assert MCP persistence path is not duplicated by pushLiveLeadProcessMessage/persistSentMessage.
  // Cross-team pseudo-recipient fallback remains covered separately.
});
```

```ts
it('does not classify unrelated plain message_send tool_use without Agent Teams payload shape', () => {
  expect(
    isAgentTeamsToolUse({
      rawName: 'message_send',
      canonicalName: 'message_send',
      toolInput: { channel: 'general', body: 'hello' },
      currentTeamName: 'atlas-hq',
    })
  ).toBe(false);
});
```

Add app-side OpenCode readiness tests:

```ts
it('uses full app tool ids for OpenCode readiness expectations', async () => {
  const result = await bridge.runReadiness({
    selectedModel: 'minimax-m2.5-free',
    // ...
  });

  expect(result.supportLevel).toBe('production_supported');
  expect(result.evidence.observedMcpTools).toEqual(
    expect.arrayContaining(REQUIRED_AGENT_TEAMS_APP_TOOL_IDS)
  );
});
```

```ts
it('keeps runtime schema validation scoped to runtime proof tools', () => {
  expect(APP_MCP_RUNTIME_TOOL_CONTRACTS.map((contract) => contract.name)).toEqual(
    REQUIRED_AGENT_TEAMS_RUNTIME_PROOF_TOOLS
  );
  expect(REQUIRED_AGENT_TEAMS_APP_TOOLS).toContain('message_send');
  expect(APP_MCP_RUNTIME_TOOL_CONTRACTS.map((contract) => contract.name)).not.toContain(
    'message_send'
  );
});
```

Add OpenCode direct-message delivery tests:

```ts
it('delivers OpenCode runtime message with explicit reply recipient instead of parsing native SendMessage text', async () => {
  const bridge = createBridgeSpy();
  const adapter = new OpenCodeTeamRuntimeAdapter(bridge);

  await adapter.sendMessageToMember({
    runId: 'run-1',
    teamName,
    laneId: 'secondary:bob',
    memberName: 'bob',
    cwd,
    text: 'Can you check this?',
    messageId: 'msg-1',
    replyRecipient: 'user',
  });

  const sentText = bridge.sentMessages[0].text;
  expect(sentText).toContain('to="user"');
  expect(sentText).toContain('agent-teams_message_send');
  expect(sentText).not.toContain('CRITICAL: Reply using the SendMessage tool');
});
```

```ts
it('passes taskRefs and actionMode into OpenCode runtime message prompt', async () => {
  const bridge = createBridgeSpy();
  const adapter = new OpenCodeTeamRuntimeAdapter(bridge);

  await adapter.sendMessageToMember({
    runId: 'run-1',
    teamName,
    laneId: 'secondary:bob',
    memberName: 'bob',
    cwd,
    text: 'Please respond on task #abcd1234',
    replyRecipient: 'alice',
    actionMode: 'do',
    taskRefs: [{ teamName, taskId: 'task-1', displayId: 'abcd1234' }],
  });

  const sentText = bridge.sentMessages[0].text;
  expect(sentText).toContain('to="alice"');
  expect(sentText).toContain('Action mode for this message: do');
  expect(sentText).toContain('"displayId":"abcd1234"');
});
```

```ts
it('keeps native persisted inbox text unchanged but stores base text for OpenCode recipients', async () => {
  // Exercise the IPC send-message path.
  // For a native recipient, assert sendMessage() persisted memberDeliveryText containing native SendMessage guidance.
  // For an OpenCode recipient, assert the persisted inbox row text is baseText and does not contain SendMessage guidance.
  // Assert relayOpenCodeMemberInboxMessages() received explicit replyRecipient/actionMode/taskRefs metadata.
});
```

```ts
it('returns runtimeDelivery success for live OpenCode direct messages', async () => {
  // Exercise handleSendMessage() for a live non-lead OpenCode recipient.
  // Mock relayOpenCodeMemberInboxMessages() to return { attempted: 1, delivered: 1, failed: 0 }.
  // Assert result.runtimeDelivery is { providerId: "opencode", attempted: true, delivered: true }.
  // Assert inbox persistence still happened with base text for OpenCode.
});
```

```ts
it('returns runtimeDelivery failure without hiding the persisted message', async () => {
  // Exercise handleSendMessage() for a live non-lead OpenCode recipient.
  // Mock relayOpenCodeMemberInboxMessages() to return { attempted: 1, delivered: 0, failed: 1, diagnostics: ["opencode_runtime_not_active"] }.
  // Assert result.deliveredToInbox is true.
  // Assert result.runtimeDelivery.delivered is false and reason is preserved.
});
```

```ts
it('does not auto-close the send dialog when OpenCode runtime delivery fails', async () => {
  // Mount SendMessageDialog with lastResult.runtimeDelivery.delivered === false.
  // Assert the dialog stays open and shows an actionable warning.
});
```

```ts
it('sendTeamMessage rejects after setting sendMessageError when IPC send fails', async () => {
  // Mock api.teams.sendMessage to reject.
  // Await expect(store.getState().sendTeamMessage(...)).rejects.toThrow().
  // Assert sendMessageError is set and lastSendMessageResult is null.
});
```

```ts
it('clears pending reply when OpenCode runtime delivery fails after inbox persistence', async () => {
  // Mock sendTeamMessage to resolve with runtimeDelivery.delivered === false.
  // Send from MessagesPanel or TeamDetailView.
  // Assert the member pending-reply spinner is removed and the user-sent row remains.
});
```

```ts
it('shows OpenCode message_send replies from inboxes/user.json without frontend fake state', async () => {
  // Seed the message feed with a durable inboxes/user.json row:
  // { from: "bob", to: "user", source: "opencode_message_send", text: "done" }.
  // Assert TeamMessageFeedService includes it.
  // Assert MessagesPanel renders it as bob -> user.
  // Assert reconcilePendingRepliesByMember clears bob after this reply timestamp.
});
```

```ts
it('relays unread OpenCode-targeted inbox messages to the live OpenCode runtime lane', async () => {
  // Configure jack with providerId: "opencode" and an active lane.
  // Seed inboxes/jack.json with unread { from: "bob", to: "jack", messageId: "msg-1" }.
  // Call relayOpenCodeMemberInboxMessages(teamName, "jack").
  // Assert deliverOpenCodeMemberMessage() was called with memberName "jack", text, messageId, and replyRecipient "bob".
  // Assert the inbox row is marked read or its messageId is recorded as delivered.
});
```

```ts
it('does not runtime-relay native teammate inbox messages', async () => {
  // Configure alice as Codex/native.
  // Seed inboxes/alice.json with unread message.
  // Call relayOpenCodeMemberInboxMessages(teamName, "alice").
  // Assert attempted/delivered are 0 and deliverOpenCodeMemberMessage() is not called.
});
```

```ts
it('uses the same OpenCode recipient predicate for persisted text and runtime relay', async () => {
  // Configure jack as OpenCode in members.meta and native-looking model fallback in config.
  // Assert handleSendMessage() persists base text for jack.
  // Assert relayOpenCodeMemberInboxMessages() attempts runtime delivery for jack.
});
```

```ts
it('does not double-deliver UI direct messages after FileWatcher inbox change', async () => {
  // Send UI message to OpenCode jack through handleSendMessage().
  // Simulate FileWatcher inbox event for inboxes/jack.json.
  // Assert the same messageId is delivered at most once to OpenCode runtime.
});
```

```ts
it('keeps failed transient OpenCode inbox relay retryable', async () => {
  // Mock deliverOpenCodeMemberMessage() to fail with opencode_runtime_not_active.
  // Assert the row remains unread and the diagnostic is returned.
});
```

```ts
it('does not mark OpenCode inbox rows read before bridge acceptance', async () => {
  // Mock deliverOpenCodeMemberMessage() to fail before prompt acceptance.
  // Assert markInboxMessagesRead() is not called and the row remains unread.
});
```

```ts
it('reports prompt-accepted mark-read failure as non-exactly-once diagnostic', async () => {
  // Mock deliverOpenCodeMemberMessage() to accept the prompt.
  // Mock markInboxMessagesRead() to throw.
  // Assert diagnostics include opencode_inbox_mark_read_failed_after_delivery.
  // Assert the result does not claim a clean exactly-once success.
});
```

```ts
it('routes native lead inbox relay through the legacy stdin path', async () => {
  // Configure a mixed team with Codex/Claude lead and OpenCode secondary teammates.
  // Seed inboxes/<lead>.json with one unread message.
  // Call relayInboxFileToLiveRecipient(teamName, leadName).
  // Assert relayLeadInboxMessages() is called and OpenCode runtime delivery is not attempted.
});
```

```ts
it('does not silently consume pure OpenCode lead inbox when no lead session exists', async () => {
  // Configure a pure OpenCode runtime-adapter team where isTeamAlive() is true via runtimeAdapterRunByTeam.
  // Ensure there is no stored OpenCode session record for the canonical lead name.
  // Seed inboxes/<lead>.json with one unread message.
  // Call relayInboxFileToLiveRecipient(teamName, leadName).
  // Assert diagnostics include opencode_lead_runtime_session_missing.
  // Assert the inbox row remains unread and no teammate session received the prompt.
});
```

```ts
it('keeps OpenCode member relay independent from unsupported OpenCode lead relay', async () => {
  // Configure a pure OpenCode team with a stored teammate session for bob but no team-lead session.
  // Seed inboxes/bob.json and inboxes/<lead>.json.
  // Assert bob is relayed and marked read.
  // Assert lead remains unread with an unsupported-lead diagnostic.
});
```

### Orchestrator tests

File:

```text
/Users/belief/dev/projects/claude/agent_teams_orchestrator/src/services/opencode/OpenCodeBridgeCommandHandler.test.ts
```

Update helper `mockRequiredMcpTools()` to include app tools:

```ts
tools: [
  { name: 'runtime_bootstrap_checkin' },
  { name: 'runtime_deliver_message' },
  { name: 'runtime_task_event' },
  { name: 'runtime_heartbeat' },
  { name: 'member_briefing' },
  { name: 'task_add_comment' },
  { name: 'task_attach_comment_file' },
  { name: 'task_attach_file' },
  { name: 'task_briefing' },
  { name: 'task_complete' },
  { name: 'task_create' },
  { name: 'task_create_from_message' },
  { name: 'task_get' },
  { name: 'task_get_comment' },
  { name: 'task_link' },
  { name: 'task_list' },
  { name: 'task_set_clarification' },
  { name: 'task_set_owner' },
  { name: 'task_set_status' },
  { name: 'task_start' },
  { name: 'task_unlink' },
  { name: 'review_approve' },
  { name: 'review_request' },
  { name: 'review_request_changes' },
  { name: 'review_start' },
  { name: 'message_send' },
  { name: 'process_list' },
  { name: 'process_register' },
  { name: 'process_stop' },
  { name: 'process_unregister' },
  { name: 'cross_team_send' },
  { name: 'cross_team_list_targets' },
  { name: 'cross_team_get_outbox' },
],
```

Add missing tool failure test:

```ts
test('readiness fails when app MCP message_send is missing', async () => {
  // Arrange listTools without message_send.
  // Assert result.ok === false or launchAllowed === false.
  // Assert diagnostics mention message_send.
});
```

Add direct-name proof test:

```ts
test('direct MCP proof compares plain tool names, not OpenCode ids', async () => {
  // Arrange listTools returning plain names: message_send, member_briefing, ...
  // Assert readiness succeeds.
  // Assert internal matching did not require listTools to return agent-teams_message_send.
  // Assert public readiness evidence still contains canonical agent-teams_message_send.
  // Assert public readiness evidence does not expose plain message_send as the production artifact id.
});
```

Add a bridge-output shape test:

```ts
test('readiness evidence emits canonical OpenCode ids after plain direct MCP proof', async () => {
  // Arrange direct listTools with plain message_send/member_briefing/task_start/cross_team_send.
  const result = await runReadiness();

  expect(result.data.requiredToolsPresent).toBe(true);
  expect(result.data.evidence.observedMcpTools).toContain('agent-teams_message_send');
  expect(result.data.evidence.observedMcpTools).toContain('agent-teams_member_briefing');
  expect(result.data.evidence.observedMcpTools).not.toContain('message_send');
});
```

Add launch prompt identity test:

```ts
test('launch prepends OpenCode runtime identity and opencode briefing mode', async () => {
  const prompts: string[] = [];
  openCodeSessionBridge.promptAsync = async (_record, input) => {
    prompts.push(input.text);
  };

  // Execute opencode.launchTeam.

  expect(prompts[0]).toContain('agent-teams_runtime_bootstrap_checkin');
  expect(prompts[0]).toContain('mcp__agent-teams__runtime_bootstrap_checkin');
  expect(prompts[0]).toContain('runtimeSessionId');
  expect(prompts[0]).toContain('agent-teams_member_briefing');
  expect(prompts[0]).toContain('mcp__agent-teams__member_briefing');
  expect(prompts[0]).toContain('"runtimeProvider":"opencode"');
  expect(prompts[0]).not.toMatch(/runtime_bootstrap_checkin[^<]+laneId/);
});
```

Add launch settle test:

```ts
test('launch waits briefly for OpenCode preview before final reconcile', async () => {
  openCodeSessionBridge.promptAsync = async () => undefined;
  openCodeSessionBridge.observePreview = async () => ({
    record,
    summary: {
      previewOutcome: 'observed',
      latestAssistantMessageId: 'msg-tool-only',
      latestAssistantPreview: 'calling agent-teams_runtime_bootstrap_checkin',
      runtimeState: 'running',
      diagnostics: [],
    },
  });
  openCodeSessionBridge.reconcileSession = async () => confirmedAliveReconcile();

  // Execute opencode.launchTeam.

  expect(openCodeSessionBridge.observePreview).toHaveBeenCalled();
  expect(result.data.members.bob?.launchState).toBe('confirmed_alive');
});
```

```ts
test('launch settle runs concurrently for multiple OpenCode members', async () => {
  const observeStarted: string[] = [];
  const observeRelease = createDeferred<void>();
  openCodeSessionBridge.observePreview = async (record) => {
    observeStarted.push(record.memberName);
    await observeRelease.promise;
    return previewObserved(record);
  };

  const launchPromise = runOpenCodeLaunchTeamWithMembers(['bob', 'jack', 'tom']);
  await waitUntil(() => observeStarted.length === 3);
  observeRelease.resolve();
  const result = await launchPromise;

  expect(observeStarted.sort()).toEqual(['bob', 'jack', 'tom']);
  expect(result.data.teamLaunchState).not.toBe('failed');
});
```

```ts
test('launch settle caps concurrent preview observers', async () => {
  let activeObservers = 0;
  let maxActiveObservers = 0;
  openCodeSessionBridge.observePreview = async (record) => {
    activeObservers += 1;
    maxActiveObservers = Math.max(maxActiveObservers, activeObservers);
    await delay(25);
    activeObservers -= 1;
    return previewObserved(record);
  };

  await runOpenCodeLaunchTeamWithMembers(['a', 'b', 'c', 'd', 'e']);

  expect(maxActiveObservers).toBeLessThanOrEqual(3);
});
```

```ts
test('launch preview timeout does not become a hard member failure', async () => {
  openCodeSessionBridge.observePreview = async () => {
    throw new Error('preview timeout');
  };
  openCodeSessionBridge.reconcileSession = async () => createdReconcile();

  // Execute opencode.launchTeam.

  expect(result.data.members.bob?.launchState).toBe('created');
  expect(result.data.members.bob?.diagnostics.join('\n')).not.toContain('preview timeout');
});
```

Add send-message recovery test:

```ts
test('sendMessage prepends OpenCode identity reminder only when runId is present', async () => {
  const prompts: string[] = [];
  openCodeSessionBridge.promptAsync = async (_record, input) => {
    prompts.push(input.text);
  };

  // Execute opencode.sendMessage once with runId and once without runId.

  expect(prompts[0]).toContain('agent-teams_runtime_bootstrap_checkin');
  expect(prompts[0]).toContain('runtimeSessionId');
  expect(prompts[1]).not.toContain('agent-teams_runtime_bootstrap_checkin');
});
```

```ts
test('sendMessage treats post-accept reconcile failure as warning, not delivery failure', async () => {
  openCodeSessionBridge.promptAsync = async () => undefined;
  openCodeSessionBridge.reconcileSession = async () => {
    throw new Error('reconcile timeout');
  };

  const result = await runOpenCodeSendMessage({ runId: 'run-1', memberName: 'bob' });

  expect(result.data.accepted).toBe(true);
  expect(result.data.diagnostics.map((d) => d.code)).toContain(
    'opencode_send_reconcile_failed_after_prompt_accept'
  );
});
```

```ts
test('sendMessage reports delivery failure only when prompt enqueue fails', async () => {
  openCodeSessionBridge.promptAsync = async () => {
    throw new Error('prompt rejected');
  };

  await expect(runOpenCodeSendMessage({ runId: 'run-1', memberName: 'bob' })).rejects.toThrow(
    'prompt rejected'
  );
});
```

Add app restart durable-run tests:

```ts
test('runtime evidence acceptance falls back to lane-scoped manifest activeRunId', async () => {
  // Arrange no in-memory runtimeAdapterRunByTeam/secondaryRuntimeRunByTeam entry.
  // Arrange lanes.json lane active.
  // Arrange lane-scoped manifest.json activeRunId.
  // Call runtime_bootstrap_checkin or runtime_heartbeat with the same runId.
  // Assert evidence is accepted, not rejected with current_run_missing.
});
```

```ts
test('OpenCode message delivery uses lane-scoped manifest activeRunId after restart', async () => {
  // Arrange recipient is an OpenCode secondary lane.
  // Arrange no tracked provisioning run.
  // Arrange lanes.json lane active and lane-scoped manifest activeRunId.
  // Spy adapter.sendMessageToMember.
  // Call deliverOpenCodeMemberMessage.
  // Assert sendMessageToMember receives runId from the lane-scoped manifest.
});
```

```ts
test('runtime delivery service current-run resolver uses lane-scoped manifest after restart', async () => {
  // Arrange RuntimeDeliveryService with no in-memory run.
  // Arrange lanes.json lane active and lane-scoped manifest activeRunId.
  // Call runtime_deliver_message through the service path.
  // Assert current-run validation receives the manifest run id.
});
```

Add runtime delivery event-shape tests:

```ts
it('maps runtime delivery local data.detail to app TeamChangeEvent.detail', async () => {
  const emitted: TeamChangeEvent[] = [];
  const service = createProvisioningService({
    teamChangeEmitter: (event) => emitted.push(event),
  });

  await deliverOpenCodeRuntimeMessageToUser(service, {
    teamName,
    fromMemberName: 'bob',
    text: 'done',
  });

  expect(emitted).toContainEqual(
    expect.objectContaining({
      type: 'lead-message',
      teamName,
      detail: 'opencode-runtime-delivery',
    })
  );
  expect(emitted[0]).not.toHaveProperty('data.detail');
});
```

```ts
it('emits top-level inbox detail for runtime delivery to member inboxes', async () => {
  const emitted: TeamChangeEvent[] = [];
  const service = createProvisioningService({
    teamChangeEmitter: (event) => emitted.push(event),
  });

  await deliverOpenCodeRuntimeMessageToMember(service, {
    teamName,
    fromMemberName: 'bob',
    toMemberName: 'alice',
    text: 'please review',
  });

  expect(emitted).toContainEqual(
    expect.objectContaining({
      type: 'inbox',
      teamName,
      detail: 'inboxes/alice.json',
    })
  );
});
```

Add renderer/store smoke test if an existing test harness already covers store event subscriptions:

```ts
it('refreshes tracked team messages on OpenCode runtime delivery team-change events by type', async () => {
  // Arrange selected/tracked team.
  // Emit { type: 'inbox', teamName, detail: 'inboxes/user.json' }.
  // Assert refreshTeamMessagesHead(teamName) is scheduled/called.
});
```

### Event translator test

File:

```text
/Users/belief/dev/projects/claude/agent_teams_orchestrator/src/services/opencode/OpenCodeEventTranslator.test.ts
```

Add a test that a tool-only assistant message still produces `latestAssistantMessageId`.

Reason:

Launch state currently maps to `confirmed_alive` when `summary.latestAssistantMessageId` exists. If OpenCode replies only with tool calls, we still need that to count as alive.

Current code already appears to support this because `OpenCodeTranscriptProjector.projectMessage()` creates an assistant canonical message even when it only has `tool` parts. The test is still important because `bridgeStateFromSummary()` depends on this behavior.

Add assertions to the existing tool lifecycle test:

```ts
expect(summary.latestAssistantMessageId).toBe('msg-assistant-tool');
expect(summary.latestAssistantText).toBeNull();
expect(summary.latestAssistantPreview).toBeNull();
```

### Commands

Run targeted tests first:

```bash
cd /Users/belief/dev/projects/claude/claude_team
pnpm --filter agent-teams-controller test -- test/controller.test.js
pnpm --filter agent-teams-mcp test -- test/tools.test.ts
pnpm vitest run test/main/services/team/OpenCodeTeamRuntimeAdapter.test.ts test/main/services/team/TeamProvisioningService.test.ts test/main/services/team/TeamProvisioningServiceRelay.test.ts test/main/services/team/TeamProvisioningServiceLiveMessages.test.ts test/main/ipc/teams.test.ts test/main/services/team/OpenCodeMcpToolAvailability.test.ts test/main/services/team/OpenCodeReadinessBridge.test.ts test/renderer/store/teamChangeThrottle.test.ts test/renderer/store/teamSlice.test.ts test/renderer/components/team/messages/MessagesPanel.test.ts test/renderer/components/team/dialogs/SendMessageDialog.test.tsx
```

```bash
cd /Users/belief/dev/projects/claude/agent_teams_orchestrator
bun test src/services/opencode/OpenCodeBridgeCommandHandler.test.ts src/services/teamBootstrap/teamBootstrapSpec.test.ts src/hooks/useInboxPoller.test.ts
```

Then broader checks:

```bash
cd /Users/belief/dev/projects/claude/claude_team
pnpm typecheck:workspace
pnpm --filter agent-teams-mcp test:e2e
```

```bash
cd /Users/belief/dev/projects/claude/agent_teams_orchestrator
bun run build
```

Avoid heavy E2E until targeted tests pass.

## Manual Verification

1. Launch a mixed team with one Codex lead, one Codex teammate, and two OpenCode teammates.
2. Confirm OpenCode launch prompt includes runtime identity in logs.
3. Confirm OpenCode teammates call `runtime_bootstrap_checkin`.
4. Confirm OpenCode teammates call `member_briefing` with `runtimeProvider: "opencode"`.
5. Send a message to an OpenCode teammate from the UI.
6. Confirm reply appears in Messages UI from that member with `to: "user"`.
7. Confirm the send result has no OpenCode runtime delivery warning when the bridge accepts the prompt.
8. Temporarily force an OpenCode runtime delivery failure in a dev build and confirm the message remains persisted but the dialog/composer shows `Message saved, but OpenCode runtime delivery failed`.
9. Ask one OpenCode teammate to message another OpenCode teammate and confirm the target receives a live runtime prompt, not only an inbox file row.
10. In a pure OpenCode test team without a stored lead session, send to the lead and confirm the inbox row remains unread with an explicit unsupported-lead diagnostic, not a fake success.
11. Assign a task to an OpenCode teammate.
12. Confirm owner notification says `agent-teams_message_send`, not `SendMessage`.
13. Complete a task from OpenCode and confirm task comment exists before visible summary message.

## Rollout Order

1. Add controller messaging protocol helper.
2. Preserve provider metadata in controller.
3. Add `runtimeProvider` to `member_briefing`.
4. Update `mcp-server/src/agent-teams-controller.d.ts` and `src/types/agent-teams-controller.d.ts`.
5. Update member briefing and task assignment wording.
6. Extend `message_send` with `taskRefs`.
7. Add the narrow `message_send(to: "user")` sender identity guard.
8. Canonicalize `message_send` local recipients/senders before persistence.
9. Disambiguate `message_send` and `runtime_deliver_message` descriptions/prompts.
10. Choose and implement/forbid cross-team `taskRefs` before helper examples can emit them.
11. Centralize Agent Teams tool-name alias matching.
12. Consolidate duplicate `OpenCodeSendMessageCommandBody` declarations.
13. Add orchestrator runtime identity prompt injection without unsupported `laneId` in tool payloads.
14. Add bounded concurrent OpenCode launch settle/preview before final launch-state mapping.
15. Add native-only prompt boundary guard tests so OpenCode does not receive generic `SendMessage` spawn prompts.
16. Make OpenCode direct-message runtime delivery explicit instead of parsing native `SendMessage` prompt text.
17. Make OpenCode direct-message runtime delivery outcome observable in `SendMessageResult` and UI.
18. Add the inbox relay selector that separates native lead, OpenCode runtime recipient, native teammate no-op, and unsupported OpenCode lead diagnostics.
19. Add OpenCode-targeted inbox runtime relay with dedupe/read marking.
20. Expand orchestrator direct MCP proof with the explicit plain-name adapter list while keeping public observed evidence as canonical OpenCode ids.
21. Expand app-side OpenCode MCP availability proof from controller catalog.
22. Keep OpenCode readiness requiring the full app tool id list without project-scoped artifacts.
23. Add lane-scoped manifest `activeRunId` recovery and consume it in evidence acceptance/message delivery/runtime delivery service.
24. Add runtime delivery `TeamChangeEvent.detail` adapter guard tests.
25. Add tests.
26. Run targeted tests.
27. Run broader checks.
28. Manually verify one real mixed OpenCode launch.

## Failure Modes To Watch

- OpenCode launch prompt contains both "first call member_briefing" and "first call runtime_bootstrap_checkin". Fix by making adapter prompt defer to orchestrator identity block.
- OpenCode identity block shows unsupported `laneId` inside `runtime_bootstrap_checkin`. Fix the example/helper, because the runtime tool schema does not accept it.
- OpenCode member prompt contains native-only "Use SendMessage" guidance. This means routing leaked through a native prompt builder; fix routing, not by global-replacing all native `SendMessage` text.
- OpenCode direct-message prompt contains native-only "CRITICAL: Reply using the SendMessage tool" guidance. This means runtime delivery is reusing `memberDeliveryText`; pass explicit metadata and build OpenCode-native delivery text.
- OpenCode uses `runtime_deliver_message` for an ordinary reply after a UI message. This means the tool descriptions/prompts are still ambiguous or the runtime-delivery path is being over-promoted in the normal reply contract.
- `message_send` creates `inboxes/team-lead.json` while the configured lead is named differently. This means local recipient canonicalization is missing or not using lead aliases.
- `message_send` creates `inboxes/unknown-agent.json` for an unconfigured local recipient. This should be a tool error, not a new durable inbox.
- UI send to an OpenCode teammate closes as success while OpenCode inbox runtime relay fails only in logs. This means delivery is still fire-and-forget or the `runtimeDelivery` result is ignored by the renderer.
- `inboxes/<opencode-member>.json` contains native hidden `SendMessage` instructions. This makes retry unsafe because FileWatcher relay can later deliver a native prompt to OpenCode.
- `SendMessageDialog` auto-closes when `lastResult.runtimeDelivery.delivered === false`. This hides a real OpenCode delivery failure after inbox persistence and should be treated as a UI contract bug.
- OpenCode-to-OpenCode `message_send` creates `inboxes/<target>.json` but the target never reacts. This means OpenCode-targeted inbox relay is missing or recipient provider detection failed.
- OpenCode-targeted inbox relay uses existing `relayMemberInboxMessages()`. That is wrong for this seam because it routes through native lead stdin and native `SendMessage` wording instead of direct OpenCode runtime prompt delivery.
- Pure OpenCode `message_send` to the lead creates `inboxes/<lead>.json` and then disappears as read. This is data loss: without a stored OpenCode lead session, the row must stay unread with an explicit unsupported-lead diagnostic.
- FileWatcher still calls `relayLeadInboxMessages()` directly for every lead inbox. This keeps pure OpenCode lead delivery as a silent no-op because that method requires `run.child`; route through the service selector instead.
- OpenCode relay marks an inbox row read before the bridge accepts the prompt. This can lose messages; read marking is the durable commit and must happen after accepted runtime delivery.
- OpenCode send reports delivery failure after `promptAsync()` succeeded only because post-send reconcile timed out. That creates duplicate retries. Reconcile after prompt acceptance is evidence freshness, not delivery acceptance.
- UI direct-send to OpenCode arrives twice. This means direct runtime delivery and FileWatcher inbox relay are not sharing messageId dedupe/read state.
- Pending-reply spinner stays forever after a send IPC error. This means `sendTeamMessage` is still swallowing failures instead of rethrowing after updating store state.
- Pending-reply spinner stays after `runtimeDelivery.delivered === false`. This means caller code did not consume the returned `SendMessageResult` or did not treat OpenCode runtime failure as "agent did not receive prompt".
- `member_briefing` default accidentally switches native teammates to `message_send`. Tests must prevent this.
- Cross-team prompt/helper emits `taskRefs` while `cross_team_send` schema rejects them. Either remove taskRefs from cross-team examples or wire schema/storage end-to-end.
- OpenCode owner detection fails because provider metadata is still missing from resolved members.
- Readiness passes while `message_send` is missing. This means proof list is still incomplete.
- Readiness passes while review/process/task-set tools are missing. This means proof only checked a small subset instead of all teammate-operational briefing tools.
- Direct MCP readiness fails even though `tools/list` contains `message_send`. This usually means direct stdio proof is incorrectly comparing plain names against OpenCode canonical ids.
- Readiness passes with runtime-only app tool coverage. This means `OpenCodeMcpToolAvailability` still uses only runtime tools instead of the full app tool id list.
- App-side and orchestrator required tool lists drift. For v1, this is controlled by tests and explicit comments. If drift keeps recurring, move to a generated shared contract artifact.
- OpenCode member stays `created` even though the prompt was accepted. This usually means `promptAsync()` was reconciled too early; use the bounded launch-settle helper before final launch mapping.
- Preview observation times out and marks a teammate failed. That is wrong. Preview timeout should only fall back to reconcile and keep the member pending.
- Launch settle opens too many preview observers at once. Cap concurrency locally; do not scale observer count linearly with team size.
- Prompt tells OpenCode to use one alias, but log/capture code only recognizes another alias. Fix by using shared canonicalization helpers.
- Alias capture starts duplicating `message_send` in live messages. Keep the non-native no-double-persist guard in `captureSendMessages()`.
- OpenCode uses `message_send` for cross-team replies. That is wrong; cross-team replies must use `cross_team_send` with `toTeam`.
- OpenCode replies with `message_send({ to: "user", text: "..." })` and no `from`. This must fail clearly instead of writing `from: "user"`.
- `message_send` writes to `inboxes/user.json`, but UI does not show it. That would be a separate feed regression, not a protocol issue.
- Secondary lane check-in rejects due to missing current run id after app restart. Check `lanes.json` only for active/degraded state, then read lane-scoped `manifest.json.activeRunId`.
- Secondary lane check-in still rejects after lane-scoped manifest has `activeRunId`. This means evidence acceptance is still using only in-memory runtime maps.
- OpenCode secondary lane receives UI message after restart but does not get identity recovery. This means `deliverOpenCodeMemberMessage()` checked `lanes.json` state but did not pass manifest `activeRunId` to `sendMessageToMember()`.
- Runtime delivery emits `{ data: { detail } }` directly as a public team-change event. This can make type-based message refresh work while detail-based relay/notification branches miss the file path. Keep public events on `TeamChangeEvent.detail`.

## Definition Of Done

- Native Codex/Claude prompts still use `SendMessage`.
- OpenCode launch, briefing, assignment, completion, and clarification instructions consistently use `agent-teams_message_send`.
- OpenCode cross-team instructions consistently use `agent-teams_cross_team_send`, not `message_send`.
- OpenCode readiness fails if required app MCP tools are absent.
- Orchestrator direct proof matches plain MCP names internally and emits canonical OpenCode ids in readiness evidence.
- Runtime tool descriptions make `message_send` the normal visible reply API and keep `runtime_deliver_message` scoped to explicit low-level runtime delivery flows.
- OpenCode can prove liveness through `runtime_bootstrap_checkin`.
- OpenCode secondary lanes can accept runtime evidence and receive identity-reminder messages after app restart using lane-scoped manifest `activeRunId`.
- OpenCode runtime delivery receives explicit reply recipient/action mode/taskRefs and does not parse native `SendMessage` hidden prompt text.
- OpenCode-targeted inbox rows do not persist native-only `SendMessage` instructions; retries can safely rebuild OpenCode-native runtime prompts.
- `message_send` canonicalizes local recipients/senders before persistence, so lead aliases and unknown recipients cannot create wrong inbox files.
- UI direct sends to live OpenCode teammates either confirm runtime delivery or show a visible warning; there is no log-only post-send delivery failure.
- Persisted inbox messages addressed to OpenCode teammates are live-relayed to their runtime lanes, while native teammates keep file-watch behavior and lead keeps lead relay behavior.
- OpenCode inbox relay is direct-to-runtime and does not reuse native `relayMemberInboxMessages()` / `SendMessage` forwarding.
- Pure OpenCode lead inbox delivery is not silently consumed: without a real OpenCode lead session, rows remain unread and diagnostics say `opencode_lead_runtime_session_missing` or equivalent.
- Renderer send-message actions return `SendMessageResult` on success and reject on real send failure, so pending-reply cleanup is not dependent on dead `.catch()` paths.
- `message_send` cannot create `from: "user", to: "user"` rows; user-directed MCP replies require a configured teammate sender.
- OpenCode replies appear in Messages UI without frontend fake state.
- Tests cover native default, OpenCode override, assignment protocol, tool alias canonicalization, tool proof, taskRefs persistence, user-directed sender guard, local recipient canonicalization, direct-message runtime delivery result visibility, OpenCode reply feed projection, OpenCode-targeted inbox relay/dedupe, unsupported OpenCode lead diagnostics, launch identity injection, lane-scoped manifest activeRunId recovery, and runtime delivery team-change event shape.
