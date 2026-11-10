import { HostTeamOperationError } from './createHostTeamMutations';
import { remapHostCrossTeamMessages } from './remapHostCrossTeamMessages';

import type { BackendConnectionSnapshot } from '../contracts/connections';
import type { AgentBackendApi } from '../contracts/operations';
import type { BackendTeamMessagesPage } from '../contracts/teamSnapshot';
import type { TeamProductReadOrder } from './TeamProductReadOrder';

type Connection = BackendConnectionSnapshot['bindings'][number];
type Message = BackendTeamMessagesPage['messages'][number];

function complete(parts: Map<number, { total: number; values: Map<number, Message> }>) {
  return [...parts.values()].every((group) => group.values.size === group.total);
}

function assemble(parts: Map<number, { total: number; values: Map<number, Message> }>): Message[] {
  return [...parts.entries()].sort(([a], [b]) => b - a).map(([, group]) => {
    const original = group.values.get(0);
    if (!original || group.values.size !== group.total)
      throw new Error('Incomplete Host message history');
    let text = original.text;
    for (let index = 1; index < group.total; index++) {
      const part = group.values.get(index);
      if (!part || part.from !== original.from || part.messageId !== original.messageId ||
          part.timestamp !== original.timestamp || part.read !== original.read)
        throw new Error('Mismatched Host message fragment');
      text += part.text;
    }
    return { ...original, text };
  });
}

/** A message is published only after its original signed Owner parts are complete. */
export async function readHostMessagesPage(
  backend: Pick<AgentBackendApi, 'invoke'>,
  connection: Connection,
  bindings: BackendConnectionSnapshot['bindings'],
  key: string,
  options: { cursor?: string | null; limit?: number; groupChatId?: string } | undefined,
  check: () => boolean,
  readOrder: TeamProductReadOrder
) {
  readOrder.capture(check);
  const readFence = readOrder.readFence(connection.handle.handleId);
  const groups = new Map<number, { total: number; values: Map<number, Message> }>();
  const seen = new Set<string>();
  let cursor = options?.cursor ?? undefined;
  let first: BackendTeamMessagesPage | undefined;
  for (let pageIndex = 0; pageIndex < 128; pageIndex++) {
    const result = await backend.invoke({
      handle: connection.handle,
      commandId: crypto.randomUUID(),
      operation: 'team.messages.page',
      payload: {
        ...(cursor === undefined ? {} : { cursor }),
        ...(options?.limit === undefined ? {} : { limit: options.limit }),
        ...(options?.groupChatId === undefined ? {} : { groupChatId: options.groupChatId }),
      },
    });
    if (!check()) throw new Error('Team context changed');
    readFence();
    if (!result.ok) throw new HostTeamOperationError(result.code, result.outcome);
    const page = result.value;
    if (!page || typeof page !== 'object' ||
        !('nextCursor' in page) || !('messages' in page) ||
        !('revision' in page) || !('teamName' in page) || !('hasMore' in page))
      throw new HostTeamOperationError('invalid-result', 'unknown');
    if (first && (page.teamName !== first.teamName || page.revision !== first.revision ||
        page.messageTotal !== first.messageTotal ||
        Boolean(page.messageParts) !== Boolean(first.messageParts)))
      throw new Error('Host message history changed during paged read');
    first ??= page;
    if (!page.messageParts) {
      if (pageIndex !== 0) throw new Error('Invalid Host messages continuation');
      return {
        messages: remapHostCrossTeamMessages(page.messages, page.teamName, key, bindings),
        nextCursor: page.nextCursor,
        hasMore: page.hasMore,
        feedRevision: page.revision,
      };
    }
    if (page.messageParts.length !== page.messages.length || page.messageTotal === undefined)
      throw new Error('Invalid Host message parts');
    for (const [position, fragment] of page.messages.entries()) {
      const marker = page.messageParts[position];
      if (!marker || marker.index >= page.messageTotal || marker.part >= marker.total ||
          marker.part < 0 || marker.total < 1)
        throw new Error('Invalid Host message part');
      let group = groups.get(marker.index);
      if (!group) {
        group = { total: marker.total, values: new Map() };
        groups.set(marker.index, group);
      }
      if (group.total !== marker.total || group.values.has(marker.part))
        throw new Error('Duplicate Host message part');
      group.values.set(marker.part, fragment);
    }
    if (complete(groups)) {
      readFence();
      return {
        messages: remapHostCrossTeamMessages(assemble(groups), page.teamName, key, bindings),
        nextCursor: page.nextCursor,
        hasMore: page.hasMore,
        feedRevision: page.revision,
      };
    }
    if (!page.nextCursor || seen.has(page.nextCursor))
      throw new Error('Missing or repeated Host message continuation');
    seen.add(page.nextCursor);
    cursor = page.nextCursor;
  }
  throw new Error('Host message page exceeded continuation budget');
}
