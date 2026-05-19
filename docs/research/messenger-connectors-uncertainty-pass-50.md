# Messenger Connectors - Uncertainty Pass 50

Date: 2026-04-30
Scope: Telegram private-chat topic compatibility, live fixture gate, callback and inbound proof, route activation safety, topic fallback release policy

## 1. Bottom Line

The weakest remaining product risk is private-chat topics as the default UX.

Official Bot API support exists, but the risk is not "can the API create a topic". The risk is:

```text
Will a real user on Telegram Desktop, iOS, Android and Web clearly see and use
the intended per-team topic, and will the webhook updates contain enough stable
identity to route messages without guessing?
```

Updated recommendation:

🎯 8   🛡️ 9   🧠 7   Approx `1200-2600` LOC on top of earlier topic work

```text
Keep private-chat topics as the preferred default,
but activate them per account only after a live topic compatibility fixture
and per-team activation proof.
```

Hard rule:

```text
createForumTopic success + sendMessage success is not enough to mark a team route active.
The route needs provider identity plus user-visible confirmation evidence.
```

Release fallback:

```text
If topic compatibility is not proven for the user/account/client set,
fall back to private DM selector mode instead of silently shipping a fragile topic route.
```

## 2. Official Facts Rechecked

### 2.1 Bot API supports private-chat topics

Official Bot API 9.4 changelog says bots can create topics in private chats using `createForumTopic`, and BotFather can prevent users from creating/deleting topics in private chats.

Official `createForumTopic` docs say it can create a topic in:

```text
forum supergroup chat
private chat with a user
```

It returns `ForumTopic`, whose durable field is:

```text
message_thread_id
```

Implication:

```text
message_thread_id is the provider route identity candidate.
topic title is display state only.
```

### 2.2 Capability fields exist only on getMe

Official `User` fields returned only in `getMe`:

```text
has_topics_enabled
allows_users_to_create_topics
can_manage_bots
```

Implication:

```text
Private-topic provisioning starts with getMe.
Successful token validation is not enough.
```

### 2.3 Message fields are enough for topic routing when present

Official `Message` includes:

```text
message_id
message_thread_id
chat
from
is_topic_message
reply_to_message
external_reply
```

`message_thread_id` belongs to a thread/topic for supergroups and private chats.

`is_topic_message` is true for messages sent to a topic in a forum supergroup or private chat with the bot.

Implication:

```text
Inbound topic messages can route by chat_id + message_thread_id only when the
thread id is present and known in our route registry.
```

### 2.4 CallbackQuery can lose full message access

Official `CallbackQuery.message` is `MaybeInaccessibleMessage`.

`MaybeInaccessibleMessage` can be:

```text
Message
InaccessibleMessage
```

`InaccessibleMessage` contains only:

```text
chat
message_id
date = 0
```

Implication:

```text
Callback confirmation must not depend only on callback_query.message.message_thread_id.
The fallback proof is the stored probe message id + signed callback nonce.
```

### 2.5 There is no safe route from topic title

Inference from Bot API docs:

```text
Bot API exposes create/edit/delete topic operations and message_thread_id,
but no reliable "list all private bot-chat topics and map names to teams" method
is documented.
```

Implication:

```text
Store every created topic result.
Never recover route identity from title.
If local route state is lost, require repair or fallback selector mode.
```

## 3. Topic Compatibility Evidence

Add an explicit evidence record before enabling topic mode for an account.

```ts
interface TelegramTopicCompatibilityEvidence {
  accountBindingId: string;
  botUserId: string;
  checkedAt: string;
  botApiVersionObserved: string | null;
  hasTopicsEnabled: boolean;
  allowsUsersToCreateTopics: boolean | null;
  clientMatrix: TelegramTopicClientEvidence[];
  verdict: "passed" | "partial" | "failed" | "unknown";
  reasonCodes: string[];
}

interface TelegramTopicClientEvidence {
  client: "desktop" | "ios" | "android" | "web" | "unknown";
  clientVersion: string | null;
  probeTopicCreated: boolean;
  probeMessageSent: boolean;
  callbackReceived: boolean;
  callbackHadMessageThreadId: boolean | null;
  callbackLinkedByProbeMessageId: boolean | null;
  inboundTextHadMessageThreadId: boolean | null;
  userConfirmedVisibleTopic: boolean | null;
  sanitizedFixturePath: string | null;
}
```

Privacy rule:

```text
Fixtures store sanitized update shape, ids, booleans and error codes.
Fixtures must not store message text, captions, file names, contact data,
location data, screenshots with visible user content, bot token or auth headers.
```

## 4. Per-Team Activation Proof

Per-team route activation should require a specific proof record.

