import { InternalStorageOperationInterruptedError } from '@features/internal-storage/main';
import { getTeamsBasePath } from '@main/utils/pathDecoder';

import { configureDesktopStoppedImportOwners } from '../ipc/agentBackend';

import { captureDesktopRetainedLegacyRuntime } from './captureDesktopRetainedLegacyRuntime';
import { createLegacySourceWriteAdmissionPolicy } from './legacySourceWriteAdmission';

import type { ServiceContext } from '../services/infrastructure/ServiceContext';
import type { ServiceContextRegistry } from '../services/infrastructure/ServiceContextRegistry';
import type { RetainedLegacyRuntimeOwners } from './captureDesktopRetainedLegacyRuntime';
import type { LegacySourceWriteAdmissionPolicy } from '@agent-teams/legacy-agent-host/lifecycle';
import type { MemberWorkSyncFeatureFacade } from '@features/member-work-sync/main';

type Owners = Parameters<typeof configureDesktopStoppedImportOwners>[0];
type ContextOwners = readonly [
  backup: Owners['backup'] | null,
  provisioning: Owners['provisioning'] & RetainedLegacyRuntimeOwners['provisioning'],
  data: Owners['data'] & RetainedLegacyRuntimeOwners['data'],
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
    configureDesktopStoppedImportOwners(
      { backup: sourceBackup, provisioning, data },
      (id) => {
        const registry = read()[3];
        return (
          id === context.id && registry.get('local') === context && registry.getActive() === context
        );
      },
      (source, current, onProgress, projectPath) =>
        captureDesktopRetainedLegacyRuntime(
          source,
          current,
          { provisioning, data, onProgress },
          projectPath
        )
    );
  };
}

/** The ordinary Main producer has no Host descriptor, but its qualified native cut is still immutable. */
export function createDesktopWorkSyncSourceAdmission(
  backup: {
    sourceWriteAdmission?: LegacySourceWriteAdmissionPolicy;
    withTeamIdentityFence<T>(teamName: string, operation: () => Promise<T>): Promise<T>;
  },
  isCurrentOwner: () => boolean
): LegacySourceWriteAdmissionPolicy {
  if (backup.sourceWriteAdmission) return backup.sourceWriteAdmission;
  const teamsRoot = getTeamsBasePath();
  return createLegacySourceWriteAdmissionPolicy({
    teamsRoot,
    selectedHost: true,
    isCurrentOwner: () => isCurrentOwner() && getTeamsBasePath() === teamsRoot,
    withIdentityFence: (teamName, operation) => backup.withTeamIdentityFence(teamName, operation),
    settleInterrupted: async (error) => {
      if (error instanceof InternalStorageOperationInterruptedError)
        await Promise.allSettled([error.settled]);
    },
  });
}

/** The original live feature, rather than a same-name replacement, owns this Stop closure. */
export function captureDesktopNativeStopWorkSyncFence(
  read: () => Pick<MemberWorkSyncFeatureFacade, 'captureNativeStopFence'> | null,
  teamName: string
) {
  const original = read();
  if (!original) return null;
  const teamsRoot = getTeamsBasePath();
  const fence = original.captureNativeStopFence(teamName);
  const assertCurrent = () => {
    if (read() !== original || getTeamsBasePath() !== teamsRoot)
      throw new Error('Original native Stop WorkSync owner changed');
  };
  return Object.freeze({
    async drain() {
      assertCurrent();
      await fence.drain();
      assertCurrent();
    },
    assertDrained() {
      assertCurrent();
      fence.assertDrained();
    },
    release: () => fence.release(),
  });
}
