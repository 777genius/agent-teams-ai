import {
  createDesktopTeamFeatureComposition,
  removeDesktopTeamFeatureComposition,
} from '@main/ipc/teamFeatureComposition';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const events: string[] = [];
  const feature = (name: string) => ({ name });
  const features = {
    approvals: {
      commands: feature('approval-commands'),
      previewReader: feature('approval-preview-reader'),
    },
    configuration: feature('configuration'),
    messageDelivery: feature('message-delivery'),
    provisioning: feature('provisioning'),
    rosterMutation: feature('roster-mutation'),
    runtimeOperations: feature('runtime-operations'),
    taskBoard: feature('task-board'),
    viewReadModel: feature('view-read-model'),
  };
  const fencedProvisioningStart = feature('fenced-provisioning-start');
  const fencedConfigurationRepository = feature('fenced-configuration-repository');
  const loggers = Array.from({ length: 9 }, (_value, index) => ({
    error: vi.fn(),
    index,
    warn: vi.fn(),
  }));
  const loggerLabels: string[] = [];
  const createLogger = vi.fn((label: string) => {
    const logger = loggers[loggerLabels.length];
    if (!logger) throw new Error(`Unexpected logger construction: ${label}`);
    loggerLabels.push(label);
    return logger;
  });
  const createFactory = (name: string, result: object) =>
    vi.fn((_dependencies: Record<string, unknown>) => {
      events.push(name);
      return result;
    });
  const register = (name: string) =>
    vi.fn((_ipcMain: unknown, _dependencies?: Record<string, unknown>) => {
      events.push(name);
    });
  const remove = (name: string) =>
    vi.fn((_ipcMain: unknown) => {
      events.push(name);
    });

  return {
    createLogger,
    events,
    features,
    fencedConfigurationRepository,
    fencedProvisioningStart,
    loggerLabels,
    loggers,
    createIdentityFencedProvisioningStart: vi.fn(
      (_start: unknown, _backup: unknown, _lifecycle: unknown) => {
        events.push('create-identity-fenced-provisioning-start');
        return fencedProvisioningStart;
      }
    ),
    createIdentityFencedTeamConfigurationRepository: vi.fn(
      (_repository: unknown, _backup: unknown, _lifecycle: unknown, _deleteDraft: unknown) => {
        events.push('create-identity-fenced-configuration-repository');
        return fencedConfigurationRepository;
      }
    ),
    createTeamApprovalsFeature: createFactory('create-approvals', features.approvals),
    createTeamConfigurationFeature: createFactory('create-configuration', features.configuration),
    createTeamMessageDeliveryFeature: createFactory(
      'create-message-delivery',
      features.messageDelivery
    ),
    createTeamProvisioningFeature: createFactory('create-provisioning', features.provisioning),
    createTeamRosterMutationFeature: createFactory(
      'create-roster-mutation',
      features.rosterMutation
    ),
    createTeamRuntimeOperationsFeature: createFactory(
      'create-runtime-operations',
      features.runtimeOperations
    ),
    createTeamTaskBoardFeature: createFactory('create-task-board', features.taskBoard),
    createTeamViewReadModelFeature: createFactory('create-view-read-model', features.viewReadModel),
    initializeTeamHandlers: register('initialize-legacy-team-handlers'),
    permanentlyDeleteDraftTeam: vi.fn(),
    registerTaskLogObservabilityIpc: register('register-task-log-observability'),
    registerTeamApprovalsIpc: register('register-approvals'),
    registerTeamConfigurationIpc: register('register-configuration'),
    registerTeamHandlers: register('register-legacy-team-handlers'),
    registerTeamMessageDeliveryIpc: register('register-message-delivery'),
    registerTeamProvisioningIpc: register('register-provisioning'),
    registerTeamRosterMutationIpc: register('register-roster-mutation'),
    registerTeamRuntimeOperationsIpc: register('register-runtime-operations'),
    registerTeamTaskBoardIpc: register('register-task-board'),
    registerTeamViewReadModelIpc: register('register-view-read-model'),
    removeTaskLogObservabilityIpc: remove('remove-task-log-observability'),
    removeTeamApprovalsIpc: remove('remove-approvals'),
    removeTeamConfigurationIpc: remove('remove-configuration'),
    removeTeamHandlers: remove('remove-legacy-team-handlers'),
    removeTeamMessageDeliveryIpc: remove('remove-message-delivery'),
    removeTeamProvisioningIpc: remove('remove-provisioning'),
    removeTeamRosterMutationIpc: remove('remove-roster-mutation'),
    removeTeamRuntimeOperationsIpc: remove('remove-runtime-operations'),
    removeTeamTaskBoardIpc: remove('remove-task-board'),
    removeTeamViewReadModelIpc: remove('remove-view-read-model'),
  };
});

