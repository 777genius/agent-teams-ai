import { setMemberSpawnStatusForRun } from '@main/services/team/provisioning/TeamProvisioningMemberSpawnSnapshots';
import {
  extractStreamContentBlocks,
  extractStreamUserText,
  getStableLeadThoughtMessageId,
  handleDeterministicBootstrapEvent,
  handleTeamProvisioningStreamJsonMessage,
  hasCapturedUserVisibleSendMessage,
  hasCapturedVisibleSendMessage,
  shouldAcceptDeterministicBootstrapEvent,
  type TeamProvisioningStreamEventPorts,
  type TeamProvisioningStreamRun,
} from '@main/services/team/provisioning/TeamProvisioningStreamEvents';
import { describe, expect, it, vi } from 'vitest';

import type {
  MemberSpawnStatus,
  MemberSpawnStatusEntry,
  TeamProvisioningProgress,
} from '@shared/types';

const NOW = '2026-05-12T10:00:00.000Z';

type DeterministicBootstrapTestRun = Omit<TeamProvisioningStreamRun, 'pendingMemberRestarts'> & {
  expectedMembers: string[];
  pendingMemberRestarts: Map<string, { requestedAt?: string }>;
};

function createMemberSpawnStatusEntry(
  overrides: Partial<MemberSpawnStatusEntry> = {}
): MemberSpawnStatusEntry {
  return {
    status: 'waiting',
    launchState: 'runtime_pending_bootstrap',
    updatedAt: NOW,
    runtimeAlive: false,
    bootstrapConfirmed: false,
    hardFailure: false,
    agentToolAccepted: true,
    firstSpawnAcceptedAt: NOW,
    ...overrides,
  } as MemberSpawnStatusEntry;
}

function createProgress(runId: string, teamName: string): TeamProvisioningProgress {
  return {
    runId,
    teamName,
    state: 'assembling',
    message: 'Spawning teammate runtimes',
    startedAt: NOW,
    updatedAt: NOW,
  } as TeamProvisioningProgress;
}

function createDeterministicBootstrapRun(overrides: Partial<DeterministicBootstrapTestRun> = {}): {
  run: DeterministicBootstrapTestRun;
  progressUpdates: TeamProvisioningProgress[];
} {
  const runId = overrides.runId ?? 'run-bootstrap-1';
  const teamName = overrides.teamName ?? 'nice-team';
  const progressUpdates: TeamProvisioningProgress[] = [];
  const run = {
    runId,
    teamName,
    detectedSessionId: null,
    deterministicBootstrapMemberSpawnSeen: false,
    deterministicBootstrapMemberResultSeen: false,
    lastDeterministicBootstrapSeq: 0,
    requiresFirstRealTurnSuccess: false,
    provisioningComplete: false,
    cancelRequested: false,
    processKilled: false,
    progress: createProgress(runId, teamName),
    onProgress: (progress: TeamProvisioningProgress) => {
      progressUpdates.push(progress);
    },
    child: null,
    pendingMemberRestarts: new Map<string, { requestedAt?: string }>(),
    memberSpawnStatuses: new Map<string, MemberSpawnStatusEntry>([
      ['alice', createMemberSpawnStatusEntry()],
    ]),
    expectedMembers: ['alice'],
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
  } as DeterministicBootstrapTestRun;

  return { run, progressUpdates };
}

