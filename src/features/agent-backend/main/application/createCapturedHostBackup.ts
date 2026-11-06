import { randomUUID } from 'node:crypto';

import { assertBackendRequestGuard, BackendRoutingError } from './backendBinding';

import type { BackendHandle } from '../../contracts';
import type { BackendRequestGuard } from './backendBinding';
import type { BackendOwnerRouter } from './BackendOwnerRouter';

/** One scheduler invocation captures exact original owners/handles before its first async request. */
export function createCapturedHostBackup(options: {
  handles: readonly BackendHandle[];
  router: Pick<BackendOwnerRouter, 'request'>;
  guard: BackendRequestGuard;
}) {
  const targets = options.handles.map((handle) => ({ ...handle }));
  return {
    async run(mode: 'reconcile' | 'snapshot'): Promise<void> {
      assertBackendRequestGuard(options.guard);
      for (const handle of targets) {
        assertBackendRequestGuard(options.guard);
        const raw = await options.router.request(handle, {
          commandId: randomUUID(),
          method: `team.backup.${mode}`,
          payload: {},
          guard: options.guard,
        });
        assertBackendRequestGuard(options.guard);
        if (
          !raw ||
          typeof raw !== 'object' ||
          Array.isArray(raw) ||
          raw.ok !== true ||
          !raw.value ||
          typeof raw.value !== 'object' ||
          Array.isArray(raw.value)
        )
          throw new BackendRoutingError('hold');
        const value = raw.value;
        if (
          Object.keys(value).some((key) => !['copied', 'restored', 'heldCount'].includes(key)) ||
          !['copied', 'restored', 'heldCount'].every(
            (key) =>
              typeof value[key] === 'number' && Number.isSafeInteger(value[key]) && value[key] >= 0
          )
        )
          throw new BackendRoutingError('hold');
        // A retained resource gap is an incomplete backup, never a silent successful substitute.
        if (value.heldCount !== 0) throw new BackendRoutingError('hold');
      }
    },
  };
}
