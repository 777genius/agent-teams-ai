import type {
  InternalStorageWorkerOp,
  InternalStorageWorkerRequest,
} from './internalStorageWorkerProtocol';

const DIRECT_INVALIDATORS = new Set<InternalStorageWorkerOp>([
  'hostedLifecycleCurrent.setAuthority',
  'hostedLifecycleCurrent.retireAuthority',
  'hostedLifecycleCurrent.activateRun',
  'hostedLifecycleCurrent.retireRun',
  'hostedLifecycleCurrent.confirmRunRetired',
  'hostedLifecycleCurrent.retireMember',
  'teamIdentity.tombstone',
  'draftPublication.settle',
]);
const AUTH_INVALIDATORS = new Set([
  'authority.compareAndSwap',
  'configuration.resetMode',
  'session.revoke',
  'session.touch',
  'backchannel.apply',
  'user.setStatus',
  'workspace.disable',
  'workspace.grant.set',
  'workspace.grant.revoke',
]);

/** Operations whose committed result can change the current member decision. */
export function isProductAuthorityInvalidator(
  op: InternalStorageWorkerOp,
  payload: InternalStorageWorkerRequest['payload']
): boolean {
  if (DIRECT_INVALIDATORS.has(op)) return true;
  if (op !== 'hostedAuth.call') return false;
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return false;
  const operation = (payload as { operation?: unknown }).operation;
  return typeof operation === 'string' && AUTH_INVALIDATORS.has(operation);
}
