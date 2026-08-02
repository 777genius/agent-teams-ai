import { createDesktopTeamFeatureCapabilities } from '@main/ipc/teamFeatureCapabilities';
import {
  createDesktopTeamFeatureComposition,
  removeDesktopTeamFeatureComposition,
} from '@main/ipc/teamFeatureComposition';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  TeamLifecycleAtomicCommandPort,
  TeamLifecycleReadIpcFeatureDependencies,
} from '@features/team-lifecycle/main';
import type { TeamRuntimeOperationsHostPorts } from '@features/team-runtime-operations/main';

const mocks = vi.hoisted(() => {
  const events: string[] = [];
  const feature = (name: string) => ({ name });
  const features = {
    approvals: {
      commands: feature('approval-commands'),
      previewReader: feature('approval-preview-reader'),
    },
    configuration: feature('configuration'),
    messageDelivery: {
      ...feature('message-delivery'),
      presentRuntimeDeliveryStatus: vi.fn((status: unknown) => status),
      presentSendMessageResult: vi.fn((result: unknown) => result),
    },
    provisioning: feature('provisioning'),
    rosterMutation: feature('roster-mutation'),
    runtimeOperations: feature('runtime-operations'),
    taskBoard: feature('task-board'),
    viewReadModel: feature('view-read-model'),
  };
  const fencedProvisioningStart = feature('fenced-provisioning-start');
  const fencedConfigurationRepository = feature('fenced-configuration-repository');
  const lifecycleIpcFeature = feature('lifecycle-ipc-feature');
  const lifecycleReadIpcFeature = feature('lifecycle-read-ipc-feature');
  const missingTeamStateSources = {
    configExists: vi.fn(),
    draftExists: vi.fn(),
  };
  const loggers = Array.from({ length: 11 }, (_value, index) => ({
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
    vi.fn((_dependencies?: unknown) => {
      events.push(name);
      return result;
    });
  const eventHandler = (name: string) =>
    vi.fn(() => {
      events.push(name);
    });
  const register = eventHandler;
  const remove = eventHandler;
  const createTeamRuntimeOperationsFeature = vi.fn((...args: [TeamRuntimeOperationsHostPorts]) => {
    if (!args[0]) throw new Error('Runtime operations host ports are required');
    events.push('create-runtime-operations');
    return features.runtimeOperations;
  });
  const createTeamRuntimeLifecycleHostPort = vi.fn(
    (source: {
      getMemberSpawnStatuses: TeamRuntimeOperationsHostPorts['lifecycle']['getMemberSpawnStatuses'];
      restartMember: TeamRuntimeOperationsHostPorts['lifecycle']['restartMember'];
      retryFailedOpenCodeSecondaryLanes: TeamRuntimeOperationsHostPorts['lifecycle']['retryFailedRuntimeLanes'];
      skipMemberForLaunch: TeamRuntimeOperationsHostPorts['lifecycle']['skipMemberForLaunch'];
    }): TeamRuntimeOperationsHostPorts['lifecycle'] => ({
      getMemberSpawnStatuses: (teamName) => source.getMemberSpawnStatuses(teamName),
      restartMember: (teamName, memberName) => source.restartMember(teamName, memberName),
      retryFailedRuntimeLanes: (teamName) => source.retryFailedOpenCodeSecondaryLanes(teamName),
      skipMemberForLaunch: (teamName, memberName) =>
        source.skipMemberForLaunch(teamName, memberName),
    })
  );

  return {
    createLogger,
    events,
    features,
    fencedConfigurationRepository,
    fencedProvisioningStart,
    lifecycleIpcFeature,
    lifecycleReadIpcFeature,
    loggerLabels,
    loggers,
    missingTeamStateSources,
    createIdentityFencedProvisioningStart: vi.fn(() => {
      events.push('create-identity-fenced-provisioning-start');
      return fencedProvisioningStart;
    }),
    createIdentityFencedTeamConfigurationRepository: vi.fn(() => {
      events.push('create-identity-fenced-configuration-repository');
      return fencedConfigurationRepository;
    }),
    createTeamLifecycleIpcFeature: vi.fn(
      (dependencies: {
        commands: TeamLifecycleAtomicCommandPort;
        logger: unknown;
        validateTeamName: unknown;
      }) => {
        if (!dependencies.commands) throw new Error('Lifecycle commands are required');
        events.push('create-lifecycle-ipc-feature');
        return lifecycleIpcFeature;
      }
    ),
    createTeamLifecycleReadIpcFeature: vi.fn(
      (dependencies: TeamLifecycleReadIpcFeatureDependencies) => {
        if (!dependencies.legacy || !dependencies.canonical) {
          throw new Error('Lifecycle read ports are required');
        }
        events.push('create-lifecycle-read-ipc-feature');
        return lifecycleReadIpcFeature;
      }
    ),
    createTeamApprovalsFeature: createFactory('create-approvals', features.approvals),
    createTeamConfigurationFeature: createFactory('create-configuration', features.configuration),
    createDesktopTeamMessageDeliveryFeature: createFactory(
      'create-message-delivery',
      features.messageDelivery
    ),
    createTeamProvisioningFeature: createFactory('create-provisioning', features.provisioning),
    createTeamRosterMutationFeature: createFactory(
      'create-roster-mutation',
      features.rosterMutation
    ),
    createTeamRuntimeLifecycleHostPort,
    createTeamRuntimeOperationsFeature,
    createTeamTaskBoardFeature: createFactory('create-task-board', features.taskBoard),
    createTeamViewReadModelFeature: createFactory('create-view-read-model', features.viewReadModel),
    initializeTeamHandlers: register('initialize-legacy-team-handlers'),
    invalidateTeamConfig: vi.fn(),
    permanentlyDeleteDraftTeam: vi.fn(),
    permanentlyDeleteTeam: vi.fn(),
    registerTaskLogObservabilityIpc: register('register-task-log-observability'),
    registerTeamApprovalsIpc: register('register-approvals'),
    registerTeamConfigurationIpc: register('register-configuration'),
    registerTeamHandlers: register('register-legacy-team-handlers'),
    registerTeamLifecycleIpc: register('register-lifecycle-ipc'),
    registerTeamLifecycleReadIpc: register('register-lifecycle-read-ipc'),
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
    removeTeamLifecycleIpc: remove('remove-lifecycle-ipc'),
    removeTeamLifecycleReadIpc: remove('remove-lifecycle-read-ipc'),
    removeTeamMessageDeliveryIpc: remove('remove-message-delivery'),
    removeTeamProvisioningIpc: remove('remove-provisioning'),
    removeTeamRosterMutationIpc: remove('remove-roster-mutation'),
    removeTeamRuntimeOperationsIpc: remove('remove-runtime-operations'),
    removeTeamTaskBoardIpc: remove('remove-task-board'),
    removeTeamViewReadModelIpc: remove('remove-view-read-model'),
  };
});

vi.mock('@shared/utils/logger', () => ({ createLogger: mocks.createLogger }));
vi.mock('@main/services/team/TeamAttachmentStore', () => ({
  TeamAttachmentStore: vi.fn().mockImplementation(() => ({
    getAttachments: vi.fn(),
    saveAttachments: vi.fn(),
  })),
}));
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
  createDesktopTeamMessageDeliveryFeature: mocks.createDesktopTeamMessageDeliveryFeature,
  registerTeamMessageDeliveryIpc: mocks.registerTeamMessageDeliveryIpc,
  removeTeamMessageDeliveryIpc: mocks.removeTeamMessageDeliveryIpc,
}));
vi.mock('@features/team-lifecycle/main', () => ({
  createTeamLifecycleIpcFeature: mocks.createTeamLifecycleIpcFeature,
  createTeamLifecycleReadIpcFeature: mocks.createTeamLifecycleReadIpcFeature,
  registerTeamLifecycleIpc: mocks.registerTeamLifecycleIpc,
  registerTeamLifecycleReadIpc: mocks.registerTeamLifecycleReadIpc,
  removeTeamLifecycleIpc: mocks.removeTeamLifecycleIpc,
  removeTeamLifecycleReadIpc: mocks.removeTeamLifecycleReadIpc,
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
  createTeamRuntimeLifecycleHostPort: mocks.createTeamRuntimeLifecycleHostPort,
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
vi.mock('@main/ipc/teamProvisioningHost', () => ({
  createDesktopTeamProvisioningFeature: (dependencies: Record<string, unknown>) => {
    const pureDependencies = { ...dependencies };
    delete pureDependencies.launchIoGovernor;
    return mocks.createTeamProvisioningFeature({
      ...pureDependencies,
      diagnostics: {},
      effects: {},
      workspace: {},
    });
  },
}));
vi.mock('@main/ipc/teamViewReadModelHost', () => ({
  createDesktopMissingTeamStateSources: () => mocks.missingTeamStateSources,
  createDesktopTeamViewReadModelEnvironment: () => ({}),
}));
vi.mock('@main/utils/safeWebContentsSend', () => ({ safeSendToRenderer: vi.fn() }));
vi.mock('@main/ipc/teams', () => ({
  createIdentityFencedProvisioningStart: mocks.createIdentityFencedProvisioningStart,
  createIdentityFencedTeamConfigurationRepository:
    mocks.createIdentityFencedTeamConfigurationRepository,
  initializeTeamHandlers: mocks.initializeTeamHandlers,
  permanentlyDeleteDraftTeam: mocks.permanentlyDeleteDraftTeam,
  permanentlyDeleteTeam: mocks.permanentlyDeleteTeam,
  registerTeamHandlers: mocks.registerTeamHandlers,
  removeTeamHandlers: mocks.removeTeamHandlers,
}));
vi.mock('@main/services/team/TeamDataWorkerClient', () => ({
  getTeamDataWorkerClient: () => ({
    invalidateTeamConfig: mocks.invalidateTeamConfig,
  }),
}));

function sentinel(name: string): { name: string } {
  return { name };
}

function createDependencies() {
  const runtimeOperationResults = {
    activity: { state: 'idle', runId: 'runtime-run' },
    aliveTeams: ['sandbox-team'],
    context: { usage: null, runId: 'runtime-run' },
    memberLogs: Promise.resolve([{ memberName: 'alice' }]),
    memberStats: Promise.resolve({ memberName: 'alice' }),
    retry: Promise.resolve({
      attempted: ['alice'],
      confirmed: ['alice'],
      pending: [],
      failed: [],
      skipped: [],
    }),
    runtimeLogs: Promise.resolve({
      lines: ['runtime log'],
      total: 1,
      hasMore: false,
    }),
    runtimeSnapshot: Promise.resolve({
      teamName: 'sandbox-team',
      runId: 'runtime-run',
      updatedAt: '2026-07-28T00:00:00.000Z',
      members: {},
    }),
    spawnStatuses: Promise.resolve({
      statuses: {},
      runId: 'runtime-run',
      updatedAt: '2026-07-28T00:00:00.000Z',
    }),
    taskLogs: Promise.resolve([{ memberName: 'alice', taskId: 'task-1' }]),
    teamData: Promise.resolve({
      processes: [
        { pid: 41, label: 'preview', port: 4173 },
        { pid: 42, label: 'worker' },
      ],
    }),
  };
  const identities = {
    boardTaskActivityDetailService: sentinel('board-task-activity-detail-service'),
    boardTaskActivityService: sentinel('board-task-activity-service'),
    boardTaskExactLogDetailService: sentinel('board-task-exact-log-detail-service'),
    boardTaskExactLogsService: sentinel('board-task-exact-logs-service'),
    boardTaskLogStreamService: sentinel('board-task-log-stream-service'),
    branchStatusService: sentinel('branch-status-service'),
    launchIoGovernor: sentinel('launch-io-governor'),
    memberStatsComputer: {
      ...sentinel('member-stats-computer'),
      getStats: vi.fn(() => runtimeOperationResults.memberStats),
    },
    teamBackupService: sentinel('team-backup-service'),
    teamDataService: {
      ...sentinel('team-data-service'),
      deleteTeam: vi.fn(() => Promise.resolve()),
      getTeamData: vi.fn(() => runtimeOperationResults.teamData),
      invalidateMessageFeed: vi.fn(),
      killProcess: vi.fn(() => Promise.resolve()),
      restoreTeam: vi.fn(() => Promise.resolve()),
    },
    teamLogSourceTracker: sentinel('team-log-source-tracker'),
    teamMemberLogsFinder: {
      ...sentinel('team-member-logs-finder'),
      findLogsForTask: vi.fn(() => runtimeOperationResults.taskLogs),
      findMemberLogs: vi.fn(() => runtimeOperationResults.memberLogs),
    },
    teamPermanentDeletionLifecycle: sentinel('team-permanent-deletion-lifecycle'),
    teammateToolTracker: sentinel('teammate-tool-tracker'),
  };
  const capabilitySources = {
    claudeLogs: {
      ...sentinel('claude-logs'),
      getClaudeLogs: vi.fn(() => runtimeOperationResults.runtimeLogs),
    },
    diagnostics: {
      ...sentinel('diagnostics'),
      getLeadActivityState: vi.fn(() => runtimeOperationResults.activity),
      getLeadContextUsage: vi.fn(() => runtimeOperationResults.context),
      getTeamAgentRuntimeSnapshot: vi.fn(() => runtimeOperationResults.runtimeSnapshot),
    },
    memberLifecycle: {
      ...sentinel('member-lifecycle'),
      getMemberSpawnStatuses: vi.fn(() => runtimeOperationResults.spawnStatuses),
      restartMember: vi.fn(() => Promise.resolve()),
      retryFailedOpenCodeSecondaryLanes: vi.fn(() => runtimeOperationResults.retry),
      skipMemberForLaunch: vi.fn(() => Promise.resolve()),
    },
    messaging: {
      ...sentinel('messaging'),
      sendMessageToTeam: vi.fn(() => Promise.resolve()),
    },
    preflight: sentinel('preflight'),
    provisioningRun: sentinel('provisioning-run'),
    provisioningStart: sentinel('provisioning-start'),
    provisioningStatus: sentinel('provisioning-status'),
    runtime: {
      ...sentinel('runtime'),
      getAliveTeams: vi.fn(() => runtimeOperationResults.aliveTeams),
      isTeamAlive: vi.fn(() => true),
      stopTeam: vi.fn(() => Promise.resolve()),
    },
    taskActivity: sentinel('task-activity'),
    toolApproval: sentinel('tool-approval'),
  };
  // @ts-expect-error -- Identity sentinels intentionally exercise wiring without service behavior.
  const capabilities = createDesktopTeamFeatureCapabilities(capabilitySources);

  return {
    dependencies: {
      ...identities,
      capabilities,
    },
    identities,
    runtimeOperationResults,
    capabilities,
    capabilitySources,
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
    const ipcMain = { ...sentinel('ipc-main'), removeHandler: vi.fn() };

    // @ts-expect-error -- Removal only forwards this identity to mocked registrars.
    removeDesktopTeamFeatureComposition(ipcMain);

    expect(mocks.events).toEqual([
      'remove-legacy-team-handlers',
      'remove-lifecycle-read-ipc',
      'remove-lifecycle-ipc',
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
    expect(ipcMain.removeHandler.mock.calls.map(([channel]) => channel)).toEqual([
      'team:processSend',
      'team:processAlive',
    ]);
    for (const remove of [
      mocks.removeTeamHandlers,
      mocks.removeTeamLifecycleReadIpc,
      mocks.removeTeamLifecycleIpc,
      mocks.removeTeamRuntimeOperationsIpc,
      mocks.removeTeamProvisioningIpc,
      mocks.removeTeamConfigurationIpc,
      mocks.removeTeamRosterMutationIpc,
      mocks.removeTeamViewReadModelIpc,
      mocks.removeTeamTaskBoardIpc,
      mocks.removeTeamApprovalsIpc,
      mocks.removeTaskLogObservabilityIpc,
    ]) {
      expect(remove).toHaveBeenCalledWith(ipcMain);
    }
    expect(mocks.removeTeamMessageDeliveryIpc).toHaveBeenCalledWith({
      handle: expect.any(Function),
      removeHandler: expect.any(Function),
    });
  });

  it('constructs features in canonical order with exact compatibility receivers', () => {
    const { capabilities, capabilitySources, identities } = createComposition();

    expect(Object.isFrozen(capabilities)).toBe(true);
    expect(mocks.events).toEqual([
      'create-lifecycle-read-ipc-feature',
      'create-lifecycle-ipc-feature',
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
      'Perf:EventLoop',
      'IPC:teams',
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
    expect(mocks.createTeamLifecycleIpcFeature).toHaveBeenCalledWith({
      commands: {
        deleteTeam: expect.any(Function),
        restoreTeam: expect.any(Function),
        permanentlyDeleteTeam: mocks.permanentlyDeleteTeam,
      },
      logger: mocks.loggers[2],
      validateTeamName: expect.any(Function),
    });
    expect(mocks.createTeamLifecycleReadIpcFeature).toHaveBeenCalledWith({
      canonical: { listTeamLifecycle: expect.any(Function) },
      clock: { now: Date.now },
      legacy: { listTeams: expect.any(Function) },
      logger: mocks.loggers[2],
      operations: { setCurrent: expect.any(Function) },
    });
    expect(mocks.createIdentityFencedProvisioningStart).toHaveBeenCalledWith(
      capabilities.provisioningStart,
      identities.teamBackupService,
      identities.teamPermanentDeletionLifecycle
    );
    expect(mocks.createTeamApprovalsFeature).toHaveBeenCalledWith({
      fileReader: expect.objectContaining({ read: expect.any(Function) }),
      toolApprovalApi: capabilities.toolApproval,
    });
    expect(mocks.createTeamTaskBoardFeature).toHaveBeenCalledWith({
      taskBoardApi: identities.teamDataService,
      runtimeApi: capabilities.runtime,
      notificationApi: capabilities.messaging,
      launchIoGovernor: identities.launchIoGovernor,
      logger: mocks.loggers[4],
    });
    expect(mocks.createTeamViewReadModelFeature).toHaveBeenCalledWith({
      data: identities.teamDataService,
      provisioningRuns: capabilities.provisioningRun,
      taskActivity: capabilities.taskActivity,
      runtime: capabilities.runtime,
      messaging: capabilities.liveLeadMessages,
      logger: mocks.loggers[5],
      environment: expect.any(Object),
      missingTeamStateSources: mocks.missingTeamStateSources,
    });
    expect(mocks.createIdentityFencedTeamConfigurationRepository).toHaveBeenCalledWith(
      identities.teamDataService,
      identities.teamBackupService,
      identities.teamPermanentDeletionLifecycle,
      mocks.permanentlyDeleteDraftTeam
    );
    expect(mocks.createTeamConfigurationFeature).toHaveBeenCalledWith({
      repository: mocks.fencedConfigurationRepository,
      runtime: capabilities.runtime,
      messaging: capabilities.messaging,
      logger: mocks.loggers[6],
    });
    expect(mocks.createDesktopTeamMessageDeliveryFeature).toHaveBeenCalledWith({
      repository: identities.teamDataService,
      runtime: capabilities.runtime,
      messaging: capabilities.messageDeliveryCompatibility,
      logger: mocks.loggers[7],
      attachments: {
        getAttachments: expect.any(Function),
        saveAttachments: expect.any(Function),
      },
      roster: {
        getMembers: expect.any(Function),
      },
      actionModeInstructions: {
        buildAgentBlock: expect.any(Function),
      },
      runtimeDeliveryImpact: {
        buildImpact: expect.any(Function),
      },
    });
    expect(mocks.createTeamRosterMutationFeature).toHaveBeenCalledWith({
      repository: identities.teamDataService,
      runtime: capabilities.runtime,
      lifecycle: capabilities.rosterLifecycle,
      messaging: capabilities.messaging,
      logger: mocks.loggers[9],
    });
    expect(mocks.createTeamProvisioningFeature).toHaveBeenCalledWith({
      start: mocks.fencedProvisioningStart,
      status: capabilities.provisioningStatus,
      preflight: capabilities.preflight,
      provisioningRun: capabilities.provisioningRun,
      repository: identities.teamDataService,
      logger: mocks.loggers[8],
      diagnostics: expect.any(Object),
      effects: expect.any(Object),
      workspace: expect.any(Object),
    });
    expect(mocks.createTeamRuntimeLifecycleHostPort).toHaveBeenCalledWith(
      capabilitySources.memberLifecycle
    );
    expect(mocks.createTeamRuntimeOperationsFeature).toHaveBeenCalledOnce();
    expect(
      Object.keys(mocks.createTeamRuntimeOperationsFeature.mock.calls[0][0]).sort((left, right) =>
        left.localeCompare(right)
      )
    ).toEqual([
      'diagnostics',
      'feed',
      'lifecycle',
      'logger',
      'logs',
      'messaging',
      'processes',
      'runtime',
    ]);
  });

  it('adapts every runtime operation to the exact legacy receiver and preserves results', async () => {
    const { capabilities, capabilitySources, identities, runtimeOperationResults } =
      createComposition();
    const host = mocks.createTeamRuntimeOperationsFeature.mock.calls[0][0];
    const runtimeQuery = { offset: 4, limit: 8 };
    const taskQuery = { owner: 'alice', since: '2026-07-28T00:00:00.000Z' };

    expect(host.logs.getRuntimeLogs('sandbox-team', runtimeQuery)).toBe(
      runtimeOperationResults.runtimeLogs
    );
    expect(host.logs.getClaudeLogs('sandbox-team', runtimeQuery)).toBe(
      runtimeOperationResults.runtimeLogs
    );
    expect(host.logs.findMemberLogs('sandbox-team', 'alice')).toBe(
      runtimeOperationResults.memberLogs
    );
    expect(host.logs.findLogsForTask('sandbox-team', 'task-1', taskQuery)).toBe(
      runtimeOperationResults.taskLogs
    );
    expect(host.logs.getMemberStats('sandbox-team', 'alice')).toBe(
      runtimeOperationResults.memberStats
    );
    expect(host.runtime.getAliveTeams()).toBe(runtimeOperationResults.aliveTeams);
    expect(host.runtime.isTeamAlive('sandbox-team')).toBe(true);

    const stop = host.runtime.stopTeam('sandbox-team');
    const restart = host.lifecycle.restartMember('sandbox-team', 'alice');
    const retry = host.lifecycle.retryFailedRuntimeLanes('sandbox-team');
    const skip = host.lifecycle.skipMemberForLaunch('sandbox-team', 'alice');
    expect(retry).toBe(runtimeOperationResults.retry);
    await expect(Promise.all([stop, restart, retry, skip])).resolves.toBeDefined();

    expect(host.lifecycle.getMemberSpawnStatuses('sandbox-team')).toBe(
      runtimeOperationResults.spawnStatuses
    );
    expect(host.diagnostics.getLeadActivityState('sandbox-team')).toBe(
      runtimeOperationResults.activity
    );
    expect(host.diagnostics.getLeadContextUsage('sandbox-team')).toBe(
      runtimeOperationResults.context
    );
    expect(host.diagnostics.getTeamAgentRuntimeSnapshot('sandbox-team')).toBe(
      runtimeOperationResults.runtimeSnapshot
    );

    host.feed.invalidateMessageFeed('sandbox-team');
    expect(await host.processes.findProcess('sandbox-team', 41)).toEqual({
      label: 'preview',
      port: 4173,
    });
    expect(await host.processes.findProcess('sandbox-team', 42)).toEqual({
      label: 'worker',
      port: undefined,
    });
    expect(await host.processes.findProcess('sandbox-team', 99)).toBeNull();
    await host.processes.killProcess('sandbox-team', 41);
    await host.messaging.sendMessageToTeam('sandbox-team', 'status');
    expect(host.logger).toBe(mocks.loggers[10]);

    expect(capabilities.runtimeLogs.getClaudeLogs).toHaveBeenCalledTimes(2);
    expect(capabilities.runtimeLogs.getClaudeLogs).toHaveBeenNthCalledWith(
      1,
      'sandbox-team',
      runtimeQuery
    );
    expect(capabilities.runtimeLogs.getClaudeLogs).toHaveBeenNthCalledWith(
      2,
      'sandbox-team',
      runtimeQuery
    );
    expect(identities.teamMemberLogsFinder.findMemberLogs).toHaveBeenCalledWith(
      'sandbox-team',
      'alice'
    );
    expect(identities.teamMemberLogsFinder.findLogsForTask).toHaveBeenCalledWith(
      'sandbox-team',
      'task-1',
      taskQuery
    );
    expect(identities.memberStatsComputer.getStats).toHaveBeenCalledWith('sandbox-team', 'alice');
    expect(capabilities.runtime.stopTeam).toHaveBeenCalledWith('sandbox-team');
    expect(capabilitySources.memberLifecycle.restartMember).toHaveBeenCalledWith(
      'sandbox-team',
      'alice'
    );
    expect(
      capabilitySources.memberLifecycle.retryFailedOpenCodeSecondaryLanes
    ).toHaveBeenCalledWith('sandbox-team');
    expect(capabilitySources.memberLifecycle.skipMemberForLaunch).toHaveBeenCalledWith(
      'sandbox-team',
      'alice'
    );
    expect(identities.teamDataService.invalidateMessageFeed).toHaveBeenCalledWith('sandbox-team');
    expect(identities.teamDataService.getTeamData).toHaveBeenCalledTimes(3);
    expect(identities.teamDataService.killProcess).toHaveBeenCalledWith('sandbox-team', 41);
    expect(capabilities.messaging.sendMessageToTeam).toHaveBeenCalledWith('sandbox-team', 'status');
  });

  it('keeps legacy mutation sequencing in the compatibility ACL outside the feature', async () => {
    const { capabilities, capabilitySources, identities } = createComposition();
    const featureDependencies = mocks.createTeamLifecycleIpcFeature.mock.calls[0]?.[0] as {
      commands: TeamLifecycleAtomicCommandPort;
    };

    await featureDependencies.commands.deleteTeam('sandbox-team');

    expect(capabilities.runtime.stopTeam).toHaveBeenCalledWith('sandbox-team');
    expect(identities.teamDataService.deleteTeam).toHaveBeenCalledWith('sandbox-team');
    expect(capabilitySources.runtime.stopTeam.mock.invocationCallOrder[0]).toBeLessThan(
      identities.teamDataService.deleteTeam.mock.invocationCallOrder[0]
    );
    expect(mocks.invalidateTeamConfig).toHaveBeenCalledWith('sandbox-team');
    expect(identities.teamDataService.deleteTeam.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.invalidateTeamConfig.mock.invocationCallOrder[0]
    );

    mocks.invalidateTeamConfig.mockClear();
    await featureDependencies.commands.restoreTeam('sandbox-team');

    expect(identities.teamDataService.restoreTeam).toHaveBeenCalledWith('sandbox-team');
    expect(mocks.invalidateTeamConfig).toHaveBeenCalledWith('sandbox-team');
    expect(identities.teamDataService.restoreTeam.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.invalidateTeamConfig.mock.invocationCallOrder[0]
    );

    await featureDependencies.commands.permanentlyDeleteTeam('sandbox-team');
    expect(mocks.permanentlyDeleteTeam).toHaveBeenCalledWith('sandbox-team');
  });

  it('initializes the legacy owner with the same dependency identities and argument order', () => {
    const { capabilities, composition, identities } = createComposition();
    mocks.events.length = 0;

    composition.initializeLegacyHandlers();

    expect(mocks.events).toEqual(['initialize-legacy-team-handlers']);
    expect(mocks.initializeTeamHandlers).toHaveBeenCalledWith(
      identities.teamDataService,
      capabilities.runtime,
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
    const ipcMain = { ...sentinel('ipc-main'), handle: vi.fn() };
    mocks.events.length = 0;

    // @ts-expect-error -- Registration only forwards this identity to mocked registrars.
    composition.register(ipcMain);

    expect(mocks.events).toEqual([
      'register-legacy-team-handlers',
      'register-lifecycle-read-ipc',
      'register-lifecycle-ipc',
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
    expect(ipcMain.handle.mock.calls.map(([channel]) => channel)).toEqual([
      'team:processSend',
      'team:processAlive',
    ]);
    expect(mocks.registerTeamLifecycleReadIpc).toHaveBeenCalledWith(
      ipcMain,
      mocks.lifecycleReadIpcFeature
    );
    expect(mocks.registerTeamLifecycleIpc).toHaveBeenCalledWith(ipcMain, mocks.lifecycleIpcFeature);
    expect(mocks.registerTeamRuntimeOperationsIpc).toHaveBeenCalledWith(
      ipcMain,
      mocks.features.runtimeOperations
    );
    expect(mocks.registerTeamProvisioningIpc).toHaveBeenCalledWith(
      ipcMain,
      mocks.features.provisioning,
      expect.objectContaining({ observeProgress: expect.any(Function) })
    );
    expect(mocks.registerTeamConfigurationIpc).toHaveBeenCalledWith(
      ipcMain,
      mocks.features.configuration,
      expect.any(Object)
    );
    expect(mocks.registerTeamMessageDeliveryIpc).toHaveBeenCalledWith(
      {
        handle: expect.any(Function),
        removeHandler: expect.any(Function),
      },
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
      logger: mocks.loggers[3],
    });
    expect(mocks.registerTaskLogObservabilityIpc).toHaveBeenCalledWith(ipcMain, {
      readers: {
        activity: identities.boardTaskActivityService,
        activityDetail: identities.boardTaskActivityDetailService,
        stream: identities.boardTaskLogStreamService,
        exactLogSummaries: identities.boardTaskExactLogsService,
        exactLogDetail: identities.boardTaskExactLogDetailService,
      },
      logger: mocks.loggers[1],
    });
  });
});
