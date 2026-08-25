import {
  getTeamDataWorkerErrorMessage,
  noteHeavyTeamDataWorkerFallback,
  throwIfFatalTeamDataWorkerFailure,
} from '../services/teamDataWorkerPolicy';

import type { TeamMemberActivityMeta } from '../models/TeamViewReadModels';
import type {
  RuntimeEnvironmentPort,
  TeamMemberActivityReaderPort,
  TeamMemberActivityWorkerReadPort,
  TeamViewReadLoggerPort,
} from '../ports/TeamViewReadModelPorts';

export class GetMemberActivityMetaUseCase {
  constructor(
    private readonly dependencies: {
      activity: TeamMemberActivityReaderPort;
      worker: TeamMemberActivityWorkerReadPort;
      environment: RuntimeEnvironmentPort;
      logger: TeamViewReadLoggerPort;
    }
  ) {}

  async execute(teamName: string): Promise<TeamMemberActivityMeta> {
    if (this.dependencies.worker.isAvailable()) {
      try {
        return await this.dependencies.worker.getMemberActivityMeta(teamName);
      } catch (error) {
        throwIfFatalTeamDataWorkerFailure(this.dependencies.worker, error);
        this.dependencies.logger.warn(
          `[teams:getMemberActivityMeta] worker failed, falling back: ${getTeamDataWorkerErrorMessage(
            error
          )}`
        );
      }
    }

    noteHeavyTeamDataWorkerFallback(
      this.dependencies.environment,
      this.dependencies.logger,
      'teams:getMemberActivityMeta'
    );
    return this.dependencies.activity.getMemberActivityMeta(teamName);
  }
}
