# Messenger Connectors Uncertainty Pass 83

Focus:

Does the public UI/API vocabulary stay provider-neutral after Telegram topics became only one route-container implementation?

Finding:

The core architecture now models `ExternalRouteEntryPoint`, `ProviderRouteAddress`, `RouteActivationProof` and `TeamRouteBinding`, but the current public API still used Telegram-shaped names:

```text
syncTeamTopic
setTeamTopicEnabled
MessengerTeamBindingDto
```

That would leak the Telegram default into browser/UI contracts and make Slack root-message threads, Discord threads and WhatsApp selector state look like second-class exceptions.

Current public vocabulary:

```text
syncTeamRoute
setTeamRouteEnabled
MessengerTeamRouteDto
GET  /api/messenger/team-routes
POST /api/messenger/team-routes/:teamRouteId/sync
PATCH /api/messenger/team-routes/:teamRouteId
POST /api/messenger/team-routes/:teamRouteId/repair
```

Boundary rule:

`teamRouteId` is app-owned and opaque. It is not Telegram `chat_id`, Telegram `message_thread_id`, Slack thread timestamp, Discord thread id or WhatsApp selector id.

Provider-specific words are still allowed in:

- provider adapter code;
- provider capability probes;
- provider-specific labels in UI, such as "Telegram topic";
- historical research notes;
- source links and external fact sections.

Provider-specific words are not allowed in:

- shared `contracts/api` method names;
- renderer transport client method names;
- HTTP route namespace names;
- domain-neutral use-case names;
- repository names.

Top 3 implementation options:

1. Provider-neutral public route API now - 🎯 9   🛡️ 9   🧠 3, about `150-400` LOC.
   - Recommended.
   - Prevents Slack/Discord/WhatsApp API drift before implementation starts.
2. Keep topic names in API and alias later - 🎯 6   🛡️ 6   🧠 2, about `80-250` LOC now plus migration later.
   - Faster now.
   - Creates avoidable breaking rename when a second provider arrives.
3. Provider-specific UI APIs per connector - 🎯 5   🛡️ 5   🧠 5, about `400-900` LOC.
   - Flexible per provider.
   - Duplicates renderer logic and weakens the shared product model.

Verdict:

Use provider-neutral `team route` vocabulary in public contracts. Keep Telegram topic as a provider-specific route label and adapter detail.
