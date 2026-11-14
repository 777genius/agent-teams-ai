import { projectTeamConversation } from './projectTeamChanges';
import { projectTeamMessage } from './projectTeamSnapshot';

import type { BackendTeamMessagesPage } from '../../../contracts/teamSnapshot';

/** Allowlist projection of the existing Owner's bounded, grant-bound read. */
export function projectTeamMessagesPage(value: unknown): BackendTeamMessagesPage {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid Host messages page');
  const source = value as Record<string, unknown>;
  if (Buffer.byteLength(JSON.stringify(source)) > 384 * 1024)
    throw new Error('Oversized Host messages page');
  if (typeof source.teamName !== 'string' || !source.teamName || source.teamName.includes('\0'))
    throw new Error('Invalid Host messages page team');
  if (typeof source.revision !== 'string' || !/^[a-f0-9]{64}$/.test(source.revision))
    throw new Error('Invalid Host messages revision');
  if (!Array.isArray(source.messages) || source.messages.length > 100)
    throw new Error('Invalid Host messages page rows');
  if (typeof source.hasMore !== 'boolean')
    throw new Error('Invalid Host messages pagination');
  if (
    source.nextCursor !== null &&
    (typeof source.nextCursor !== 'string' ||
      !/^[1-9][0-9]{0,8}\.[a-f0-9]{64}$/.test(source.nextCursor))
  )
    throw new Error('Invalid Host messages cursor');
  if (source.hasMore !== (source.nextCursor !== null))
    throw new Error('Inconsistent Host messages page');
  const parts = source.messageParts;
  if (parts !== undefined) {
    if (!Array.isArray(parts) || parts.length !== source.messages.length ||
        !Number.isSafeInteger(source.messageTotal) || (source.messageTotal as number) < 1 ||
        (source.messageTotal as number) > 10_000_000)
      throw new Error('Invalid Host message fragments');
    for (const marker of parts) {
      if (!marker || typeof marker !== 'object' ||
          !Number.isSafeInteger(marker.index) || marker.index < 0 ||
          marker.index >= (source.messageTotal as number) ||
          !Number.isSafeInteger(marker.part) || marker.part < 0 ||
          !Number.isSafeInteger(marker.total) || marker.total < 1 ||
          marker.part >= marker.total)
        throw new Error('Invalid Host message fragment');
    }
  } else if (source.messageTotal !== undefined) {
    throw new Error('Invalid Host message total');
  }
  return {
    teamName: source.teamName,
    revision: source.revision,
    messages: source.messages.map(projectTeamMessage),
    nextCursor: source.nextCursor,
    hasMore: source.hasMore,
    ...(source.conversation === undefined ? {} : {
      conversation: projectTeamConversation(source.conversation),
    }),
    ...(parts === undefined ? {} : {
      messageTotal: source.messageTotal as number,
      messageParts: parts as { index: number; part: number; total: number }[],
    }),
  };
}
