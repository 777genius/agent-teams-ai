# Team group chats

The main composition owns membership, canonical posts and reaction mutations; IPC
and HTTP adapters share that authority. Renderer components use the feature API
through the app transport abstraction. Public entrypoints are `contracts`, `main`,
`preload`, `renderer`, and the root HTTP adapter export.

`GroupChatStorage` owns the bounded, locked registry/inbox/reaction files. A
reaction changes only `group-chat-reactions.json` and emits `group-reactions` when
the visible actor set changes. Agent acknowledgements require protocol 1 from the
current reaction consumer and a matching stored physical inbound/run. The internal
proof query reads only the atomically replaced reaction snapshot without inbox
locks or runtime probes. It cannot treat human reactions as consumption proof.

Focused coverage lives in `test/features/team-group-chats`, with OpenCode
consumption checks at its delivery/read-commit seams and controller/MCP transport
checks in their existing test suites.

Agent creation uses `group_chat_create` through the app-bound control API. The human must explicitly request creation in an original direct or group message addressed to the actor. The tool takes that saved original `sourceMessageId` (the canonical `groupMessageId` for group posts), at least two selected current agents, a name and an optional auto policy defaulting to true. The human participates implicitly; the lead is optional. Direct sources require stored DO or lead DELEGATE; ASK and historical rows without a mode cannot create a new chat. Main proves provenance/address/mode; semantic intent is the agent's responsibility.

One original request creates one chat. Uncertain retries keep the same original ID and unchanged normalized payload. Identical accepted retries return the current stored group after archive, rename, roster expansion or source retention loss, without restoring it or changing membership. Conflicting payloads fail. Creation emits the existing catalog change event, without posting, creating tasks or launching runtimes. Replies use the originating conversation. The tool is unavailable without the desktop binding.
