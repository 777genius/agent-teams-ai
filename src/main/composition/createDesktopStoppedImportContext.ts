import { configureDesktopStoppedImportOwners } from '../ipc/agentBackend';

import type { ServiceContext } from '../services/infrastructure/ServiceContext';
import type { ServiceContextRegistry } from '../services/infrastructure/ServiceContextRegistry';
import type { MemberWorkSyncFeatureFacade } from '@features/member-work-sync/main';

type Owners = Parameters<typeof configureDesktopStoppedImportOwners>[0];
type ContextOwners = readonly [
  backup: Owners['backup'] | null,
  provisioning: Owners['provisioning'],
  data: Owners['data'],
  registry: Pick<ServiceContextRegistry, 'get' | 'getActive'>,
  workSync?: Pick<MemberWorkSyncFeatureFacade, 'withStoppedImportFence'> | null,
];

/** Owner snapshots revoke prior imports; current-context checks retain physical identity. */
export function createDesktopStoppedImportContext(read: () => ContextOwners) {
  return (context: ServiceContext): void => {
    const [backup, provisioning, data, , workSync] = read();
    if (!backup) return;
    const sourceBackup: Owners['backup'] = {
      withTeamIdentityFence: (name, operation) =>
        workSync
          ? workSync.withStoppedImportFence(name, () =>
              backup.withTeamIdentityFence(name, operation)
            )
          : backup.withTeamIdentityFence(name, operation),
    };
    configureDesktopStoppedImportOwners({ backup: sourceBackup, provisioning, data }, (id) => {
      const registry = read()[3];
      return (
        id === context.id && registry.get('local') === context && registry.getActive() === context
      );
    });
  };
}
