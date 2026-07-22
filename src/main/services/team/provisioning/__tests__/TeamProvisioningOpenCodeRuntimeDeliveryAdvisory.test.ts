import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createTeamProvisioningOpenCodeRuntimeDeliveryAdvisoryPortsFromService,
  type OpenCodeRuntimeDeliveryAdvisoryPorts,
  TeamProvisioningOpenCodeRuntimeDeliveryAdvisory,
  type TeamProvisioningOpenCodeRuntimeDeliveryAdvisoryServiceHost,
} from '../TeamProvisioningOpenCodeRuntimeDeliveryAdvisory';

import type { OpenCodePromptDeliveryLedgerRecord } from '../../opencode/delivery/OpenCodePromptDeliveryLedger';
import type { TeamChangeEvent } from '@shared/types';

const testProjectPath = '/safe-test/team-alpha';

describe('TeamProvisioningOpenCodeRuntimeDeliveryAdvisory', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('suppresses advisory decisions when the ledger read proves the record was removed', async () => {
    const record = promptDeliveryRecord();
    const ports = createPorts({ ledgerRecords: [] });
    const helper = new TeamProvisioningOpenCodeRuntimeDeliveryAdvisory(ports);

    await expect(helper.decideUserFacingAdvisory(record)).resolves.toEqual({
      record,
      decision: { action: 'suppress' },
    });
    expect(ports.readProofIndex).not.toHaveBeenCalled();
  });

  it('defers proof-only failures inside the proof grace window and schedules a review', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const setTimeoutPort = vi.fn(() => 1 as unknown as ReturnType<typeof setTimeout>);
    const record = promptDeliveryRecord({
      failedAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      lastReason: 'visible_reply_still_required',
      diagnostics: ['visible_reply_still_required'],
    });
    const ports = createPorts({
      ledgerRecords: [record],
      setTimeout: setTimeoutPort,
      nowMs: () => Date.now(),
    });
    const helper = new TeamProvisioningOpenCodeRuntimeDeliveryAdvisory(ports);

    await helper.handleUserFacingSideEffects(record);

    expect(ports.emitTeamChange).toHaveBeenCalledWith({
      type: 'member-advisory',
      teamName: 'team-a',
      detail: 'opencode-runtime-delivery-error:builder:delivery-1',
    });
    expect(setTimeoutPort).toHaveBeenCalledWith(expect.any(Function), 120_000);
    expect(ports.scheduleProofMissingWorkSyncRecovery).not.toHaveBeenCalled();
    expect(ports.addTeamNotification).not.toHaveBeenCalled();
  });

  it('cancels deferred advisory reviews for a cleaned team only', async () => {
    const callbackByTimer = new Map<string, () => void>();
    const clearedTimers = new Set<string>();
    const clearTimeoutPort = vi.fn((timer: ReturnType<typeof setTimeout>) => {
      clearedTimers.add(String(timer));
    });
    const setTimeoutPort = vi.fn((callback: () => void) => {
      const timer = `timer-${callbackByTimer.size + 1}`;
      callbackByTimer.set(timer, callback);
      return timer as unknown as ReturnType<typeof setTimeout>;
    });
    const teamRecord = promptDeliveryRecord({
      teamName: 'team-a',
      laneId: 'lane-a',
      id: 'delivery-a',
      memberName: 'builder',
    });
    const otherTeamRecord = promptDeliveryRecord({
      teamName: 'team-b',
      laneId: 'lane-b',
      id: 'delivery-b',
      memberName: 'reviewer',
    });
    const ports = createPorts({
      setTimeout: setTimeoutPort,
      clearTimeout: clearTimeoutPort,
    });
    const helper = new TeamProvisioningOpenCodeRuntimeDeliveryAdvisory(ports);

    helper.scheduleAdvisoryReview(teamRecord, {
      action: 'defer',
      nextReviewAt: '2026-01-01T00:02:00.000Z',
    });
    helper.scheduleAdvisoryReview(otherTeamRecord, {
      action: 'defer',
      nextReviewAt: '2026-01-01T00:02:00.000Z',
    });

    helper.cancelTeam('team-a');
    for (const [timer, callback] of callbackByTimer) {
      if (!clearedTimers.has(timer)) {
        callback();
      }
    }

    expect(clearTimeoutPort).toHaveBeenCalledWith('timer-1');
    expect(clearTimeoutPort).not.toHaveBeenCalledWith('timer-2');
    expect(ports.createOpenCodePromptDeliveryLedger).toHaveBeenCalledTimes(1);
    expect(ports.createOpenCodePromptDeliveryLedger).toHaveBeenCalledWith('team-b', 'lane-b');
  });

  it('schedules proof-missing recovery after grace without firing an error notification', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:02:01.000Z'));
    const record = promptDeliveryRecord({
      failedAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      lastReason: 'visible_reply_still_required',
      diagnostics: ['visible_reply_still_required'],
    });
    const ports = createPorts({
      ledgerRecords: [record],
      nowMs: () => Date.now(),
    });
    const helper = new TeamProvisioningOpenCodeRuntimeDeliveryAdvisory(ports);

    await helper.handleUserFacingSideEffects(record);

    expect(ports.scheduleProofMissingWorkSyncRecovery).toHaveBeenCalledWith({
      teamName: 'team-a',
      memberName: 'builder',
      originalMessageId: 'message-1',
      taskRefs: [{ teamName: 'team-a', taskId: 'task-1', displayId: '7' }],
      reason: 'OpenCode responded, but did not create a visible message_send reply.',
    });
    expect(ports.addTeamNotification).not.toHaveBeenCalled();
  });

  it('stores hard error notifications and dedupes lead notices by delivery record', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const sendLeadNotice = vi.fn().mockResolvedValue(undefined);
    const record = promptDeliveryRecord({
      responseState: 'permission_blocked',
      lastReason: 'permission_blocked',
      diagnostics: ['permission_blocked'],
    });
    const ports = createPorts({
      ledgerRecords: [record],
      nowMs: () => Date.now(),
      getLeadNoticeSink: () => ({ send: sendLeadNotice }),
    });
    const helper = new TeamProvisioningOpenCodeRuntimeDeliveryAdvisory(ports);

    await helper.handleUserFacingSideEffects(record);
    await helper.handleUserFacingSideEffects(record);

    expect(ports.addTeamNotification).toHaveBeenCalledTimes(2);
    expect(ports.addTeamNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        teamEventType: 'api_error',
        teamName: 'team-a',
        teamDisplayName: 'Team Alpha',
        from: 'builder',
        summary: 'OpenCode runtime error #7',
        dedupeKey: 'opencode_runtime_delivery_error:team-a:builder:delivery-1',
        body: 'Team Team Alpha: @builder hit an OpenCode runtime delivery error while handling #7. permission_blocked',
        projectPath: testProjectPath,
      })
    );
    expect(sendLeadNotice).toHaveBeenCalledTimes(1);
    expect(sendLeadNotice).toHaveBeenCalledWith(
      [
        'System notice: OpenCode teammate @builder hit a runtime delivery error while handling #7.',
        'Reason: permission_blocked',
        'Treat @builder as unavailable for that work until retry or restart succeeds.',
        'Do not message the human user solely because of this notice unless user action is required.',
      ].join(' ')
    );
    expect(ports.emitTeamChange).toHaveBeenCalledTimes(1);
  });

  it('emits one task log change per distinct referenced task', () => {
    const ports = createPorts();
    const helper = new TeamProvisioningOpenCodeRuntimeDeliveryAdvisory(ports);
    const record = promptDeliveryRecord({
      taskRefs: [
        { teamName: 'team-a', taskId: 'task-1', displayId: '7' },
        { teamName: 'team-a', taskId: 'task-1', displayId: '7' },
        { teamName: 'team-a', taskId: '', displayId: '8' },
      ],
    });

    helper.emitPromptDeliveryTaskLogChange(record, 'runtime-delivery');

    expect(ports.emitTeamChange).toHaveBeenCalledTimes(2);
    expect(ports.emitTeamChange).toHaveBeenCalledWith({
      type: 'task-log-change',
      teamName: 'team-a',
      runId: 'run-1',
      taskId: 'task-1',
      detail: 'runtime-delivery',
      taskSignalKind: 'log',
    });
    expect(ports.emitTeamChange).toHaveBeenCalledWith({
      type: 'task-log-change',
      teamName: 'team-a',
      runId: 'run-1',
      taskId: '8',
      detail: 'runtime-delivery',
      taskSignalKind: 'log',
    });
  });

  it('builds advisory ports from service-shaped host wiring', async () => {
    const ledger = { list: vi.fn() };
    const run = {
      processKilled: false,
      cancelRequested: false,
      child: { stdin: { writable: true } },
    };
    const teamChanges: TeamChangeEvent[] = [];
    const invalidator = vi.fn();
    const proofRecoveryScheduler = vi.fn();
    const service = {
      runs: new Map([['run-1', run]]),
      runTracking: {
        getAliveRunId: vi.fn(() => 'run-1'),
      },
      configFacade: {
        readConfigSnapshot: vi.fn(async () => ({
          name: 'Team Alpha',
          projectPath: testProjectPath,
        })),
      },
      openCodeRuntimeDeliveryProofReader: {
        readProofIndex: vi.fn(async () => null),
      },
      appShellBoundary: {
        getMemberRuntimeAdvisoryInvalidator: vi.fn(() => invalidator),
        getMemberWorkSyncProofMissingRecoveryScheduler: vi.fn(() => proofRecoveryScheduler),
      },
      teamChangeEmitter: vi.fn((event) => {
        teamChanges.push(event);
      }),
      createOpenCodePromptDeliveryLedger: vi.fn(() => ledger),
      sendMessageToRun: vi.fn(async () => undefined),
    } as unknown as TeamProvisioningOpenCodeRuntimeDeliveryAdvisoryServiceHost<typeof run>;
    const addTeamNotification = vi.fn(async () => undefined);
    const logInfo = vi.fn();
    const logWarning = vi.fn();
    const getErrorMessage = vi.fn((error: unknown) =>
      error instanceof Error ? error.message : String(error)
    );

    const ports = createTeamProvisioningOpenCodeRuntimeDeliveryAdvisoryPortsFromService(service, {
      addTeamNotification,
      logInfo,
      logWarning,
      getErrorMessage,
    });

    expect(ports.createOpenCodePromptDeliveryLedger('team-a', 'lane-a')).toBe(ledger);
    await expect(ports.readProofIndex({} as never)).resolves.toBeNull();
    await expect(ports.readConfigSnapshot('team-a')).resolves.toMatchObject({
      name: 'Team Alpha',
    });
    await ports.addTeamNotification({ teamName: 'team-a' } as Parameters<
      OpenCodeRuntimeDeliveryAdvisoryPorts['addTeamNotification']
    >[0]);
    ports.emitTeamChange({ type: 'member-advisory', teamName: 'team-a' } as TeamChangeEvent);
    ports.invalidateMemberRuntimeAdvisory('team-a', 'builder');
    await ports.scheduleProofMissingWorkSyncRecovery?.({
      teamName: 'team-a',
      memberName: 'builder',
      originalMessageId: 'message-a',
    });
    expect(proofRecoveryScheduler).toHaveBeenCalledWith({
      teamName: 'team-a',
      memberName: 'builder',
      originalMessageId: 'message-a',
    });

    const sink = ports.getLeadNoticeSink('team-a');
    await sink?.send('check delivery');
    run.processKilled = true;

    expect(ports.getLeadNoticeSink('team-a')).toBeNull();
    expect(service.createOpenCodePromptDeliveryLedger).toHaveBeenCalledWith('team-a', 'lane-a');
    expect(service.openCodeRuntimeDeliveryProofReader.readProofIndex).toHaveBeenCalledWith({});
    expect(service.configFacade.readConfigSnapshot).toHaveBeenCalledWith('team-a');
    expect(addTeamNotification).toHaveBeenCalledWith({ teamName: 'team-a' });
    expect(teamChanges).toEqual([{ type: 'member-advisory', teamName: 'team-a' }]);
    expect(invalidator).toHaveBeenCalledWith('team-a', 'builder');
    expect(service.sendMessageToRun).toHaveBeenCalledWith(run, 'check delivery');
  });
});