function createStreamEventPorts(): {
  ports: TeamProvisioningStreamEventPorts<DeterministicBootstrapTestRun>;
  invalidateRuntimeSnapshotCaches: ReturnType<typeof vi.fn>;
  killTeamProcess: ReturnType<typeof vi.fn>;
  markUnconfirmedBootstrapMembersFailed: ReturnType<typeof vi.fn>;
  persistLaunchStateSnapshot: ReturnType<typeof vi.fn>;
  cleanupRun: ReturnType<typeof vi.fn>;
  reevaluateMemberLaunchStatus: ReturnType<typeof vi.fn>;
} {
  const invalidateRuntimeSnapshotCaches = vi.fn();
  const killTeamProcess = vi.fn();
  const markUnconfirmedBootstrapMembersFailed = vi.fn();
  const persistLaunchStateSnapshot = vi.fn(async () => null);
  const cleanupRun = vi.fn();
  const reevaluateMemberLaunchStatus = vi.fn(async () => undefined);

  const ports = {
    updateProgress: (
      run: DeterministicBootstrapTestRun,
      state: TeamProvisioningProgress['state'],
      message: string,
      extras?: Partial<TeamProvisioningProgress>
    ) => {
      const progress = {
        ...run.progress,
        state,
        message,
        updatedAt: NOW,
        ...extras,
      } as TeamProvisioningProgress;
      run.progress = progress;
      return progress;
    },
    extractCliLogsFromRun: () => undefined,
    setMemberSpawnStatus: (
      run: DeterministicBootstrapTestRun,
      memberName: string,
      status: MemberSpawnStatus,
      error?: string
    ) => {
      setMemberSpawnStatusForRun(
        {
          run,
          memberName,
          status,
          error,
        },
        {
          nowIso: () => NOW,
          syncMemberTaskActivityForRuntimeTransition: () => {},
          syncMemberLaunchGraceCheck: () => {},
          updateLaunchDiagnostics: () => {},
          appendMemberBootstrapDiagnostic: () => {},
          isCurrentTrackedRun: () => true,
          emitMemberSpawnChange: () => {},
          persistLaunchStateSnapshot: async () => null,
          reportBackgroundPersistenceError: () => {},
        }
      );
    },
    appendMemberBootstrapDiagnostic: vi.fn(),
    reevaluateMemberLaunchStatus,
    invalidateRuntimeSnapshotCaches,
    markUnconfirmedBootstrapMembersFailed,
    stopPersistentTeamMembers: vi.fn(),
    killTeamProcess,
    persistLaunchStateSnapshot,
    cleanupRun,
    handleProvisioningTurnComplete: vi.fn(async () => undefined),
  } as Partial<
    TeamProvisioningStreamEventPorts<DeterministicBootstrapTestRun>
  > as TeamProvisioningStreamEventPorts<DeterministicBootstrapTestRun>;

  return {
    ports,
    invalidateRuntimeSnapshotCaches,
    killTeamProcess,
    markUnconfirmedBootstrapMembersFailed,
    persistLaunchStateSnapshot,
    cleanupRun,
    reevaluateMemberLaunchStatus,
  };
}

