import { setCurrentMainOp } from '@main/services/infrastructure/EventLoopLagMonitor';
import { markTeamEngaged } from '@main/services/infrastructure/teamWatchScope';
import {
  mergeLiveLeadProcessMessages,
  mergeLiveLeadProcessMessagesPage,
} from '@main/services/team/mergeLiveLeadProcessMessages';

import { NewestMessagesPageReader } from '../../core/application/services/NewestMessagesPageReader';
import { GetMemberActivityMetaUseCase } from '../../core/application/use-cases/GetMemberActivityMetaUseCase';
import { GetMessagesPageUseCase } from '../../core/application/use-cases/GetMessagesPageUseCase';
import { GetTeamViewUseCase } from '../../core/application/use-cases/GetTeamViewUseCase';
import { FileSystemMissingTeamStateReader } from '../adapters/output/FileSystemMissingTeamStateReader';
import { TeamDataWorkerReadAdapter } from '../adapters/output/TeamDataWorkerReadAdapter';
import { teamMessageNotificationScanner } from '../adapters/output/teamMessageNotificationScanner';
import { electronRuntimeEnvironment } from '../infrastructure/ElectronRuntimeEnvironment';

import type {
  LiveLeadMessageReaderPort,
  MessageMergePort,
  MissingTeamStateReaderPort,
  RuntimeEnvironmentPort,
  TeamDataWorkerReadPort,
  TeamMemberActivityReaderPort,
  TeamMessageFeedReaderPort,
  TeamMessageNotificationScannerPort,
  TeamProcessHealthPort,
  TeamProvisioningRunReadPort,
  TeamRuntimeReadPort,
  TeamSnapshotReaderPort,
  TeamTaskActivityRepairPort,
  TeamViewReadLoggerPort,
} from '../../core/application/ports/TeamViewReadModelPorts';
import type { TeamViewReadModelFeature } from './TeamViewReadModelIpcBoundary';

export type { TeamViewReadModelFeature } from './TeamViewReadModelIpcBoundary';

export function createTeamViewReadModelFeature(dependencies: {
  data: TeamSnapshotReaderPort &
    TeamMessageFeedReaderPort &
    TeamMemberActivityReaderPort &
    TeamProcessHealthPort;
  provisioningRuns: TeamProvisioningRunReadPort;
  taskActivity: TeamTaskActivityRepairPort;
  runtime: TeamRuntimeReadPort;
  messaging: LiveLeadMessageReaderPort;
  logger: TeamViewReadLoggerPort;
  worker?: TeamDataWorkerReadPort;
  missingTeams?: MissingTeamStateReaderPort;
  notifications?: TeamMessageNotificationScannerPort;
  merger?: MessageMergePort;
  environment?: RuntimeEnvironmentPort;
}): TeamViewReadModelFeature {
  const worker = dependencies.worker ?? new TeamDataWorkerReadAdapter();
  const missingTeams =
    dependencies.missingTeams ??
    new FileSystemMissingTeamStateReader(dependencies.provisioningRuns);
  const notifications = dependencies.notifications ?? teamMessageNotificationScanner;
  const merger: MessageMergePort = dependencies.merger ?? {
    mergeMessages: mergeLiveLeadProcessMessages,
    mergePage: mergeLiveLeadProcessMessagesPage,
  };
  const environment: RuntimeEnvironmentPort =
    dependencies.environment ?? electronRuntimeEnvironment;
  const newestMessages = new NewestMessagesPageReader({
    worker,
    durableMessages: dependencies.data,
    merger,
    environment,
    logger: dependencies.logger,
  });
  const getTeamView = new GetTeamViewUseCase({
    snapshots: dependencies.data,
    processHealth: dependencies.data,
    worker,
    missingTeams,
    taskActivity: dependencies.taskActivity,
    runtime: dependencies.runtime,
    liveMessages: dependencies.messaging,
    notifications,
    merger,
    newestMessages,
    engagement: { markEngaged: markTeamEngaged },
    operations: { setCurrent: setCurrentMainOp },
    clock: { now: Date.now },
    environment,
    logger: dependencies.logger,
  });
  const getMessagesPage = new GetMessagesPageUseCase({
    messages: dependencies.data,
    worker,
    liveMessages: dependencies.messaging,
    newestMessages,
    notifications,
    environment,
    logger: dependencies.logger,
  });
  const getMemberActivityMeta = new GetMemberActivityMetaUseCase({
    activity: dependencies.data,
    worker,
    environment,
    logger: dependencies.logger,
  });

  return {
    getTeamView: {
      execute: (teamName, options) => getTeamView.execute(teamName, options),
    },
    getMessagesPage: {
      execute: (input) => getMessagesPage.execute(input),
    },
    getMemberActivityMeta: {
      execute: (teamName) => getMemberActivityMeta.execute(teamName),
    },
    logger: dependencies.logger,
  };
}