function createPorts(
  overrides: Partial<OpenCodeRuntimeDeliveryAdvisoryPorts> & {
    ledgerRecords?: OpenCodePromptDeliveryLedgerRecord[];
  } = {}
): OpenCodeRuntimeDeliveryAdvisoryPorts {
  const ledgerRecords = overrides.ledgerRecords ?? [promptDeliveryRecord()];
  return {
    createOpenCodePromptDeliveryLedger: vi.fn(() => ({
      list: vi.fn().mockResolvedValue(ledgerRecords),
    })),
    readProofIndex: vi.fn().mockResolvedValue({
      getSnapshot: vi.fn(() => ({})),
    }),
    readConfigSnapshot: vi.fn().mockResolvedValue({
      name: 'Team Alpha',
      projectPath: testProjectPath,
    }),
    addTeamNotification: vi.fn().mockResolvedValue(undefined),
    emitTeamChange: vi.fn(),
    invalidateMemberRuntimeAdvisory: vi.fn(),
    scheduleProofMissingWorkSyncRecovery: vi.fn(),
    getLeadNoticeSink: vi.fn(() => null),
    logInfo: vi.fn(),
    logWarning: vi.fn(),
    getErrorMessage: (error) => (error instanceof Error ? error.message : String(error)),
    ...overrides,
  };
}

