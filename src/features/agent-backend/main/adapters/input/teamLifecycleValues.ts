import { InvalidBackendOperation, object, text } from './validateBackendOperation';
function change(value: unknown) {
  const row = object(value, ['expectedRevision', 'action']),
    revision = text(row.expectedRevision);
  if (!/^[a-f0-9]{64}$/.test(revision) || !['trash', 'restore'].includes(row.action as string))
    throw new InvalidBackendOperation();
  return { expectedRevision: revision, action: row.action as 'trash' | 'restore' };
}
function discard(value: unknown) {
  const row = object(value, ['member', 'messageIds']);
  if (!Array.isArray(row.messageIds) || row.messageIds.length > 4096)
    throw new InvalidBackendOperation();
  const messageIds = row.messageIds.map((value) => text(value));
  if (new Set(messageIds).size !== messageIds.length) throw new InvalidBackendOperation();
  return { member: text(row.member), messageIds };
}
function purge(value: unknown) {
  const source = object(value, ['expectedRevision']),
    expectedRevision = text(source.expectedRevision);
  if (!/^[a-f0-9]{64}$/.test(expectedRevision)) throw new InvalidBackendOperation();
  return { expectedRevision };
}
export function parseTeamLifecyclePayload(operation: string, value: unknown) {
  switch (operation) {
    case 'team.lifecycle.read':
      object(value, []);
      return {};
    case 'team.lifecycle.change':
      return change(value);
    case 'team.lifecycle.lookup':
      return { expected: change(object(value, ['expected']).expected) };
    case 'team.lifecycle.purge':
      return purge(value);
    case 'team.lifecycle.purge.lookup':
      return { expected: purge(object(value, ['expected']).expected) };
    case 'team.queue.read':
      return { member: text(object(value, ['member']).member) };
    case 'team.queue.discard':
      return discard(value);
    case 'team.queue.lookup':
      return { expected: discard(object(value, ['expected']).expected) };
    default:
      throw new InvalidBackendOperation();
  }
}
