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
