# Team Direct Chats

Thin Messages navigation slice: chat list, then a 1:1 thread on the same panel.

Read first:
- [Feature Architecture Standard](../../../docs/FEATURE_ARCHITECTURE_STANDARD.md)
- [Implementation plan](../../../docs/research/team-direct-chats-plan.md)
- [Feature-local guidance](../CLAUDE.md)

Public entrypoint:
- `@features/team-direct-chats/renderer`

Shape:
- `core/domain` owns conversation membership (lead chat includes teammate→lead), user-unread, attention, preview, optional activity sort, and chat-list rows
- `renderer` owns the list/thread surface, badges, and conversation navigation hook

This feature does not own inbox transport, IPC, or `getMessagesPage`.
