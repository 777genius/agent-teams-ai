# Messenger Connectors Uncertainty Pass 93

Date: 2026-05-16
Scope: repeat freshness and coherence audit after another user-requested code/doc review

## Why This Pass Exists

The previous pass found that the active local `dev` worktree was behind `origin/dev` and recorded the relevant OpenCode MCP HTTP changes. This pass repeats the check after another `git fetch origin dev` and then re-reads the specific source files that could invalidate the messenger architecture.

Fresh remote head after fetch:

```text
origin/dev bfad861b
Merge pull request #119 from 777genius/fix/opencode-windows-live-stability
```

No newer remote commit was found after pass 92.

## Files Rechecked

The pass rechecked the source surfaces that matter for the chain:

```text
Telegram topic -> team -> local external turn -> lead/runtime -> visible reply -> Telegram reply
```

Rechecked files:

- `docs/FEATURE_ARCHITECTURE_STANDARD.md`
- `src/main/index.ts`
- `src/main/http/index.ts`
- `src/main/services/infrastructure/HttpServer.ts`
- `src/main/services/team/TeamDataService.ts`
- `mcp-server/src/tools/messageTools.ts`
- `agent-teams-controller/src/internal/messageStore.js`
- `agent-teams-controller/src/internal/atomicFile.js`
- `src/features/member-work-sync/main/composition/createMemberWorkSyncFeature.ts`
- `src/features/member-work-sync/main/infrastructure/JsonMemberWorkSyncStore.ts`
- `src/features/recent-projects/main/adapters/input/http/registerRecentProjectsHttp.ts`
- `package.json`

## Findings

No architecture conflict was found.

The current docs remain coherent with code:

- Medium/large features still belong in `src/features/<feature-name>/` with contracts, pure core, main composition, adapters, infrastructure, preload and renderer entrypoints.
- Existing Fastify `HttpServer` remains the right HTTP-first local API boundary.
- Global CORS is still permissive enough in standalone mode that messenger mutating routes need feature-local Host, Origin, local session cookie and CSRF checks.
- Feature HTTP route registration still flows through `src/main/http/index.ts`; `recent-projects` remains the small route-registration reference.
- `member-work-sync` remains the best large-feature reference for composition and file-backed durable stores.
- `JsonMemberWorkSyncStore` still supports the recommended storage shape: feature-owned files, schema versions, file locks, atomic writes, indexes, repair and quarantine.
- `message_send` still exposes `relayOfMessageId`, `source`, `leadSessionId`, `attachments` and `taskRefs`.
- `message_send` still returns an instruction to stop after an app-delivered runtime reply.
- Controller message store still has atomic writes, exact `lookupMessage`, ambiguous-id rejection and same-text `runtime_delivery` dedupe.
- Controller message store still does not provide final provider-send proof by itself.
- `TeamDataService.sendMessage()` still does not pass `relayOfMessageId` into `controller.messages.sendMessage()`.
- The desktop package still has no direct Telegram SDK, `zod`, SQLite, Redis, BullMQ, Bottleneck or `fast-check` dependency.

## Coherence Verdict

Current architecture is internally consistent:

```text
src/features/messenger-connectors
  pure core owns provider-neutral routing and proof policy
  main adapters own Telegram, local HTTP, runtime bridges and storage
  existing Fastify server is reused
  feature-local HTTP protections wrap sensitive routes
  MessengerStateStorePort + MessengerUnitOfWork hide physical JSON tables
  OpenCode MCP HTTP is preferred when proven
  native/non-OpenCode auto-send remains gated
  ExternalReplyProjectionIntent remains the provider auto-send boundary
```

The latest source does not justify weakening the proof model. The main practical improvement remains OpenCode MCP HTTP availability, not provider-send correctness.

## Top 3 Options After This Recheck

1. Keep current architecture unchanged and implement with proof gates - 🎯 10   🛡️ 9   🧠 6, approx `6500-10000` LOC.
   Best path. It matches the fresh code and keeps future Slack/Discord/WhatsApp adapters possible without refactoring core.

2. Simplify because OpenCode MCP HTTP now starts by default - 🎯 6   🛡️ 6   🧠 4, approx `4500-7000` LOC.
   Not recommended. Better bridge availability is not the same as durable provider-send proof.

3. Split Telegram into `main/services` first and abstract later - 🎯 5   🛡️ 5   🧠 5, approx `3000-5500` LOC.
   Fast demo route, but conflicts with the feature architecture standard and will make Slack support much more expensive.

## Confidence

Docs are coherent with fresh code:

🎯 9.8   🛡️ 9.6   🧠 4

Implementation risk remains concentrated in provider-send proof, local store transactions and exact reply routing, not in file placement or HTTP registration.
