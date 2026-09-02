import { describe, expect, it, vi } from 'vitest';

import {
  handleTeamProvisioningStreamJsonMessage,
  type TeamProvisioningStreamEventPorts,
  type TeamProvisioningStreamRun,
} from '../TeamProvisioningStreamEvents';

import type { TeamProvisioningProgress } from '@shared/types';

const NOW = '2026-09-01T10:00:00.000Z';

function createRun(overrides: Partial<TeamProvisioningStreamRun> = {}): TeamProvisioningStreamRun {
  return {
    runId: 'run-1',
    teamName: 'alpha',
    detectedSessionId: 'session-1',
    deterministicBootstrapMemberSpawnSeen: false,
    deterministicBootstrapMemberResultSeen: false,
    lastDeterministicBootstrapSeq: 0,
    requiresFirstRealTurnSuccess: false,
    provisioningComplete: true,
    cancelRequested: false,
    processKilled: false,
    progress: {
      runId: 'run-1',
      teamName: 'alpha',
      state: 'ready',
      message: 'ready',
      startedAt: NOW,
      updatedAt: NOW,
    } as TeamProvisioningProgress,
    onProgress: () => {},
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
    ...overrides,
  } as TeamProvisioningStreamRun;
}

function createPorts(): TeamProvisioningStreamEventPorts<TeamProvisioningStreamRun> {
  return {
    resetLiveLeadTextBuffer: vi.fn(),
    finishRuntimeToolActivity: vi.fn(),
    startRuntimeToolActivity: vi.fn(),
    getRunLeadName: vi.fn(() => 'lead'),
    handleNativeTeammateUserMessage: vi.fn(),
    handleTeammatePermissionRequest: vi.fn(),
    handleAuthFailureInOutput: vi.fn(),
    hasApiError: vi.fn(() => false),
    isAuthFailureWarning: vi.fn(() => false),
    failProvisioningWithApiError: vi.fn(),
    appendProvisioningAssistantText: vi.fn(),
    boundProgressAssistantParts: vi.fn((parts: string[]) => parts),
    pushLiveLeadTextMessage: vi.fn(),
    captureTeamSpawnEvents: vi.fn(),
    captureSendMessages: vi.fn(),
    updateLeadContextUsageFromUsage: vi.fn(),
    emitLeadContextUsage: vi.fn(),
  } as Partial<
    TeamProvisioningStreamEventPorts<TeamProvisioningStreamRun>
  > as TeamProvisioningStreamEventPorts<TeamProvisioningStreamRun>;
}

function createCapture(
  touch: () => void
): NonNullable<TeamProvisioningStreamRun['leadRelayCapture']> {
  return {
    textParts: [],
    settled: false,
    idleHandle: null,
    idleMs: 800,
    touch,
    resolveOnce: vi.fn(),
    rejectOnce: vi.fn(),
  };
}

function toolResultMessage(): Record<string, unknown> {
  return {
    type: 'user',
    message: {
      content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok', is_error: false }],
    },
  };
}

function assistantMessage(): Record<string, unknown> {
  return {
    type: 'assistant',
    message: { id: 'assistant-1', content: [{ type: 'text', text: 'Working on it.' }] },
  };
}

describe('lead relay capture activity proof', () => {
  it('touches the capture when the lead stream reports a tool result', () => {
    const touch = vi.fn();
    const run = createRun({ leadRelayCapture: createCapture(touch) });

    handleTeamProvisioningStreamJsonMessage(run, toolResultMessage(), createPorts());

    expect(touch).toHaveBeenCalledTimes(1);
  });

  it('touches the capture when the lead stream reports an assistant message', () => {
    const touch = vi.fn();
    const run = createRun({ leadRelayCapture: createCapture(touch) });

    handleTeamProvisioningStreamJsonMessage(run, assistantMessage(), createPorts());

    expect(touch).toHaveBeenCalledTimes(1);
  });

  it('handles the same stream events without a capture and without throwing', () => {
    const run = createRun({ leadRelayCapture: null });
    const ports = createPorts();

    expect(() => {
      handleTeamProvisioningStreamJsonMessage(run, toolResultMessage(), ports);
      handleTeamProvisioningStreamJsonMessage(run, assistantMessage(), ports);
    }).not.toThrow();
    expect(run.leadRelayCapture).toBeNull();
  });
});
