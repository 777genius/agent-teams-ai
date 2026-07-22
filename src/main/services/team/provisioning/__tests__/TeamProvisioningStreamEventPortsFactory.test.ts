import { describe, expect, it, vi } from 'vitest';

import {
  createTeamProvisioningStreamEventPorts,
  createTeamProvisioningStreamEventPortsBoundary,
  type TeamProvisioningStreamEventOutputRecoveryAdapter,
  type TeamProvisioningStreamEventPortCallbacks,
  type TeamProvisioningStreamEventPortsFactoryRun,
  type TeamProvisioningStreamEventServiceAdapter,
} from '../TeamProvisioningStreamEventPortsFactory';
import { handleTeamProvisioningStreamJsonMessage } from '../TeamProvisioningStreamEvents';

import type { TeamProvisioningProgress } from '@shared/types';

type TestRun = TeamProvisioningStreamEventPortsFactoryRun;

function createProgress(
  overrides: Partial<TeamProvisioningProgress> = {}
): TeamProvisioningProgress {
  return {
    state: 'assembling',
    message: 'starting',
    startedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as TeamProvisioningProgress;
}

function createRun(overrides: Partial<TestRun> = {}): TestRun {
  return {
    runId: 'run-1',
    teamName: 'atlas-hq',
    detectedSessionId: null,
    deterministicBootstrapMemberSpawnSeen: false,
    deterministicBootstrapMemberResultSeen: false,
    lastDeterministicBootstrapSeq: 0,
    requiresFirstRealTurnSuccess: false,
    provisioningComplete: false,
    cancelRequested: false,
    processKilled: false,
    progress: createProgress(),
    onProgress: vi.fn(),
    child: null,
    pendingMemberRestarts: new Map(),
    memberSpawnStatuses: new Map(),
    isLaunch: false,
    anthropicApiKeyHelper: null,
    leadRelayCapture: null,
    pendingToolCalls: [],
    liveLeadTextBuffer: null,
    silentUserDmForward: null,
    suppressPostCompactReminderOutput: false,
    pendingDirectCrossTeamSendRefresh: false,
    pendingPostCompactReminder: false,
    postCompactReminderInFlight: false,
    pendingGeminiPostLaunchHydration: false,
    geminiPostLaunchHydrationInFlight: false,
    suppressGeminiPostLaunchHydrationOutput: false,
    activeCrossTeamReplyHints: [],
    pendingInboxRelayCandidates: [],
    silentUserDmForwardClearHandle: null,
    leadContextUsage: null,
    apiRetryWarningIndex: null,
    provisioningOutputParts: [],
    lastRetryAt: 0,
    apiErrorWarningEmitted: false,
    provisioningTraceLines: [],
    lastProvisioningTraceKey: null,
    provisioningOutputIndexByMessageId: new Map(),
    stallWarningIndex: null,
    claudeLogLines: [],
    stdoutBuffer: '',
    stderrBuffer: '',
    request: {},
    ...overrides,
  } as TestRun;
}

function createCallbacks(
  overrides: Partial<TeamProvisioningStreamEventPortCallbacks<TestRun>> = {}
): TeamProvisioningStreamEventPortCallbacks<TestRun> {
  return {
    updateProgress: vi.fn((_run, state, message) => createProgress({ state, message })),
    resetLiveLeadTextBuffer: vi.fn(),
    handleTeammatePermissionRequest: vi.fn(),
    finishRuntimeToolActivity: vi.fn(),
    handleNativeTeammateUserMessage: vi.fn(),
    handleAuthFailureInOutput: vi.fn(),
    failProvisioningWithApiError: vi.fn(),
    appendProvisioningAssistantText: vi.fn(),
    pushLiveLeadTextMessage: vi.fn(),
    startRuntimeToolActivity: vi.fn(),
    getRunLeadName: vi.fn(() => 'Lead'),
    captureTeamSpawnEvents: vi.fn(),
    captureSendMessages: vi.fn(),
    emitLeadContextUsage: vi.fn(),
    resetRuntimeToolActivity: vi.fn(),
    setLeadActivity: vi.fn(),
    emitTeamChange: vi.fn(),
    pushLiveLeadProcessMessage: vi.fn(),
    injectPostCompactReminder: vi.fn(async () => undefined),
    injectGeminiPostLaunchHydration: vi.fn(async () => undefined),
    completeProvisioningFromSuccessfulResult: vi.fn(),
    handleControlRequest: vi.fn(),
    handleProvisioningTurnComplete: vi.fn(async () => undefined),
    cleanupRun: vi.fn(),
    emitApiErrorWarning: vi.fn(),
    setMemberSpawnStatus: vi.fn(),
    appendMemberBootstrapDiagnostic: vi.fn(),
    reevaluateMemberLaunchStatus: vi.fn(async () => undefined),
    invalidateRuntimeSnapshotCaches: vi.fn(),
    markUnconfirmedBootstrapMembersFailed: vi.fn(),
    stopPersistentTeamMembers: vi.fn(),
    persistLaunchStateSnapshot: vi.fn(async () => undefined),
    observeRuntimeFailure: vi.fn(),
    ...overrides,
  };
}

function createServiceAdapter(
  callbacks: TeamProvisioningStreamEventPortCallbacks<TestRun>
): TeamProvisioningStreamEventServiceAdapter<TestRun> {
  return {
    resetLiveLeadTextBuffer: callbacks.resetLiveLeadTextBuffer,
    handleTeammatePermissionRequest: callbacks.handleTeammatePermissionRequest,
    finishRuntimeToolActivity: callbacks.finishRuntimeToolActivity,
    handleNativeTeammateUserMessage: callbacks.handleNativeTeammateUserMessage,
    appendProvisioningAssistantText: callbacks.appendProvisioningAssistantText,
    pushLiveLeadTextMessage: callbacks.pushLiveLeadTextMessage,
    startRuntimeToolActivity: callbacks.startRuntimeToolActivity,
    getRunLeadName: callbacks.getRunLeadName,
    captureTeamSpawnEvents: callbacks.captureTeamSpawnEvents,
    captureSendMessages: callbacks.captureSendMessages,
    emitLeadContextUsage: callbacks.emitLeadContextUsage,
    resetRuntimeToolActivity: callbacks.resetRuntimeToolActivity,
    setLeadActivity: callbacks.setLeadActivity,
    pushLiveLeadProcessMessage: callbacks.pushLiveLeadProcessMessage,
    injectPostCompactReminder: callbacks.injectPostCompactReminder,
    injectGeminiPostLaunchHydration: callbacks.injectGeminiPostLaunchHydration,
    completeProvisioningFromSuccessfulResult: callbacks.completeProvisioningFromSuccessfulResult,
    handleControlRequest: callbacks.handleControlRequest,
    handleProvisioningTurnComplete: callbacks.handleProvisioningTurnComplete,
    cleanupRun: callbacks.cleanupRun,
    setMemberSpawnStatus: callbacks.setMemberSpawnStatus,
    appendMemberBootstrapDiagnostic: callbacks.appendMemberBootstrapDiagnostic,
    reevaluateMemberLaunchStatus: callbacks.reevaluateMemberLaunchStatus,
    invalidateRuntimeSnapshotCaches: callbacks.invalidateRuntimeSnapshotCaches,
    markUnconfirmedBootstrapMembersFailed: callbacks.markUnconfirmedBootstrapMembersFailed,
    observeRuntimeFailure: callbacks.observeRuntimeFailure,
    persistLaunchStateSnapshot: callbacks.persistLaunchStateSnapshot,
  };
}

function createOutputRecoveryAdapter(
  callbacks: TeamProvisioningStreamEventPortCallbacks<TestRun>
): TeamProvisioningStreamEventOutputRecoveryAdapter<TestRun> {
  return {
    handleAuthFailureInOutput: callbacks.handleAuthFailureInOutput,
    failProvisioningWithApiError: callbacks.failProvisioningWithApiError,
    emitApiErrorWarning: callbacks.emitApiErrorWarning,
  };
}

describe('TeamProvisioningStreamEventPortsFactory', () => {
  it('wires service callbacks and shared provisioning helpers into stream event ports', () => {
    const callbacks = createCallbacks();
    const ports = createTeamProvisioningStreamEventPorts(callbacks);
    const run = createRun({ claudeLogLines: ['first', 'second'] });

    expect(ports.updateProgress(run, 'finalizing', 'done')).toEqual(
      createProgress({ state: 'finalizing', message: 'done' })
    );
    ports.resetLiveLeadTextBuffer(run);
    ports.observeRuntimeFailure(run, {
      phase: 'terminal',
      detail: 'runtime stopped',
      observedAt: '2026-01-01T00:00:01.000Z',
    });
    ports.emitTeamChange({ type: 'inbox', teamName: 'atlas-hq', detail: 'user.json' });

    expect(callbacks.updateProgress).toHaveBeenCalledWith(run, 'finalizing', 'done');
    expect(callbacks.resetLiveLeadTextBuffer).toHaveBeenCalledWith(run);
    expect(callbacks.observeRuntimeFailure).toHaveBeenCalledWith(run, {
      phase: 'terminal',
      detail: 'runtime stopped',
      observedAt: '2026-01-01T00:00:01.000Z',
    });
    expect(callbacks.emitTeamChange).toHaveBeenCalledWith({
      type: 'inbox',
      teamName: 'atlas-hq',
      detail: 'user.json',
    });
    expect(ports.extractCliLogsFromRun(run)).toBe('first\nsecond');
  });

  it('builds stream event ports from a service adapter boundary', () => {
    const callbacks = createCallbacks();
    const emitTeamChange = vi.fn();
    const ports = createTeamProvisioningStreamEventPortsBoundary({
      service: createServiceAdapter(callbacks),
      persistentRuntimeCleanup: {
        stopPersistentTeamMembers: callbacks.stopPersistentTeamMembers,
      },
      outputRecovery: createOutputRecoveryAdapter(callbacks),
      updateProgress: callbacks.updateProgress,
      emitTeamChange,
    });
    const run = createRun();

    ports.setLeadActivity(run, 'active');
    ports.observeRuntimeFailure(run, {
      phase: 'sdk_retrying',
      detail: 'rate limited',
      observedAt: '2026-01-01T00:00:02.000Z',
      statusCode: 429,
      retryAfterMs: 1_000,
    });
    ports.emitTeamChange({ type: 'task', teamName: 'atlas-hq' });
    ports.pushLiveLeadProcessMessage('atlas-hq', {
      messageId: 'msg-1',
      from: 'lead',
      to: 'user',
      text: 'hello',
      timestamp: '2026-01-01T00:00:00.000Z',
      read: false,
    });

    expect(callbacks.setLeadActivity).toHaveBeenCalledWith(run, 'active');
    expect(callbacks.observeRuntimeFailure).toHaveBeenCalledWith(run, {
      phase: 'sdk_retrying',
      detail: 'rate limited',
      observedAt: '2026-01-01T00:00:02.000Z',
      statusCode: 429,
      retryAfterMs: 1_000,
    });
    expect(emitTeamChange).toHaveBeenCalledWith({ type: 'task', teamName: 'atlas-hq' });
    expect(callbacks.pushLiveLeadProcessMessage).toHaveBeenCalledWith('atlas-hq', {
      messageId: 'msg-1',
      from: 'lead',
      to: 'user',
      text: 'hello',
      timestamp: '2026-01-01T00:00:00.000Z',
      read: false,
    });
  });

  it('keeps assistant stream-json behavior routed through the extracted service boundary', () => {
    const callbacks = createCallbacks();
    const ports = createTeamProvisioningStreamEventPortsBoundary({
      service: createServiceAdapter(callbacks),
      persistentRuntimeCleanup: {
        stopPersistentTeamMembers: callbacks.stopPersistentTeamMembers,
      },
      outputRecovery: createOutputRecoveryAdapter(callbacks),
      updateProgress: callbacks.updateProgress,
    });
    const run = createRun();
    const msg = {
      type: 'assistant',
      content: [{ type: 'text', text: 'Ready to coordinate' }],
    };

    handleTeamProvisioningStreamJsonMessage(run, msg, ports);

    expect(callbacks.handleAuthFailureInOutput).toHaveBeenCalledWith(
      run,
      'Ready to coordinate',
      'assistant'
    );
    expect(callbacks.appendProvisioningAssistantText).toHaveBeenCalledWith(
      run,
      msg,
      'Ready to coordinate'
    );
    expect(callbacks.pushLiveLeadTextMessage).toHaveBeenCalledWith(
      run,
      'Ready to coordinate',
      undefined,
      undefined,
      { coalesceStreamChunk: false }
    );
    expect(callbacks.captureTeamSpawnEvents).toHaveBeenCalledWith(run, msg.content);
    expect(callbacks.captureSendMessages).toHaveBeenCalledWith(run, msg.content);
  });
});
