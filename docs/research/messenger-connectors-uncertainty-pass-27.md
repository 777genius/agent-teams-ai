# Messenger Connectors - Uncertainty Pass 27

Date: 2026-04-28
Scope: remaining low-confidence areas after topic capability design
Context source: previous architecture worktree doc at `/Users/belief/dev/projects/claude/_worktrees/claude_team_messenger_connectors/docs/messenger-connectors-architecture.md`

## Executive Delta

The highest risk is no longer "can Telegram topics work at all". The design now has proof and fallback paths.

The next real risk is identity and lifecycle:

```text
Telegram topic route -> team identity -> member identity -> message identity
```

Current app code is mostly keyed by `teamName`. That is workable for UI, but risky for messenger routes because external provider state can outlive local team folders.

## Source Facts Rechecked

Telegram official docs checked on 2026-04-28:

- `getUpdates` update ids are useful for ignoring repeated webhook or polling updates.
- Telegram stores incoming updates only until the bot receives them, and not longer than 24 hours.
- Webhooks retry on non-2xx responses.
- `User.has_topics_enabled` and `User.allows_users_to_create_topics` are returned only by `getMe`.
- Bot API 9.4 allowed bots to create topics in private chats and allowed bots to prevent users from creating/deleting topics through BotFather Mini App.
- `reply_to_message` is only for replies in the same chat and message thread.
- `external_reply` can come from another chat or forum topic and must not be used for teammate routing.
- MTProto send errors include `TOPIC_CLOSED` and `TOPIC_DELETED`; Bot API adapter should classify equivalent provider failures into typed sanitized errors.

Local code facts checked:

- `TeamConfig` has `name`, `description`, `color`, `members`, `projectPath`, `leadSessionId`, `deletedAt`, but no public stable `teamId`.
- `TeamChangeEvent` does not include delete, restore, permanent-delete or rename event types.
- `deleteTeam` soft-deletes by writing `deletedAt` into `config.json`.
- `restoreTeam` removes `deletedAt`.
- `permanentlyDeleteTeam` removes team and task dirs.
- Team backup has private `identityId` and writes `_backupIdentityId` into config as a backup guard, but this is not a product-level team identity.
- Many runtime paths use `teamName` as the runtime/team id.

Sources:

- https://core.telegram.org/bots/api
- https://core.telegram.org/bots/api-changelog
- https://core.telegram.org/method/messages.sendMessage

## 1. Team Identity Gap

Messenger routes must not be keyed only by `teamName`.

Danger scenario:

```text
1. User connects Telegram topic to teamName="frontend".
2. User permanently deletes the team.
3. User later creates a new unrelated team with the same teamName="frontend".
4. Old Telegram topic receives a message.
5. If route is keyed only by teamName, message can route to the new unrelated team.
```

This is worse than a normal UI cache bug because Telegram routes are external and long-lived.

Top 3 team identity options:

1. Add feature-owned `messengerTeamIdentityId` registry keyed by current `teamName` and backup marker if available - 🎯 8   🛡️ 8   🧠 5, approx 700-1400 LOC.
   - Does not require changing global `TeamConfig` schema immediately.
   - Gives messenger routes stable identity.
   - Can reconcile with `_backupIdentityId` but does not depend on it.

2. Promote a stable `teamId` into `TeamConfig` globally - 🎯 7   🛡️ 9   🧠 8, approx 1800-4000 LOC.
   - Best long-term domain model.
   - Larger migration blast radius because many services assume `teamName`.

3. Keep `teamName` only and rely on tombstones - 🎯 5   🛡️ 6   🧠 3, approx 400-900 LOC.
   - Fast.
   - Still fragile when tombstones are pruned or route state is restored from backup.

Recommendation:

```text
Use option 1 for messenger MVP.
Design it so global TeamConfig.teamId can replace it later.
```

Suggested identity record:

```ts
type MessengerTeamIdentityRecord = {
  messengerTeamIdentityId: string;
  currentTeamName: string;
  observedDisplayName: string;
  backupIdentityId?: string;
  firstSeenAt: string;
  lastSeenAt: string;
  state:
    | "active"
    | "soft_deleted"
    | "restored_requires_reconnect"
    | "permanently_deleted"
    | "name_reused_different_identity";
};
```