```ts
interface TelegramTopicRouteActivationProof {
  routeBindingId: string;
  accountBindingId: string;
  teamId: string;
  chatId: string;
  messageThreadId: number;
  routeGeneration: number;
  createForumTopicResultId: string;
  probeProviderMessageKey: string;
  proofKind:
    | "callback_same_thread"
    | "callback_probe_message_link"
    | "inbound_same_thread";
  proofReceivedAt: string;
  confirmedByTelegramUserId: string;
  nonceHash: string | null;
}
```

Activation rules:

```text
callback_same_thread:
  callback_query.message is Message
  message.chat.id matches expected chat
  message.message_thread_id matches expected thread
  signed callback nonce matches stored probe

callback_probe_message_link:
  callback_query.message is Message or InaccessibleMessage
  message.chat.id and message.message_id match stored probe message
  signed callback nonce matches stored probe
  route remains active because the probe was sent into the stored thread

inbound_same_thread:
  user sends a text message inside the topic
  update.message.chat.id matches expected chat
  update.message.message_thread_id matches expected thread
```

Do not activate from:

- `createForumTopic` success alone;
- `sendMessage` success alone;
- callback data without stored signed nonce;
- callback data without matching probe message key;
- topic title;
- last selected team;
- newest Telegram message in the private chat.

## 5. Client Matrix Gate

### 5.1 Recommended release gate

Recommended:

🎯 8   🛡️ 9   🧠 7   Approx `900-1800` LOC

```text
Official shared bot account must pass a maintained live fixture matrix before
private topics are shown as the default setup path for normal users.
```

Minimum matrix:

```text
Telegram Desktop latest stable
Telegram iOS latest stable
Telegram Android latest stable
Telegram Web latest stable
```

Minimum pass criteria per client:

```text
1. User can see the created team topic clearly.
2. Bot probe message appears in that topic.
3. Inline button callback reaches webhook.
4. Callback can be linked to the probe by same-thread proof or probe message id.
5. User text sent in the topic reaches webhook with expected chat_id + message_thread_id.
6. Bot reply using the same message_thread_id appears in the same topic.
7. Plain private DM outside a topic does not get routed to a team.
```

If any client fails:

```text
Use selector mode for that account by default.
Offer private topics as advanced/beta only if the user explicitly accepts risk.
```

### 5.2 Top 3 release policies

1. Topics default only after live matrix passes - 🎯 8   🛡️ 9   🧠 7, approx `900-1800` LOC.
   Best balance. Keeps the nice UX but blocks fragile rollout.

2. Selector mode default, topics beta until fixture history is strong - 🎯 7   🛡️ 10   🧠 5, approx `700-1400` LOC.
   Safest product rollout, but loses the strongest "one topic per team" UX initially.

3. Topics default after Bot API create/send only - 🎯 4   🛡️ 5   🧠 3, approx `300-800` LOC.
   Reject. API success does not prove users can reliably navigate or confirm the right topic.

## 6. Live Fixture Harness

Create an opt-in harness command or internal diagnostics route.

Suggested command shape:

```text
messenger:telegram-topic-fixture
  --account-binding <id>
  --client desktop|ios|android|web
  --redact
  --json
```

Fixture steps:

```text
1. getMe and record has_topics_enabled / allows_users_to_create_topics.
2. createForumTopic for "Agent Teams Fixture <timestamp>".
3. Persist returned message_thread_id before sending anything else.
4. sendMessage into that thread with a signed inline button nonce.
5. Ask tester to confirm whether the topic is visible and usable.
6. Tester presses inline button.
7. Record callback shape, including whether message is inaccessible.
8. Tester sends a short text in the topic.
9. Record inbound update shape.
10. Bot replies in same message_thread_id.
11. Tester sends a plain DM outside topic.
12. Verify it is handled as setup/control, not routed to a team.
13. Optionally delete the test topic and capture send/delete error behavior.
```

Sanitized fixture output:

```json
{
  "client": "desktop",
  "hasTopicsEnabled": true,
  "allowsUsersToCreateTopics": false,
  "createdThreadIdPresent": true,
  "probeMessageIdPresent": true,
  "callbackMessageKind": "message",
  "callbackHadMessageThreadId": true,
  "callbackLinkedByProbeMessageId": true,
  "inboundHadMessageThreadId": true,
  "replyLandedInSameThread": true,
  "plainDmRoutedAsControl": true,
  "errors": []
}
```

## 7. Callback Confirmation Policy

The callback button should include a compact signed payload:

```ts
interface TopicProbeCallbackPayload {
  kind: "topic_probe";
  accountBindingId: string;
  routeBindingId: string;
  probeId: string;
  nonce: string;
  exp: number;
}
```

Because callback data size is limited, the payload should be encoded as:

```text
tp:<probeId>:<shortMac>
```

Backend/desktop route registry stores the full probe:

```ts
interface TopicProbeRecord {
  probeId: string;
  routeBindingId: string;
  expectedChatId: string;
  expectedMessageThreadId: number;
  expectedProbeMessageId: number;
  nonceHash: string;
  expiresAt: string;
}
```

Verification order:

