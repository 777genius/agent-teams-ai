import { assertBackendRequestGuard, BackendRoutingError, ownerKey } from '../application/backendBinding';
import { CapturedHostClient } from '../infrastructure/CapturedHostClient';
import { readMainWindowsCustodySource } from '../infrastructure/CapturedWindowsCustody';
import { loadDesktopBackendDescriptor } from '../infrastructure/loadDesktopBackendDescriptor';

import type { BackendHostRecoveryRequest, BackendHostRecoveryResult } from '../../contracts/operations';
import type { BackendRequestGuard } from '../application/backendBinding';
import type { BackendOwnerRouter, CapturedBackendOwner } from '../application/BackendOwnerRouter';
import type {
  DesktopBackendDescriptor,
  DesktopBackendDescriptorSelection,
} from '../infrastructure/loadDesktopBackendDescriptor';

interface CapturedHostRecoveryComposition {
  selection: DesktopBackendDescriptorSelection | null;
  descriptor(): DesktopBackendDescriptor | undefined;
  router(): BackendOwnerRouter | undefined;
  definitions(): readonly DesktopBackendDescriptor['handles'][number][];
  clients: Map<string, CapturedBackendOwner>;
  isCurrent(): boolean;
}

/** No initialization or automatic start: only the original explicit recovery conversation. */
export async function recoverCapturedHost(
  request: BackendHostRecoveryRequest,
  guard: BackendRequestGuard | undefined,
  options: CapturedHostRecoveryComposition
): Promise<BackendHostRecoveryResult> {
  assertBackendRequestGuard(guard);
  const selection = options.selection, descriptor = options.descriptor(), router = options.router();
  if (process.platform !== 'win32' || !guard || !selection || !descriptor || !router ||
    !options.isCurrent())
    throw new BackendRoutingError('unavailable');
  const matches = options.definitions().filter(row => row.handleId === request.handle.handleId);
  if (matches.length !== 1) throw new BackendRoutingError('hold');
  const definition = matches[0];
  const key = ownerKey(definition.owner), original = options.clients.get(key);
  if (!original?.nativeCustody) throw new BackendRoutingError('hold');
  const nativeCustody = original.nativeCustody, profile = original.client.profile;
  const capturedDefinition = JSON.stringify(definition);
  const capturedDescriptor = JSON.stringify(descriptor);
  const owner = descriptor.owners.find(row => ownerKey(row) === key);
  if (!owner || JSON.stringify(owner.profile) !== JSON.stringify(profile) ||
    owner.storageRoot !== original.storageRoot)
    throw new BackendRoutingError('hold');
  let selected = original;
  const isCurrent = (client: CapturedHostClient) => {
    const definitions = options.definitions().filter(row => row.handleId === request.handle.handleId);
    return options.isCurrent() && options.descriptor() === descriptor && options.router() === router &&
      options.clients.get(key) === selected && selected.client === client &&
      selected.nativeCustody === nativeCustody && definitions.length === 1 &&
      JSON.stringify(definitions[0]) === capturedDefinition;
  };
  return router.recover(request, {
    owner: definition.owner,
    scope: definition.scope,
    nativeCustody,
    isCurrent,
    async verify(assertCurrent) {
      assertCurrent();
      const fresh = await loadDesktopBackendDescriptor(selection);
      assertCurrent();
      if (JSON.stringify(fresh) !== capturedDescriptor || !readMainWindowsCustodySource(profile))
        throw new BackendRoutingError('hold');
      assertCurrent();
    },
    create: remaining => new CapturedHostClient(profile, nativeCustody, remaining),
    install(previous, candidate) {
      assertBackendRequestGuard(guard);
      if (!isCurrent(previous)) throw new BackendRoutingError('hold');
      const next = { ...selected, client: candidate };
      options.clients.set(key, next);
      selected = next;
    },
  }, guard);
}