describe('TeamProvisioningStreamEvents', () => {
  it('extracts user text from top-level and nested stream content', () => {
    expect(
      extractStreamUserText({
        type: 'user',
        content: [{ type: 'text', text: 'hello' }],
      })
    ).toBe('hello');

    expect(
      extractStreamUserText({
        type: 'user',
        message: {
          content: [
            { type: 'text', text: 'first' },
            { type: 'tool_result', content: 'ignored' },
            { type: 'text', text: 'second' },
          ],
        },
      })
    ).toBe('first\nsecond');
  });

  it('extracts assistant content blocks from supported stream envelopes', () => {
    const topLevel = [{ type: 'text', text: 'ready' }];
    expect(extractStreamContentBlocks({ type: 'assistant', content: topLevel })).toEqual(topLevel);

    const nested = [{ type: 'tool_use', name: 'SendMessage' }];
    expect(
      extractStreamContentBlocks({
        type: 'assistant',
        message: { content: nested },
      })
    ).toEqual(nested);
  });

  it('detects visible SendMessage tool calls and user-visible destinations', () => {
    const content = [
      {
        type: 'tool_use',
        name: 'SendMessage',
        input: { recipient: 'user', content: 'Launch complete' },
      },
    ];

    expect(hasCapturedVisibleSendMessage(content, 'atlas-hq')).toBe(true);
    expect(hasCapturedUserVisibleSendMessage(content, 'atlas-hq')).toBe(true);
  });

  it('builds stable lead thought ids from stream metadata', () => {
    expect(getStableLeadThoughtMessageId({ uuid: 'entry-1' })).toBe('lead-thought-entry-1');
    expect(getStableLeadThoughtMessageId({ message: { id: 'msg-1' } })).toBe(
      'lead-thought-msg-msg-1'
    );
  });

  it('filters deterministic bootstrap events by run, team, and monotonic sequence', () => {
    const base = {
      runId: 'run-1',
      teamName: 'atlas-hq',
      lastSeq: 4,
    };

    expect(
      shouldAcceptDeterministicBootstrapEvent({
        ...base,
        msg: { run_id: 'run-2', team_name: 'atlas-hq', seq: 5 },
      })
    ).toEqual({ accept: false, nextSeq: 4 });
    expect(
      shouldAcceptDeterministicBootstrapEvent({
        ...base,
        msg: { run_id: 'run-1', team_name: 'other', seq: 5 },
      })
    ).toEqual({ accept: false, nextSeq: 4 });
    expect(
      shouldAcceptDeterministicBootstrapEvent({
        ...base,
        msg: { run_id: 'run-1', team_name: 'atlas-hq', seq: 4 },
      })
    ).toEqual({ accept: false, nextSeq: 4 });
    expect(
      shouldAcceptDeterministicBootstrapEvent({
        ...base,
        msg: { run_id: 'run-1', team_name: 'atlas-hq', seq: 3 },
      })
    ).toEqual({ accept: false, nextSeq: 4 });
    expect(
      shouldAcceptDeterministicBootstrapEvent({
        ...base,
        msg: { run_id: 'run-1', team_name: 'atlas-hq', seq: 5 },
      })
    ).toEqual({ accept: true, nextSeq: 5 });
  });

  it('fails a pending restart when deterministic bootstrap reports already_running', () => {
    const { run } = createDeterministicBootstrapRun();
    run.pendingMemberRestarts.set('alice', { requestedAt: NOW });
    const { ports, invalidateRuntimeSnapshotCaches, reevaluateMemberLaunchStatus } =
      createStreamEventPorts();

    const handled = handleDeterministicBootstrapEvent(
      run,
      {
        type: 'system',
        subtype: 'team_bootstrap',
        event: 'member_spawn_result',
        member_name: 'alice',
        outcome: 'already_running',
        run_id: run.runId,
        team_name: run.teamName,
        seq: 1,
      },
      ports
    );

    expect(handled).toBe(true);
    expect(run.pendingMemberRestarts.has('alice')).toBe(false);
    expect(run.memberSpawnStatuses.get('alice')).toMatchObject({
      status: 'error',
      launchState: 'failed_to_start',
      hardFailure: true,
      hardFailureReason:
        'Restart for teammate "alice" was skipped because the previous runtime still appears to be active. The requested settings may not have been applied.',
    });
    expect(invalidateRuntimeSnapshotCaches).not.toHaveBeenCalled();
    expect(reevaluateMemberLaunchStatus).not.toHaveBeenCalled();
  });

  it('clears a pending restart when deterministic bootstrap reports a hard failure', () => {
    const { run } = createDeterministicBootstrapRun();
    run.pendingMemberRestarts.set('alice', { requestedAt: NOW });
    const { ports } = createStreamEventPorts();

    const handled = handleDeterministicBootstrapEvent(
      run,
      {
        type: 'system',
        subtype: 'team_bootstrap',
        event: 'member_spawn_result',
        member_name: 'alice',
        outcome: 'failed',
        reason: 'spawn failed hard',
        run_id: run.runId,
        team_name: run.teamName,
        seq: 1,
      },
      ports
    );

    expect(handled).toBe(true);
    expect(run.pendingMemberRestarts.has('alice')).toBe(false);
    expect(run.memberSpawnStatuses.get('alice')).toMatchObject({
      status: 'error',
      launchState: 'failed_to_start',
      hardFailure: true,
      hardFailureReason: 'spawn failed hard',
    });
  });

  it('reports workspace trust deterministic bootstrap failures through stream events', () => {
    const reason =
      'Teammate "Gayani" cannot start in headless process runtime because workspace trust is not accepted for "C:\\Users\\vilok\\OneDrive\\Desktop\\Safar 0.1". Open that workspace once interactively and accept trust, then launch the team again.';
    const { run, progressUpdates } = createDeterministicBootstrapRun({
      runId: 'run-workspace-trust-bootstrap',
      teamName: 'workspace-trust-bootstrap-team',
      expectedMembers: ['Gayani'],
      memberSpawnStatuses: new Map([['Gayani', createMemberSpawnStatusEntry()]]),
    });
    const {
      ports,
      killTeamProcess,
      markUnconfirmedBootstrapMembersFailed,
      persistLaunchStateSnapshot,
      cleanupRun,
    } = createStreamEventPorts();

    const handled = handleDeterministicBootstrapEvent(
      run,
      {
        type: 'system',
        subtype: 'team_bootstrap',
        event: 'failed',
        reason,
        run_id: run.runId,
        team_name: run.teamName,
        seq: 1,
      },
      ports
    );

    expect(handled).toBe(true);
    expect(progressUpdates.at(-1)).toMatchObject({
      state: 'failed',
      message: 'Workspace trust required',
      error: reason,
    });
    expect(markUnconfirmedBootstrapMembersFailed).toHaveBeenCalledWith(run, reason, {
      cleanupRequested: false,
    });
    expect(run.processKilled).toBe(true);
    expect(killTeamProcess).toHaveBeenCalledWith(null);
    expect(persistLaunchStateSnapshot).toHaveBeenCalledWith(run, 'finished');
    expect(cleanupRun).toHaveBeenCalledWith(run);
  });
});