```text
1. Verify MAC/nonce and expiry.
2. Check callback sender is the connected Telegram user.
3. If callback message is full Message, verify chat_id and message_thread_id.
4. If callback message is InaccessibleMessage, verify chat_id and message_id against stored probe message.
5. Mark route active only if probe send result was already durably persisted.
```

## 8. Inbound Topic Routing Policy

Normal inbound message:

```text
message.chat.id
message.message_thread_id
message.from.id
message.message_id
```

Routing:

```text
known active route:
  route to team lead

known tombstoned route:
  do not route
  send repair notice with cooldown if allowed

unknown thread:
  setup/help only

missing message_thread_id in topic mode:
  control/setup only

plain DM selector mode:
  route only if short-lived selected-team session exists
```

Reply target:

```text
reply_to_message in same chat/thread + stored ExternalMessageLink:
  can target specific teammate or lead

external_reply:
  display context only, not teammate-routeable in MVP

quote text:
  display only, not identity
```

## 9. Topic Deletion And Rename

Official docs expose `editForumTopic` and `deleteForumTopic` for private chats with a user, but do not provide a clear durable deleted-topic inbound event that we can rely on.

Policy:

```text
rename:
  keep route identity by message_thread_id
  update display title only after local user approval or successful edit result

delete:
  tombstone route generation
  do not auto-create a replacement on every failure
  require local repair action or fallback selector mode

recreate:
  create new routeGeneration
  never reuse old route binding id
```

Send failure classifier:

```text
invalid message thread / topic not found:
  repair_required + tombstone candidate

bot lacks topic capability:
  account topic_mode_broken

bad request from reply target:
  retry once without reply_parameters but keep message_thread_id

rate limit:
  provider outbox retry with Retry-After when provided
```

## 10. Tests To Add

Domain/application tests:

```text
topicCompatibility.requiresClientMatrixBeforeDefault
topicActivation.rejectsCreateOnly
topicActivation.acceptsCallbackSameThread
topicActivation.acceptsCallbackProbeMessageLink
topicActivation.rejectsUnsignedCallback
topicActivation.acceptsInboundSameThread
topicRouting.unknownThreadSetupOnly
topicRouting.tombstonedThreadNeverRoutes
topicRouting.missingThreadControlOnly
topicRouting.externalReplyDisplayOnly
topicRepair.deleteCreatesTombstoneGeneration
topicRepair.recreateUsesNewGeneration
```

Adapter tests:

```text
telegramCallback.messageShapeWithThread
telegramCallback.inaccessibleMessageShape
telegramInbound.messageThreadIdMapping
telegramSend.retryWithoutReplyParametersKeepsThread
telegramFixture.redactsPayloadText
```

Manual live fixture checklist:

```text
Desktop latest stable
iOS latest stable
Android latest stable
Web latest stable
old client if support policy requires it
```

## 11. Updated Lowest-Confidence Points

1. Real Telegram client UX for private bot-chat topics - 🎯 6   🛡️ 8   🧠 6.
   API support is clear, but client-visible UX still needs live fixtures.

2. CallbackQuery shape after time, deletion or old clients - 🎯 7   🛡️ 8   🧠 5.
   Official `MaybeInaccessibleMessage` means callback must have probe-message fallback.

3. Whether all clients preserve `message_thread_id` on user text exactly as expected - 🎯 7   🛡️ 9   🧠 5.
   Expected from docs, but must be fixture-proven.

4. Topic deletion/repair signals - 🎯 6   🛡️ 8   🧠 5.
   Send failures are reliable enough for repair, but inbound deletion events are not a safe dependency.

5. Default vs beta rollout for topics - 🎯 7   🛡️ 9   🧠 6.
   If fixtures are incomplete, selector default is safer despite worse UX.

## 12. Source Links

- Telegram Bot API changelog: https://core.telegram.org/bots/api-changelog
- Telegram Bot API `User`: https://core.telegram.org/bots/api#user
- Telegram Bot API `Message`: https://core.telegram.org/bots/api#message
- Telegram Bot API `CallbackQuery`: https://core.telegram.org/bots/api#callbackquery
- Telegram Bot API `MaybeInaccessibleMessage`: https://core.telegram.org/bots/api#maybeinaccessiblemessage
- Telegram Bot API `ForumTopic`: https://core.telegram.org/bots/api#forumtopic
- Telegram Bot API `sendMessage`: https://core.telegram.org/bots/api#sendmessage
- Telegram Bot API `createForumTopic`: https://core.telegram.org/bots/api#createforumtopic
- Telegram Bot API `editForumTopic`: https://core.telegram.org/bots/api#editforumtopic
- Telegram Bot API `deleteForumTopic`: https://core.telegram.org/bots/api#deleteforumtopic
- grammY npm: https://www.npmjs.com/package/grammy
- @grammyjs/types npm: https://www.npmjs.com/package/@grammyjs/types