Route binding should store both:

```text
teamNameSnapshot
messengerTeamIdentityId
routeGeneration
```

The runtime delivery adapter can still call existing services by `teamName`, but only after the identity registry confirms that the route still points to the current team folder.

## 2. Lifecycle Hooks Need Command-Side Events

File watcher events are not enough for messenger routes.

Why:

- Soft delete and restore are command intents, not just file changes.
- Permanent delete removes files before a watcher can read useful context.
- Connector cleanup must run before or during destructive operations.
- Renderer-only refresh events cannot protect background delivery.

Required main-process lifecycle port:

```ts
type MessengerTeamLifecyclePort = {
  beforeSoftDeleteTeam(input: { teamName: string }): Promise<void>;
  afterSoftDeleteTeam(input: { teamName: string; deletedAt: string }): Promise<void>;
  beforeRestoreTeam(input: { teamName: string }): Promise<void>;
  afterRestoreTeam(input: { teamName: string }): Promise<void>;
  beforePermanentDeleteTeam(input: { teamName: string; deleteLocalConnectorPlaintext: boolean }): Promise<void>;
  afterPermanentDeleteTeam(input: { teamName: string }): Promise<void>;
  afterTeamConfigChanged(input: { teamName: string; previousDisplayName: string; nextDisplayName: string }): Promise<void>;
};
```

Top 3 integration points:

1. Call messenger facade directly from team IPC handlers around delete/restore/updateConfig - 🎯 8   🛡️ 9   🧠 6, approx 900-1800 LOC.
   - Strong command ordering.
   - Easy to test with mocked facade.

2. Emit richer domain events from `TeamDataService` and subscribe in messenger feature - 🎯 8   🛡️ 9   🧠 7, approx 1200-2500 LOC.
   - Cleaner long-term.
   - Wider refactor.

3. Infer lifecycle from file watcher and config scans - 🎯 5   🛡️ 6   🧠 4, approx 600-1200 LOC.
   - Too late for permanent delete.
   - Race-prone.

Recommendation:

```text
Use option 1 first.
Keep the facade shape compatible with option 2 later.
```

## 3. Member Identity Gap

Team members are also name-keyed.

Risk:

```text
1. Telegram bot sends a teammate message from "Alex".
2. User replies to that bot message later.
3. Meanwhile "Alex" was removed and a different member with same name was added.
4. Reply may route to the wrong teammate unless the message link stores member generation.
```

Minimum route target identity:

```ts
type MessengerRouteTarget =
  | { kind: "lead"; teamIdentityId: string; leadSessionId?: string | null }
  | {
      kind: "teammate";
      teamIdentityId: string;
      memberNameSnapshot: string;
      memberAgentIdSnapshot?: string;
      memberRouteGeneration: number;
    };
```

Top 3 member identity strategies:

1. Use `agentId` when present, otherwise member name plus `memberRouteGeneration` - 🎯 8   🛡️ 8   🧠 5, approx 700-1500 LOC.
   - Fits current data.
   - Avoids blocking MVP on member schema migration.

2. Add stable `memberId` to every member and migrate roster stores - 🎯 7   🛡️ 9   🧠 8, approx 1800-4000 LOC.
   - Best long-term.
   - Larger blast radius.

3. Use member display name only - 🎯 5   🛡️ 5   🧠 2, approx 200-600 LOC.
   - Too weak for delayed Telegram replies.

Recommendation:

```text
Use option 1 in MVP.
Store target snapshots in every ProviderMessageLink.
```

## 4. ProviderMessageLink Must Be A Contract, Not Cache

The link is the most important durable object in the feature.

Recommended shape:

