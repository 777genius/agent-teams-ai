import type {
  BackendQueuedDiscardReceipt,
  BackendTeamLifecycle,
  BackendTeamLifecycleValue,
} from '../../../contracts/teamLifecycle';
function row(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    throw new Error('Invalid lifecycle result');
  return value as Record<string, unknown>;
}
function text(value: unknown, max = 256): string {
  if (typeof value !== 'string' || value.length > max || value.includes('\0'))
    throw new Error('Invalid lifecycle text');
  return value;
}
function id(value: unknown): string {
  const result = text(value);
  if (!result) throw new Error('Missing lifecycle identity');
  return result;
}
function number(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new Error('Invalid queue count');
  return value;
}
function lifecycle(value: Record<string, unknown>): BackendTeamLifecycle {
  const revision = id(value.revision);
  if (
    value.kind !== 'team_lifecycle' ||
    !/^[a-f0-9]{64}$/.test(revision) ||
    typeof value.cleanupPending !== 'boolean'
  )
    throw new Error('Invalid lifecycle state');
  const pending =
    value.pendingPurge === undefined
      ? undefined
      : row(value.pendingPurge, ['commandId', 'expectedRevision']);
  const pendingPurge = pending
    ? { commandId: id(pending.commandId), expectedRevision: id(pending.expectedRevision) }
    : undefined;
  if (pendingPurge && !/^[a-f0-9]{64}$/.test(pendingPurge.expectedRevision))
    throw new Error('Invalid prepared deletion CAS');
  return {
    kind: 'team_lifecycle',
    revision,
    deletedAt: value.deletedAt === null ? null : id(value.deletedAt),
    cleanupPending: value.cleanupPending,
    ...(pendingPurge ? { pendingPurge } : {}),
  };
}
export function projectTeamLifecycle(
  value: unknown,
  operation: string,
  commandId: string
): BackendTeamLifecycleValue | null {
  if (value === null && operation.endsWith('.lookup')) return null;
  if (operation === 'team.lifecycle.read')
    return lifecycle(
      row(value, ['kind', 'revision', 'deletedAt', 'cleanupPending', 'pendingPurge'])
    );
  if (operation === 'team.lifecycle.purge' || operation === 'team.lifecycle.purge.lookup') {
    const source = row(value, ['kind', 'commandId', 'transactionId', 'phase']);
    const transactionId = id(source.transactionId);
    if (
      source.kind !== 'team_purge' ||
      id(source.commandId) !== commandId ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        transactionId
      ) ||
      (source.phase !== 'prepared' && source.phase !== 'deleting' && source.phase !== 'deleted')
    )
      throw new Error('Invalid original purge receipt');
    return { kind: 'team_purge', commandId, transactionId, phase: source.phase };
  }
  if (operation === 'team.queue.read') {
    const source = row(value, ['kind', 'member', 'messages']);
    if (
      source.kind !== 'queued_user_messages' ||
      !Array.isArray(source.messages) ||
      source.messages.length > 4096
    )
      throw new Error('Invalid queue snapshot');
    return {
      kind: 'queued_user_messages',
      member: id(source.member),
      messages: source.messages.map((raw) => {
        const message = row(raw, ['messageId', 'text', 'timestamp', 'summary']);
        return {
          messageId: id(message.messageId),
          text: text(message.text, 256 * 1024),
          timestamp: text(message.timestamp, 128),
          ...(message.summary === undefined ? {} : { summary: text(message.summary, 256 * 1024) }),
        };
      }),
    };
  }
  const source = row(
    value,
    operation.startsWith('team.lifecycle.')
      ? ['kind', 'revision', 'deletedAt', 'cleanupPending', 'commandId']
      : ['kind', 'commandId', 'phase', 'discarded', 'remainingQueued']
  );
  if (id(source.commandId) !== commandId) throw new Error('Wrong original lifecycle receipt');
  if (operation === 'team.lifecycle.change' || operation === 'team.lifecycle.lookup')
    return { ...lifecycle(source), commandId };
  if (
    source.kind !== 'queued_discard' ||
    !['team.queue.discard', 'team.queue.lookup'].includes(operation)
  )
    throw new Error('Invalid queue receipt');
  if (
    source.phase === 'prepared' &&
    source.discarded === undefined &&
    source.remainingQueued === undefined
  )
    return { kind: 'queued_discard', commandId, phase: 'prepared' };
  if (source.phase !== 'completed') throw new Error('Invalid queue phase');
  const result: BackendQueuedDiscardReceipt = {
    kind: 'queued_discard',
    commandId,
    phase: 'completed',
    discarded: number(source.discarded),
    remainingQueued: number(source.remainingQueued),
  };
  if (result.discarded > 4096) throw new Error('Invalid discarded count');
  return result;
}

/** Raw owner snapshot has one derived deleted flag; it must agree with the canonical tombstone. */
export function projectTeamLifecycleSnapshot(value: unknown): BackendTeamLifecycle {
  const source = row(value, ['revision', 'deletedAt', 'deleted', 'cleanupPending']);
  const projected = lifecycle({
    kind: 'team_lifecycle',
    revision: source.revision,
    deletedAt: source.deletedAt,
    cleanupPending: source.cleanupPending,
  });
  if (source.deleted !== (projected.deletedAt !== null))
    throw new Error('Conflicting lifecycle snapshot');
  return projected;
}