vi.mock('@shared/utils/logger', () => ({ createLogger: mocks.createLogger }));
vi.mock('@features/task-log-observability/main', () => ({
  registerTaskLogObservabilityIpc: mocks.registerTaskLogObservabilityIpc,
  removeTaskLogObservabilityIpc: mocks.removeTaskLogObservabilityIpc,
}));
vi.mock('@features/team-approvals/main', () => ({
  createTeamApprovalsFeature: mocks.createTeamApprovalsFeature,
  registerTeamApprovalsIpc: mocks.registerTeamApprovalsIpc,
  removeTeamApprovalsIpc: mocks.removeTeamApprovalsIpc,
}));
vi.mock('@features/team-configuration/main', () => ({
  createTeamConfigurationFeature: mocks.createTeamConfigurationFeature,
  registerTeamConfigurationIpc: mocks.registerTeamConfigurationIpc,
  removeTeamConfigurationIpc: mocks.removeTeamConfigurationIpc,
}));
vi.mock('@features/team-message-delivery/main', () => ({
  createTeamMessageDeliveryFeature: mocks.createTeamMessageDeliveryFeature,
  registerTeamMessageDeliveryIpc: mocks.registerTeamMessageDeliveryIpc,
  removeTeamMessageDeliveryIpc: mocks.removeTeamMessageDeliveryIpc,
}));
vi.mock('@features/team-provisioning/main', () => ({
  createTeamProvisioningFeature: mocks.createTeamProvisioningFeature,
  registerTeamProvisioningIpc: mocks.registerTeamProvisioningIpc,
  removeTeamProvisioningIpc: mocks.removeTeamProvisioningIpc,
}));
vi.mock('@features/team-roster-mutations/main', () => ({
  createTeamRosterMutationFeature: mocks.createTeamRosterMutationFeature,
  registerTeamRosterMutationIpc: mocks.registerTeamRosterMutationIpc,
  removeTeamRosterMutationIpc: mocks.removeTeamRosterMutationIpc,
}));
vi.mock('@features/team-runtime-operations/main', () => ({
  createTeamRuntimeOperationsFeature: mocks.createTeamRuntimeOperationsFeature,
  registerTeamRuntimeOperationsIpc: mocks.registerTeamRuntimeOperationsIpc,
  removeTeamRuntimeOperationsIpc: mocks.removeTeamRuntimeOperationsIpc,
}));
vi.mock('@features/team-task-board/main', () => ({
  createTeamTaskBoardFeature: mocks.createTeamTaskBoardFeature,
  registerTeamTaskBoardIpc: mocks.registerTeamTaskBoardIpc,
  removeTeamTaskBoardIpc: mocks.removeTeamTaskBoardIpc,
}));
vi.mock('@features/team-view-read-model/main', () => ({
  createTeamViewReadModelFeature: mocks.createTeamViewReadModelFeature,
  registerTeamViewReadModelIpc: mocks.registerTeamViewReadModelIpc,
  removeTeamViewReadModelIpc: mocks.removeTeamViewReadModelIpc,
}));
vi.mock('@main/ipc/teams', () => ({
  createIdentityFencedProvisioningStart: mocks.createIdentityFencedProvisioningStart,
  createIdentityFencedTeamConfigurationRepository:
    mocks.createIdentityFencedTeamConfigurationRepository,
  initializeTeamHandlers: mocks.initializeTeamHandlers,
  permanentlyDeleteDraftTeam: mocks.permanentlyDeleteDraftTeam,
  registerTeamHandlers: mocks.registerTeamHandlers,
  removeTeamHandlers: mocks.removeTeamHandlers,
}));

function sentinel(name: string): { name: string } {
  return { name };
}

function createDependencies() {
  const identities = {
    boardTaskActivityDetailService: sentinel('board-task-activity-detail-service'),
    boardTaskActivityService: sentinel('board-task-activity-service'),
    boardTaskExactLogDetailService: sentinel('board-task-exact-log-detail-service'),
    boardTaskExactLogsService: sentinel('board-task-exact-logs-service'),
    boardTaskLogStreamService: sentinel('board-task-log-stream-service'),
    branchStatusService: sentinel('branch-status-service'),
    launchIoGovernor: sentinel('launch-io-governor'),
    memberStatsComputer: sentinel('member-stats-computer'),
    teamBackupService: sentinel('team-backup-service'),
    teamDataService: sentinel('team-data-service'),
    teamLogSourceTracker: sentinel('team-log-source-tracker'),
    teamMemberLogsFinder: sentinel('team-member-logs-finder'),
    teamPermanentDeletionLifecycle: sentinel('team-permanent-deletion-lifecycle'),
    teammateToolTracker: sentinel('teammate-tool-tracker'),
  };
  const teamHandlerApis = {
    claudeLogs: sentinel('claude-logs'),
    diagnostics: sentinel('diagnostics'),
    memberLifecycle: sentinel('member-lifecycle'),
    messaging: sentinel('messaging'),
    preflight: sentinel('preflight'),
    provisioningRun: sentinel('provisioning-run'),
    provisioningStart: sentinel('provisioning-start'),
    provisioningStatus: sentinel('provisioning-status'),
    runtime: sentinel('runtime'),
    taskActivity: sentinel('task-activity'),
    toolApproval: sentinel('tool-approval'),
  };

  return {
    dependencies: {
      ...identities,
      teamHandlerApis,
    },
    identities,
    teamHandlerApis,
  };
}

