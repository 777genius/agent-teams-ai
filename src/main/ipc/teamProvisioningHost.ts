import * as fs from 'node:fs';
import * as path from 'node:path';

import { createTeamProvisioningFeature } from '@features/team-provisioning/main';
import { addMainBreadcrumb } from '@main/sentry';
import { markTeamEngaged } from '@main/services/infrastructure/teamWatchScope';
import { invalidateTeamRosterSnapshotCaches } from '@main/services/team/invalidateTeamRosterSnapshotCaches';
import { readTeamLaunchFailureDiagnosticsBundle } from '@main/services/team/TeamLaunchFailureArtifactPack';
import { TeamMetaStore } from '@main/services/team/TeamMetaStore';
import { getTeamsBasePath } from '@main/utils/pathDecoder';

import type { LaunchIoGovernor } from '@main/services/team/LaunchIoGovernor';
import type { TeamProvisioningProgress } from '@shared/types';

type PureTeamProvisioningDependencies = Parameters<typeof createTeamProvisioningFeature>[0];

export type DesktopTeamProvisioningFeatureDependencies = Omit<
  PureTeamProvisioningDependencies,
  'diagnostics' | 'effects' | 'workspace'
> & {
  launchIoGovernor?: LaunchIoGovernor;
  diagnostics?: PureTeamProvisioningDependencies['diagnostics'];
};

export function createDesktopTeamProvisioningFeature(
  dependencies: DesktopTeamProvisioningFeatureDependencies
): ReturnType<typeof createTeamProvisioningFeature> {
  const metadata = new TeamMetaStore();
  const workspace: PureTeamProvisioningDependencies['workspace'] = {
    async ensureDirectory(directoryPath): Promise<boolean> {
      try {
        await fs.promises.mkdir(directoryPath, { recursive: true });
        return true;
      } catch {
        return false;
      }
    },
    async getDirectoryStatus(directoryPath): Promise<'directory' | 'not-directory' | 'missing'> {
      try {
        const stat = await fs.promises.stat(directoryPath);
        return stat.isDirectory() ? 'directory' : 'not-directory';
      } catch {
        return 'missing';
      }
    },
    isAbsolute: path.isAbsolute,
    async hasTeamConfig(teamName): Promise<boolean> {
      try {
        await fs.promises.access(
          path.join(getTeamsBasePath(), teamName, 'config.json'),
          fs.constants.F_OK
        );
        return true;
      } catch {
        return false;
      }
    },
    getMetadata: (teamName) => metadata.getMeta(teamName),
  };
  const effects: PureTeamProvisioningDependencies['effects'] = {
    addBreadcrumb: (operation, teamName) => addMainBreadcrumb('team', operation, { teamName }),
    noteLaunchIntent: (teamName, source) =>
      dependencies.launchIoGovernor?.noteLaunchIntent(teamName, source),
    markTeamEngaged,
    noteProgress: (progress: TeamProvisioningProgress) =>
      dependencies.launchIoGovernor?.noteProvisioningProgress(progress),
    noteFailureBeforeProgress(teamName, source): void {
      if (!dependencies.launchIoGovernor) return;
      const now = new Date().toISOString();
      dependencies.launchIoGovernor.noteProvisioningProgress({
        runId: `${source}:failed-before-progress`,
        teamName,
        state: 'failed',
        message: 'Launch failed before provisioning progress',
        startedAt: now,
        updatedAt: now,
      });
    },
    invalidateRosterSnapshots: (teamName) =>
      invalidateTeamRosterSnapshotCaches(teamName, dependencies.repository),
  };
  const diagnostics = dependencies.diagnostics ?? {
    read: readTeamLaunchFailureDiagnosticsBundle,
  };
  const { launchIoGovernor: _launchIoGovernor, ...pureDependencies } = dependencies;
  return createTeamProvisioningFeature({
    ...pureDependencies,
    diagnostics,
    effects,
    workspace,
  });
}
