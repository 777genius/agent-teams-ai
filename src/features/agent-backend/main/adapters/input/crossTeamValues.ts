import { InvalidBackendOperation, object, text } from './validateBackendOperation';
import type { BackendCrossTeamSend, CrossTeamReference } from '../../../contracts/crossTeam';

/** Public opaque handles are data; Main captures both actual bindings before dispatch. */
export function parseCrossTeamSend(value: unknown): BackendCrossTeamSend {
  const p = object(value, [
    'target',
    'fromMember',
    'toMember',
    'text',
    'messageId',
    'conversationId',
    'replyToConversationId',
    'timestamp',
    'summary',
    'actionMode',
    'taskRefs',
    'chainDepth',
  ]);
  const target = object(p.target, ['handleId']);
  const result: BackendCrossTeamSend = {
    target: { handleId: text(target.handleId) },
    fromMember: text(p.fromMember, 128),
    text: text(p.text, 48_000),
    messageId: text(p.messageId),
  };
  for (const key of [
    'toMember',
    'conversationId',
    'replyToConversationId',
    'timestamp',
    'summary',
  ] as const)
    if (p[key] !== undefined) result[key] = text(p[key], key === 'summary' ? 4_000 : 256);
  if (p.actionMode !== undefined) {
    if (!['do', 'ask', 'delegate'].includes(String(p.actionMode)))
      throw new InvalidBackendOperation();
    result.actionMode = p.actionMode as NonNullable<BackendCrossTeamSend['actionMode']>;
  }
  if (p.chainDepth !== undefined) {
    if (!Number.isSafeInteger(p.chainDepth) || Number(p.chainDepth) < 0 || Number(p.chainDepth) > 4)
      throw new InvalidBackendOperation();
    result.chainDepth = Number(p.chainDepth);
  }
  if (p.taskRefs !== undefined) {
    if (!Array.isArray(p.taskRefs) || p.taskRefs.length > 100) throw new InvalidBackendOperation();
    result.taskRefs = p.taskRefs.map((value): CrossTeamReference => {
      const ref = object(value, ['taskId', 'displayId', 'team']);
      if (ref.team !== 'source' && ref.team !== 'target') throw new InvalidBackendOperation();
      return { taskId: text(ref.taskId), displayId: text(ref.displayId), team: ref.team };
    });
  }
  return result;
}
