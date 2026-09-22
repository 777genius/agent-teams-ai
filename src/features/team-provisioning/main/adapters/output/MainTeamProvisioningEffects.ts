import { addMainBreadcrumb } from '@main/sentry';
import { markTeamEngaged } from '@main/services/infrastructure/teamWatchScope';
import { invalidateTeamRosterSnapshotCaches } from '@main/services/team/invalidateTeamRosterSnapshotCaches';

import type { TeamProvisioningEffectsPort } from '../../../core/application/ports/TeamProvisioningPorts';
import type { TeamRosterSnapshotCacheSource } from '@main/services/team/invalidateTeamRosterSnapshotCaches';
import type { LaunchIoGovernor } from '@main/services/team/LaunchIoGovernor';
import type { TeamProvisioningProgress } from '@shared/types';

export class MainTeamProvisioningEffects implements TeamProvisioningEffectsPort {
  constructor(
    private readonly cacheSource: TeamRosterSnapshotCacheSource,
    private readonly launchIoGovernor?: LaunchIoGovernor
  ) {}

  addBreadcrumb(operation: 'create' | 'launch', teamName: string): void {
    addMainBreadcrumb('team', operation, { teamName });
  }

  noteLaunchIntent(teamName: string, source: 'create' | 'draft-launch' | 'launch'): void {
    this.launchIoGovernor?.noteLaunchIntent(teamName, source);
  }

  markTeamEngaged(teamName: string): void {
    markTeamEngaged(teamName);
  }

  noteProgress(progress: TeamProvisioningProgress): void {
    this.launchIoGovernor?.noteProvisioningProgress(progress);
  }

  noteFailureBeforeProgress(teamName: string, source: string): void {
    if (!this.launchIoGovernor) return;
    const now = new Date().toISOString();
    this.launchIoGovernor.noteProvisioningProgress({
      runId: `${source}:failed-before-progress`,
      teamName,
      state: 'failed',
      message: 'Launch failed before provisioning progress',
      startedAt: now,
      updatedAt: now,
    });
  }

  invalidateRosterSnapshots(teamName: string): void {
    invalidateTeamRosterSnapshotCaches(teamName, this.cacheSource);
  }
}
