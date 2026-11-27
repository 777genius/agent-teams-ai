import {
  assertBackendRequestGuard,
  BackendRoutingError,
  ownerKey,
} from '../application/backendBinding';

import { readCapturedTeamRetirements } from './readCapturedTeamRetirements';
import { HostClientError } from './selectedHostProfile';

import type { BackendConnectionSnapshot } from '../../contracts/connections';
import type { BackendOwnerRef, BackendRequestGuard } from '../application/backendBinding';
import type { BackendOwnerRouter, CapturedBackendOwner } from '../application/BackendOwnerRouter';
import type { DesktopBackendDescriptor } from './loadDesktopBackendDescriptor';

export type CapturedConnectionUnavailable = NonNullable<
  BackendConnectionSnapshot['unavailableOwners']
>[number];

/** Classifies only the original captured read; registration and publication stay outside this catch. */
export async function readCapturedOwnerAvailability<T>(options: {
  router: BackendOwnerRouter;
  owner: BackendOwnerRef;
  assertCurrent(): void;
  read(): Promise<T>;
}): Promise<{ value: T } | { unavailable: CapturedConnectionUnavailable }> {
  const { router, owner, assertCurrent, read } = options;
  assertCurrent();
  const ownerResourceRef = router.ownerDisplayRef(owner);
  try {
    const value = await read();
    assertCurrent();
    return { value };
  } catch (error) {
    assertCurrent();
    if (
      error instanceof HostClientError &&
      (error.code === 'transport-closed' || error.code === 'shutting-down')
    ) {
      return {
        unavailable: {
          kind: 'owner',
          ownerResourceRef,
          code: error.code === 'transport-closed' ? 'unavailable' : 'shutting-down',
          outcome: error.outcome,
        },
      };
    }
    if (error instanceof BackendRoutingError && error.code === 'unavailable') {
      // A registered active owner is not an outage. Unknown/sealed-global states remain fatal.
      if (router.ownerDisplayRef(owner, true) !== ownerResourceRef)
        throw new BackendRoutingError('hold');
      assertCurrent();
      return {
        unavailable: {
          kind: 'owner',
          ownerResourceRef,
          code: 'unavailable',
          outcome: error.outcome,
        },
      };
    }
    throw error;
  }
}

/** One serial retirement read per original owner, retaining failed owners' existing tombstones. */
export async function readCapturedConnectionAvailability(options: {
  contextId: string;
  router: BackendOwnerRouter;
  clients: ReadonlyMap<string, CapturedBackendOwner>;
  entries: readonly DesktopBackendDescriptor['handles'][number][];
  assertCurrent(): void;
  guard?: BackendRequestGuard;
}): Promise<{
  replaced: Set<string>;
  retired: Set<string>;
  unavailable: CapturedConnectionUnavailable[];
}> {
  const { contextId, router, clients, entries, assertCurrent, guard } = options;
  const owners = new Map(entries.map((entry) => [ownerKey(entry.owner), entry.owner]));
  const replaced = new Set<string>(),
    retired = new Set<string>();
  const unavailable: CapturedConnectionUnavailable[] = [];
  for (const [key, owner] of owners) {
    assertCurrent();
    const captured = clients.get(key);
    if (!captured) throw new BackendRoutingError('hold');
    const result = await readCapturedOwnerAvailability({
      router,
      owner,
      assertCurrent,
      read: () =>
        readCapturedTeamRetirements({
          owner: router.ownerBinding(owner),
          contextId,
          client: captured.client,
          start: () => router.startOwner(owner),
          available: () => {
            assertCurrent();
            return true;
          },
          ...(guard ? { guard } : {}),
        }),
    });
    if ('unavailable' in result) {
      unavailable.push(result.unavailable);
      continue;
    }
    replaced.add(key);
    for (const entry of entries)
      if (ownerKey(entry.owner) === key && result.value.includes(entry.scope.teamId))
        retired.add(entry.handleId);
  }
  assertBackendRequestGuard(guard);
  assertCurrent();
  return { replaced, retired, unavailable };
}