function promptDeliveryRecord(
  overrides: Partial<OpenCodePromptDeliveryLedgerRecord> = {}
): OpenCodePromptDeliveryLedgerRecord {
  return {
    id: 'delivery-1',
    teamName: 'team-a',
    memberName: 'builder',
    laneId: 'lane-builder',
    runId: 'run-1',
    runtimeSessionId: 'session-1',
    runtimePromptMessageId: 'runtime-message-1',
    runtimePromptMessageIds: ['runtime-message-1'],
    lastRuntimePromptMessageId: 'runtime-message-1',
    lastDeliveryAttemptIdWithAcceptedPrompt: 'attempt-1',
    inboxMessageId: 'message-1',
    inboxTimestamp: '2026-01-01T00:00:00.000Z',
    source: 'ui-send',
    messageKind: 'default',
    replyRecipient: 'user',
    actionMode: 'do',
    taskRefs: [{ teamName: 'team-a', taskId: 'task-1', displayId: '7' }],
    payloadHash: 'payload-hash',
    status: 'failed_terminal',
    responseState: 'tool_error',
    attempts: 1,
    maxAttempts: 3,
    sessionRefreshAttempts: 0,
    maxSessionRefreshAttempts: 5,
    lastSessionRefreshReason: null,
    acceptanceUnknown: false,
    nextAttemptAt: null,
    lastAttemptAt: '2026-01-01T00:00:00.000Z',
    lastObservedAt: '2026-01-01T00:00:00.000Z',
    acceptedAt: '2026-01-01T00:00:00.000Z',
    respondedAt: null,
    failedAt: '2026-01-01T00:00:00.000Z',
    inboxReadCommittedAt: null,
    inboxReadCommitError: null,
    prePromptCursor: null,
    postPromptCursor: null,
    deliveredUserMessageId: 'delivered-1',
    observedAssistantMessageId: null,
    observedAssistantPreview: null,
    observedToolCallNames: [],
    observedVisibleMessageId: null,
    visibleReplyMessageId: null,
    visibleReplyInbox: null,
    visibleReplyCorrelation: null,
    lastReason: 'tool_error',
    diagnostics: ['tool_error'],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}