describe('handleTeamProvisioningStreamJsonMessage result handling', () => {
  function makeResultPorts(): TeamProvisioningStreamEventPorts<DeterministicBootstrapTestRun> & {
    killTeamProcess: ReturnType<typeof vi.fn>;
    cleanupRun: ReturnType<typeof vi.fn>;
  } {
    const base = createStreamEventPorts();
    const ports = {
      ...(base.ports as unknown as Record<string, unknown>),
      resetLiveLeadTextBuffer: vi.fn(),
      completeProvisioningFromSuccessfulResult: vi.fn(),
    } as unknown as TeamProvisioningStreamEventPorts<DeterministicBootstrapTestRun>;
    return Object.assign(ports, {
      killTeamProcess: base.killTeamProcess,
      cleanupRun: base.cleanupRun,
    });
  }

  // logger.warn (on the error path) is routed to the globally-guarded console.warn; clear the
  // recorded, intentional warning so the setup afterEach guard does not flag it.
  function clearExpectedWarnings(): void {
    (console.warn as unknown as { mockClear?: () => void }).mockClear?.();
  }

  // Any non-success result subtype is a turn-ending failure. error_during_execution and
  // error_max_turns must be handled like plain 'error' (fail + kill + cleanup the run),
  // not fall through and hang the turn (relay capture never settles, provisioning never
  // completes, lead stuck 'active').
  for (const subtype of ['error', 'error_during_execution', 'error_max_turns']) {
    it(`fails and tears down the run for result subtype "${subtype}"`, () => {
      const { run } = createDeterministicBootstrapRun({ provisioningComplete: false });
      const ports = makeResultPorts();

      handleTeamProvisioningStreamJsonMessage(run, { type: 'result', subtype, error: 'boom' }, ports);

      expect(run.progress.state).toBe('failed');
      expect(ports.killTeamProcess).toHaveBeenCalledWith(run.child);
      expect(ports.cleanupRun).toHaveBeenCalledWith(run);
      clearExpectedWarnings();
    });
  }

  it('does not fail the run for result subtype "success"', () => {
    const { run } = createDeterministicBootstrapRun({ provisioningComplete: false });
    const ports = makeResultPorts();

    handleTeamProvisioningStreamJsonMessage(run, { type: 'result', subtype: 'success' }, ports);

    expect(run.progress.state).not.toBe('failed');
    expect(ports.killTeamProcess).not.toHaveBeenCalled();
    expect(ports.cleanupRun).not.toHaveBeenCalled();
    clearExpectedWarnings();
  });
});
