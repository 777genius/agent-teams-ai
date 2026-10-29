import { GroupChatError, isGroupPhysicalId, isGroupUuid } from './model.js';

export interface GroupReactionActor {
  name: string;
  reactedAt: string;
  inboxMessageId?: string;
  groupRunKey?: string;
}

export interface GroupMessageReactions {
  groupChatId: string;
  messageId: string;
  actors: GroupReactionActor[];
}

/** Reject corrupt writer sources rather than normalizing them into an empty set. */
export function parseGroupReactions(raw: unknown): GroupMessageReactions[] {
  if (raw === undefined) return [];
  const document = raw as { version?: unknown; entries?: unknown };
  const fail = (): never => {
    throw new GroupChatError('storage-unavailable', 'Malformed reaction storage');
  };
  if (!document || document.version !== 1 || !Array.isArray(document.entries)) fail();
  const entries = document.entries as GroupMessageReactions[];
  const targets = new Set<string>();
  for (const entry of entries) {
    if (
      !entry ||
      !isGroupUuid(entry.groupChatId) ||
      !isGroupUuid(entry.messageId) ||
      !Array.isArray(entry.actors)
    )
      fail();
    const key = `${entry.groupChatId}:${entry.messageId}`;
    if (targets.has(key)) fail();
    targets.add(key);
    const names = new Set<string>();
    for (const actor of entry.actors) {
      if (
        !actor ||
        typeof actor.name !== 'string' ||
        !actor.name ||
        actor.name.length > 200 ||
        actor.name.trim() !== actor.name ||
        names.has(actor.name) ||
        typeof actor.reactedAt !== 'string' ||
        !Number.isFinite(Date.parse(actor.reactedAt))
      )
        fail();
      names.add(actor.name);
      if (actor.name.toLowerCase() === 'user' && actor.name !== 'user') fail();
      if (actor.name === 'user') {
        if (actor.inboxMessageId !== undefined || actor.groupRunKey !== undefined) fail();
      } else if (
        !isGroupPhysicalId(actor.inboxMessageId) ||
        typeof actor.groupRunKey !== 'string' ||
        !actor.groupRunKey ||
        actor.groupRunKey.length > 500
      )
        fail();
    }
  }
  return entries;
}