function createComposition() {
  const fixture = createDependencies();
  // @ts-expect-error -- Identity sentinels intentionally exercise wiring without service behavior.
  const composition = createDesktopTeamFeatureComposition(fixture.dependencies);
  return { ...fixture, composition };
}

describe('desktop team feature composition behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.events.length = 0;
  });

  it('removes every team registrar in canonical order without retained feature state', () => {
    const ipcMain = sentinel('ipc-main');

    // @ts-expect-error -- Removal only forwards this identity to mocked registrars.
    removeDesktopTeamFeatureComposition(ipcMain);

    expect(mocks.events).toEqual([
      'remove-legacy-team-handlers',
      'remove-runtime-operations',
      'remove-provisioning',
      'remove-configuration',
      'remove-message-delivery',
      'remove-roster-mutation',
      'remove-view-read-model',
      'remove-task-board',
      'remove-approvals',
      'remove-task-log-observability',
    ]);
    for (const remove of [
      mocks.removeTeamHandlers,
      mocks.removeTeamRuntimeOperationsIpc,
      mocks.removeTeamProvisioningIpc,
      mocks.removeTeamConfigurationIpc,
      mocks.removeTeamMessageDeliveryIpc,
      mocks.removeTeamRosterMutationIpc,
      mocks.removeTeamViewReadModelIpc,
      mocks.removeTeamTaskBoardIpc,
      mocks.removeTeamApprovalsIpc,
      mocks.removeTaskLogObservabilityIpc,
    ]) {
      expect(remove).toHaveBeenCalledWith(ipcMain);
    }
  });

  it('constructs features in canonical order with exact compatibility receivers', () => {
    const { identities, teamHandlerApis } = createComposition();

    expect(mocks.events).toEqual([
      'create-identity-fenced-provisioning-start',
      'create-approvals',
      'create-task-board',
      'create-view-read-model',
      'create-identity-fenced-configuration-repository',
      'create-configuration',
      'create-message-delivery',
      'create-roster-mutation',
      'create-provisioning',
      'create-runtime-operations',
    ]);
    expect(mocks.loggerLabels).toEqual([
      'IPC:teams',
      'IPC:teamApprovals',
      'IPC:teamTaskBoard',
      'IPC:teams',
      'IPC:teams',
      'IPC:teams',
      'IPC:teams',
      'IPC:teams',
      'IPC:teams',
    ]);
    expect(mocks.createIdentityFencedProvisioningStart).toHaveBeenCalledWith(
      teamHandlerApis.provisioningStart,
      identities.teamBackupService,
      identities.teamPermanentDeletionLifecycle
    );
    expect(mocks.createTeamApprovalsFeature).toHaveBeenCalledWith({
      toolApprovalApi: teamHandlerApis.toolApproval,
    });
    expect(mocks.createTeamTaskBoardFeature).toHaveBeenCalledWith({
      taskBoardApi: identities.teamDataService,
      runtimeApi: teamHandlerApis.runtime,
      notificationApi: teamHandlerApis.messaging,
      launchIoGovernor: identities.launchIoGovernor,
      logger: mocks.loggers[2],
    });
    expect(mocks.createTeamViewReadModelFeature).toHaveBeenCalledWith({
      data: identities.teamDataService,
      provisioningRuns: teamHandlerApis.provisioningRun,
      taskActivity: teamHandlerApis.taskActivity,
      runtime: teamHandlerApis.runtime,
      messaging: teamHandlerApis.messaging,
      logger: mocks.loggers[3],
    });
    expect(mocks.createIdentityFencedTeamConfigurationRepository).toHaveBeenCalledWith(
      identities.teamDataService,
      identities.teamBackupService,
      identities.teamPermanentDeletionLifecycle,
      mocks.permanentlyDeleteDraftTeam
    );
    expect(mocks.createTeamConfigurationFeature).toHaveBeenCalledWith({
      repository: mocks.fencedConfigurationRepository,
      runtime: teamHandlerApis.runtime,
      messaging: teamHandlerApis.messaging,
      logger: mocks.loggers[4],
    });
    expect(mocks.createTeamMessageDeliveryFeature).toHaveBeenCalledWith({
      repository: identities.teamDataService,
      runtime: teamHandlerApis.runtime,
      messaging: teamHandlerApis.messaging,
      logger: mocks.loggers[5],
    });
    expect(mocks.createTeamRosterMutationFeature).toHaveBeenCalledWith({
      repository: identities.teamDataService,
      runtime: teamHandlerApis.runtime,
      lifecycle: teamHandlerApis.memberLifecycle,
      messaging: teamHandlerApis.messaging,
      logger: mocks.loggers[7],
    });
    expect(mocks.createTeamProvisioningFeature).toHaveBeenCalledWith({
      start: mocks.fencedProvisioningStart,
      status: teamHandlerApis.provisioningStatus,
      preflight: teamHandlerApis.preflight,
      provisioningRun: teamHandlerApis.provisioningRun,
      repository: identities.teamDataService,
      launchIoGovernor: identities.launchIoGovernor,
      logger: mocks.loggers[6],
    });
    expect(mocks.createTeamRuntimeOperationsFeature).toHaveBeenCalledWith({
      data: identities.teamDataService,
      runtime: teamHandlerApis.runtime,
      lifecycle: teamHandlerApis.memberLifecycle,
      diagnostics: teamHandlerApis.diagnostics,
      claudeLogs: teamHandlerApis.claudeLogs,
      messaging: teamHandlerApis.messaging,
      logsFinder: identities.teamMemberLogsFinder,
      statsComputer: identities.memberStatsComputer,
      logger: mocks.loggers[8],
    });
  });

  it('initializes the legacy owner with the same dependency identities and argument order', () => {
    const { composition, identities, teamHandlerApis } = createComposition();
    mocks.events.length = 0;

    composition.initializeLegacyHandlers();

    expect(mocks.events).toEqual(['initialize-legacy-team-handlers']);
    expect(mocks.initializeTeamHandlers).toHaveBeenCalledWith(
      identities.teamDataService,
      teamHandlerApis.runtime,
      identities.teamBackupService,
      identities.teammateToolTracker,
      identities.teamLogSourceTracker,
      identities.branchStatusService,
      identities.launchIoGovernor,
      identities.teamPermanentDeletionLifecycle
    );
  });

  it('registers legacy and feature adapters in canonical order with exact feature state', () => {
    const { composition, identities } = createComposition();
    const ipcMain = sentinel('ipc-main');
    mocks.events.length = 0;

    // @ts-expect-error -- Registration only forwards this identity to mocked registrars.
    composition.register(ipcMain);

    expect(mocks.events).toEqual([
      'register-legacy-team-handlers',
      'register-runtime-operations',
      'register-provisioning',
      'register-configuration',
      'register-message-delivery',
      'register-roster-mutation',
      'register-view-read-model',
      'register-task-board',
      'register-approvals',
      'register-task-log-observability',
    ]);
    expect(mocks.registerTeamRuntimeOperationsIpc).toHaveBeenCalledWith(
      ipcMain,
      mocks.features.runtimeOperations
    );
    expect(mocks.registerTeamProvisioningIpc).toHaveBeenCalledWith(
      ipcMain,
      mocks.features.provisioning
    );
    expect(mocks.registerTeamConfigurationIpc).toHaveBeenCalledWith(
      ipcMain,
      mocks.features.configuration
    );
    expect(mocks.registerTeamMessageDeliveryIpc).toHaveBeenCalledWith(
      ipcMain,
      mocks.features.messageDelivery
    );
    expect(mocks.registerTeamRosterMutationIpc).toHaveBeenCalledWith(
      ipcMain,
      mocks.features.rosterMutation
    );
    expect(mocks.registerTeamViewReadModelIpc).toHaveBeenCalledWith(
      ipcMain,
      mocks.features.viewReadModel
    );
    expect(mocks.registerTeamTaskBoardIpc).toHaveBeenCalledWith(ipcMain, mocks.features.taskBoard);
    expect(mocks.registerTeamApprovalsIpc).toHaveBeenCalledWith(ipcMain, {
      ...mocks.features.approvals,
      logger: mocks.loggers[1],
    });
    expect(mocks.registerTaskLogObservabilityIpc).toHaveBeenCalledWith(ipcMain, {
      readers: {
        activity: identities.boardTaskActivityService,
        activityDetail: identities.boardTaskActivityDetailService,
        stream: identities.boardTaskLogStreamService,
        exactLogSummaries: identities.boardTaskExactLogsService,
        exactLogDetail: identities.boardTaskExactLogDetailService,
      },
      logger: mocks.loggers[0],
    });
  });
});
