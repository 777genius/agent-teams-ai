# Messenger Connectors Uncertainty Pass 92

Date: 2026-05-16
Scope: origin/dev freshness audit after discovering local `dev` was behind

## Why This Pass Exists

During pass 91 the local `dev` worktree reported:

```text
dev...origin/dev [ahead 2, behind 4]
```

So this pass reads `dev..origin/dev` without switching branches or touching the dirty landing worktree.

Fresh remote head checked:

```text
origin/dev bfad861b
Merge pull request #119 from 777genius/fix/opencode-windows-live-stability
```

## Relevant Origin Changes

No direct changes were found in:

- Telegram dependencies;
- `mcp-server/src/tools/messageTools.ts`;
- `agent-teams-controller/src/internal/messageStore.js`;
- `agent-teams-controller/src/internal/atomicFile.js`;
- `src/main/services/infrastructure/HttpServer.ts`;
- `src/main/http/index.ts`;
- `src/main/services/team/TeamDataService.ts` relay pass-through.

Important indirect changes:

- `src/main/index.ts` now attempts to start the Agent Teams MCP HTTP server for the OpenCode bridge by default, then falls back to command-launch env if the HTTP server is unavailable.
- `src/main/services/team/TeamProvisioningService.ts` widens the Windows `pidusage` cache window for runtime liveness stability.
- `src/features/member-work-sync/core/application/MemberWorkSyncNudgeActivationPolicy.ts` removes `native_stale_in_progress`.
- `src/features/recent-projects` removes `filesystemState` from the reference feature model.
- `package.json` removes `@radix-ui/react-dropdown-menu`; no messenger-relevant dependency is added.

## Architecture Impact

OpenCode runtime proof:

```text
before:
  MCP HTTP bridge could depend on explicit env flag or command fallback

origin/dev:
  MCP HTTP bridge is attempted by default
  command-launch env remains fallback
```

This improves the practical chance that OpenCode teammates can use `message_send(relayOfMessageId=...)`, but it does not eliminate capability checks. The messenger feature should record actual runtime proof capabilities per route/member:

```text
mcp_http_bridge_started
mcp_tools_list_verified
message_send_schema_verified
visible_reply_store_commit_observable
```

Native/non-OpenCode runtime proof:

```text
origin/dev removed native_stale_in_progress bypass
```

This supports the existing messenger stance:

- non-OpenCode providers cannot be treated as auto-reply-safe by default;
- native user-directed `SendMessage(to="user")` stays local/manual unless connector sidecar proof attaches exact `relayOfMessageId`;
- runtime capability gates are provider/member specific, not global.

Recent-projects reference:

```text
filesystemState removed from recent-projects
```

This has no messenger behavior impact. It is a useful reminder that `recent-projects` is a feature-shape reference, not a field-model template. Messenger should keep its own domain fields and not copy incidental DTO fields from reference features.

## Updated Current Rule

Messenger should treat OpenCode MCP HTTP as a preferred runtime bridge path when available, but not as an invariant.

```text
if OpenCode MCP HTTP bridge starts and tools/list proves message_send schema:
  allow automatic reply proof path after store readback and connector proof ledger

if bridge falls back to command env and schema proof still passes:
  same path, with diagnostic evidence

if no message_send schema proof:
  connected/manual or local-only mode, no Telegram auto-send
```

## Top 3 Options

1. Capability-recorded OpenCode MCP HTTP default path - 🎯 9   🛡️ 9   🧠 6, approx `900-2200` LOC.
   Recommended. Use the fresher default bridge, but keep proof evidence and fallback diagnostics.

2. Assume OpenCode always has `message_send` because MCP HTTP starts by default - 🎯 6   🛡️ 6   🧠 3, approx `300-900` LOC.
   Too optimistic. Startup can still fail and schema can drift.

3. Ignore MCP HTTP default and keep old command-only assumptions - 🎯 5   🛡️ 7   🧠 5, approx `600-1400` LOC.
   Safer than option 2, but misses the fresh code direction and produces weaker UX.

## Confidence After This Pass

No architecture conflict from `origin/dev`:

🎯 9.7   🛡️ 9.5   🧠 4

OpenCode reply path availability is better than before:

🎯 8.8   🛡️ 8.4   🧠 5

Non-OpenCode/native auto-reply remains gated:

🎯 9.4   🛡️ 9.3   🧠 6

The architecture is still organic. `origin/dev` mostly strengthens the current proof-gated design instead of changing it.
