import {
  getTeamDataWorkerErrorMessage,
  noteHeavyTeamDataWorkerFallback,
  throwIfFatalTeamDataWorkerFailure,
} from '../services/teamDataWorkerPolicy';

import type {
  LiveLeadMessageReaderPort,
  MainOperationTrackerPort,
  MessageMergePort,
  MissingTeamStateReaderPort,
  NewestMessagesPageReaderPort,
  RuntimeEnvironmentPort,
  TeamEngagementPort,
  TeamMessageNotificationScannerPort,
  TeamProcessHealthPort,
  TeamRuntimeReadPort,
  TeamSnapshotReaderPort,
  TeamSnapshotWorkerReadPort,
  TeamTaskActivityRepairPort,
  TeamViewClockPort,
  TeamViewReadLoggerPort,
  TeamViewReadResult,
} from '../ports/TeamViewReadModelPorts';
import type { InboxMessage, TeamGetDataOptions, TeamViewSnapshot } from '@shared/types';

export class GetTeamViewUseCase {
  constructor(
    private readonly dependencies: {
      snapshots: TeamSnapshotReaderPort;
      processHealth: TeamProcessHealthPort;
      worker: TeamSnapshotWorkerReadPort;
      missingTeams: MissingTeamStateReaderPort;
      taskActivity: TeamTaskActivityRepairPort;
      runtime: TeamRuntimeReadPort;
      liveMessages: LiveLeadMessageReaderPort;
      notifications: TeamMessageNotificationScannerPort;
      merger: MessageMergePort;
      newestMessages: NewestMessagesPageReaderPort;
      engagement: TeamEngagementPort;
      operations: MainOperationTrackerPort;
      clock: TeamViewClockPort;
      environment: RuntimeEnvironmentPort;
      logger: TeamViewReadLoggerPort;
    }
  ) {}

  async execute(teamName: string, options?: TeamGetDataOptions): Promise<TeamViewReadResult> {
    this.dependencies.engagement.markEngaged(teamName);
    const startedAt = this.dependencies.clock.now();
    let data: TeamViewSnapshot;
    let dataSource: 'worker' | 'main-fallback' | 'main-unavailable' = 'main-unavailable';
    let workerAvailable = false;
    const readFromMain = (): Promise<TeamViewSnapshot> =>
      options === undefined
        ? this.dependencies.snapshots.getTeamData(teamName)
        : this.dependencies.snapshots.getTeamData(teamName, options);

    this.dependencies.operations.setCurrent('team:getData');
    try {
      workerAvailable = this.dependencies.worker.isAvailable();
      const missingState = await this.dependencies.missingTeams.classifyBeforeRead(teamName);
      if (missingState === 'provisioning') {
        return { kind: 'failure', error: 'TEAM_PROVISIONING' };
      }
      if (missingState === 'draft') {
        return { kind: 'failure', error: 'TEAM_DRAFT' };
      }

      await this.dependencies.taskActivity.repairStaleTaskActivityIntervalsBeforeSnapshot(teamName);

      if (workerAvailable) {
        try {
          data =
            options === undefined
              ? await this.dependencies.worker.getTeamData(teamName)
              : await this.dependencies.worker.getTeamData(teamName, options);
          dataSource = 'worker';
        } catch (error) {
          throwIfFatalTeamDataWorkerFailure(this.dependencies.worker, error);
          this.dependencies.logger.warn(
            `[teams:getData] worker failed, falling back: ${getTeamDataWorkerErrorMessage(error)}`
          );
          noteHeavyTeamDataWorkerFallback(
            this.dependencies.environment,
            this.dependencies.logger,
            'teams:getData'
          );
          data = await readFromMain();
          dataSource = 'main-fallback';
        }
      } else {
        noteHeavyTeamDataWorkerFallback(
          this.dependencies.environment,
          this.dependencies.logger,
          'teams:getData'
        );
        data = await readFromMain();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message === `Team not found: ${teamName}`) {
        const missingState = await this.dependencies.missingTeams.classifyAfterNotFound(teamName);
        if (missingState === 'provisioning') {
          return { kind: 'failure', error: 'TEAM_PROVISIONING' };
        }
        if (missingState === 'draft') {
          return { kind: 'failure', error: 'TEAM_DRAFT' };
        }
      }
      this.dependencies.logger.error(`[teams:getData] ${message}`);
      return { kind: 'failure', error: message };
    } finally {
      this.dependencies.operations.setCurrent(null);
    }

    this.logSlowRead(teamName, options, startedAt, dataSource, workerAvailable);
    this.updateProcessHealth(teamName, data);
    return this.enrichRuntimeView(teamName, data);
  }