```ts
type ProviderMessageLink = {
  linkId: string;
  provider: "telegram";
  accountBindingId: string;
  routeId: string;
  routeGeneration: number;
  providerChatId: string;
  providerThreadId: string | null;
  providerMessageId: string;
  internalMessageId: string;
  internalMessageKind:
    | "messenger_inbound"
    | "lead_reply"
    | "teammate_reply"
    | "system_notice"
    | "topic_probe";
  origin:
    | "provider_user"
    | "team_lead"
    | "team_teammate"
    | "connector_system";
  target: MessengerRouteTarget;
  createdAt: string;
  expiresAt?: string;
};
```

Rules:

- Never trim links only because UI messages were trimmed.
- Links for route targets should outlive `sentMessages.json`.
- Links for topic probes can have short TTL.
- Links from tombstoned routes should remain as tombstones long enough to block stale replies.

## 5. Reply Routing Should Be Two-Phase

Do not immediately turn a Telegram reply into a teammate message.

Phase 1 - resolve anchor:

```text
reply_to_message.message_id -> ProviderMessageLink
same chat id?
same thread id?
same account binding?
same route generation?
link target still valid?
```

Phase 2 - route message:

```text
valid teammate target -> teammate inbox
valid lead target -> lead
missing/stale target -> lead with context
tombstoned route -> reject with reconnect notice
unknown topic -> help flow
```

Critical rule:

```text
external_reply must never route to a teammate.
```

Bot API explicitly distinguishes same-thread `reply_to_message` from `external_reply`, so adapter normalization must preserve that distinction.

## 6. Privacy Risk Shift

After the no-plaintext-queue decision, the main privacy risk is not storage. It is accidental logging and diagnostic capture.

High-risk payloads:

```text
Telegram update JSON
callback_query data if it embeds route ids
Bot API error description if request URL/token leaks through HTTP client
message text in failed sends
team display names in topic titles
member names in projected message prefixes
```

Top 3 diagnostic strategies:

1. Feature-owned sanitized diagnostic DTOs plus tests - 🎯 9   🛡️ 9   🧠 5, approx 700-1500 LOC.
2. Generic logger wrapper only - 🎯 6   🛡️ 6   🧠 4, approx 400-900 LOC.
3. Rely on "do not log raw errors" convention - 🎯 3   🛡️ 3   🧠 1, 0 LOC.

Recommendation:

```text
Use option 1.
Also add Sentry beforeSend scrubbing as defense in depth.
```

## 7. Current Lowest-Confidence Map

1. Cross-client Telegram private topic UX - 🎯 5   🛡️ 8   🧠 6.
   - Requires live probe.
   - Design is resilient because of account-level confirmation and fallback.

2. Stable local team identity for external routes - 🎯 6   🛡️ 8   🧠 6.
   - Current app is name-keyed.
   - Needs a messenger-owned identity registry before route activation.

3. Member identity for delayed teammate replies - 🎯 6   🛡️ 8   🧠 6.
   - Current member names can be reused.
   - Store `agentId` and member generation snapshots.

4. Lifecycle ordering on permanent delete - 🎯 7   🛡️ 9   🧠 6.
   - Policy is clear.
   - Needs command-side hook, not watcher inference.

5. Outbound ambiguous Telegram sends - 🎯 7   🛡️ 9   🧠 6.
   - Technical state is clear: `acceptance_unknown`.
   - UX still needs concise wording.

6. Flat menu fallback correctness - 🎯 8   🛡️ 8   🧠 6.
   - Good fallback.
   - Needs strict selection lease tests to avoid wrong-team delivery.

## 8. Revised Next Slice

Before building UI, implement/test these core pieces:

1. Messenger identity registry and route generation policy - 🎯 9   🛡️ 9   🧠 6, approx 1000-2200 LOC.
2. ProviderMessageLink repository and reply route resolver - 🎯 9   🛡️ 9   🧠 6, approx 1200-2600 LOC.
3. Team lifecycle facade hooks around delete/restore/permanent delete/updateConfig - 🎯 8   🛡️ 9   🧠 6, approx 900-1800 LOC.
4. Telegram topic live probe fixtures - 🎯 9   🛡️ 9   🧠 5, approx 700-1500 LOC.

This is the point where the design becomes robust against the bugs most likely to happen months later, not only during the happy-path onboarding demo.
