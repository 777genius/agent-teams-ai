import { InvalidBackendOperation, text } from '../input/validateBackendOperation';

import type {
  BackendCrossTeamLookup,
  BackendCrossTeamOutbox,
  BackendCrossTeamOutboxRow,
  BackendCrossTeamReceipt,
  BackendCrossTeamSend,
  CrossTeamReference,
} from '../../../contracts/crossTeam';

function row(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new InvalidBackendOperation();
  return value as Record<string, unknown>;
}
function choice<T extends string>(value: unknown, values: readonly T[]): T {
  if (typeof value !== 'string' || !values.includes(value as T))
    throw new InvalidBackendOperation();
  return value as T;
}
function optional(source: Record<string, unknown>, keys: readonly string[]) {
  return Object.fromEntries(
    keys.filter((key) => source[key] !== undefined).map((key) => [key, text(source[key])])
  );
}
function refs(value: unknown): CrossTeamReference[] {
  if (!Array.isArray(value) || value.length > 100) throw new InvalidBackendOperation();
  return value.map((value) => {
    const ref = row(value);
    return {
      taskId: text(ref.taskId),
      displayId: text(ref.displayId),
      team: choice(ref.team, ['source', 'target'] as const),
    };
  });
}
function outboxRow(value: unknown): BackendCrossTeamOutboxRow {
  const r = row(value);
  if (!Number.isSafeInteger(r.chainDepth) || Number(r.chainDepth) < 0 || Number(r.chainDepth) > 4)
    throw new InvalidBackendOperation();
  return {
    messageId: text(r.messageId),
    fromTeamResourceRef: text(r.fromTeamResourceRef),
    toTeamResourceRef: text(r.toTeamResourceRef),
    fromTeamName: text(r.fromTeamName),
    toTeamName: text(r.toTeamName),
    fromMember: text(r.fromMember),
    toMember: text(r.toMember),
    conversationId: text(r.conversationId),
    text: text(r.text, 48_000),
    timestamp: text(r.timestamp),
    chainDepth: Number(r.chainDepth),
    ...optional(r, ['fromHandleId', 'toHandleId', 'replyToConversationId']),
    ...(r.summary === undefined ? {} : { summary: text(r.summary, 4_000) }),
    ...(r.taskRefs === undefined ? {} : { taskRefs: refs(r.taskRefs) }),
  };
}
/** Explicit public projection never returns original principal, grants, private bindings or paths. */
export function projectCrossTeamResult(
  operation: 'crossTeam.send' | 'crossTeam.lookup' | 'crossTeam.outbox.read',
  value: unknown,
  commandId: string,
  request?: BackendCrossTeamSend
): BackendCrossTeamReceipt | BackendCrossTeamLookup | BackendCrossTeamOutbox {
  const r = row(value);
  if (operation === 'crossTeam.outbox.read') {
    if (r.kind !== 'cross-team-outbox' || !Array.isArray(r.rows) || r.rows.length > 1000)
      throw new InvalidBackendOperation();
    return { kind: 'cross-team-outbox', rows: r.rows.map(outboxRow) };
  }
  if (r.commandId !== commandId) throw new InvalidBackendOperation();
  if (operation === 'crossTeam.lookup') {
    if (r.kind !== 'cross-team-lookup') throw new InvalidBackendOperation();
    const phase = choice(r.phase, ['absent', 'prepared', 'completed', 'held'] as const);
    return phase === 'absent'
      ? { kind: 'cross-team-lookup', commandId, phase }
      : {
          kind: 'cross-team-lookup',
          commandId,
          phase,
          messageId: text(r.messageId),
          conversationId: text(r.conversationId),
          toMember: text(r.toMember),
        };
  }
  if (
    r.kind !== 'cross-team-receipt' ||
    r.messageId !== commandId ||
    typeof r.deduplicated !== 'boolean' ||
    (request?.conversationId !== undefined && request.conversationId !== r.conversationId)
  )
    throw new InvalidBackendOperation();
  return {
    kind: 'cross-team-receipt',
    commandId,
    messageId: commandId,
    conversationId: text(r.conversationId),
    toMember: text(r.toMember),
    phase: choice(r.phase, ['completed', 'held'] as const),
    deduplicated: r.deduplicated,
  };
}