  private logSlowRead(
    teamName: string,
    options: TeamGetDataOptions | undefined,
    startedAt: number,
    dataSource: 'worker' | 'main-fallback' | 'main-unavailable',
    workerAvailable: boolean
  ): void {
    const elapsedMs = this.dependencies.clock.now() - startedAt;
    if (elapsedMs < 1500) {
      return;
    }
    const branchMode = options?.includeMemberBranches === false ? 'skipped' : 'full';
    this.dependencies.logger.warn(
      `[teams:getData] slow team=${teamName} ms=${elapsedMs} source=${dataSource} workerAvailable=${workerAvailable} branchMode=${branchMode}`
    );
  }

  private updateProcessHealth(teamName: string, data: TeamViewSnapshot): void {
    if (data.processes.some((process) => !process.stoppedAt)) {
      this.dependencies.processHealth.trackProcessHealthForTeam?.(teamName);
    } else {
      this.dependencies.processHealth.untrackProcessHealthForTeam?.(teamName);
    }
  }

  private async enrichRuntimeView(
    teamName: string,
    data: TeamViewSnapshot
  ): Promise<TeamViewReadResult> {
    const isAlive = this.dependencies.runtime.isTeamAlive(teamName);
    const currentLeadSessionId = this.dependencies.liveMessages.getCurrentLeadSessionId(teamName);
    const displayName = data.config.name || teamName;
    const projectPath = data.config.projectPath;
    const liveMessages = this.dependencies.liveMessages.getLiveLeadProcessMessages(teamName);
    const durableMessages = Array.isArray((data as { messages?: unknown }).messages)
      ? ((data as { messages?: InboxMessage[] }).messages ?? [])
      : [];

    if (liveMessages.length === 0) {
      if (durableMessages.length > 0) {
        this.dependencies.notifications.checkRateLimitMessages(durableMessages, {
          teamName,
          teamDisplayName: displayName,
          projectPath,
          teamIsAlive: isAlive,
          currentLeadSessionId,
        });
        this.dependencies.notifications.checkApiErrorMessages(durableMessages, {
          teamName,
          teamDisplayName: displayName,
          projectPath,
        });
      } else {
        this.dependencies.notifications.scan(liveMessages, {
          teamName,
          teamDisplayName: displayName,
          projectPath,
        });
      }
      return { kind: 'success', data: { ...data, isAlive } };
    }

    let merged = this.dependencies.merger.mergeMessages(durableMessages, liveMessages);
    if (durableMessages.length >= 50) {
      try {
        const newestPage = await this.dependencies.newestMessages.execute({
          teamName,
          limit: 50,
          liveMessages,
        });
        merged = newestPage.messages;
      } catch (error) {
        this.dependencies.logger.warn(
          `[teams:getData] failed to rebuild newest merged messages for ${teamName}: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }

    this.dependencies.notifications.checkRateLimitMessages(merged, {
      teamName,
      teamDisplayName: displayName,
      projectPath,
      teamIsAlive: isAlive,
      currentLeadSessionId,
    });
    this.dependencies.notifications.checkApiErrorMessages(merged, {
      teamName,
      teamDisplayName: displayName,
      projectPath,
    });
    return { kind: 'success', data: { ...data, isAlive } };
  }
}
