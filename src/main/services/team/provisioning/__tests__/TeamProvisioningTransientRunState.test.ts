import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  PROGRESS_RETAINED_LOG_CHARS,
  PROGRESS_RETAINED_LOG_LINE_CHARS,
  PROGRESS_RETAINED_LOG_LINES,
} from '../../progressPayload';
import {
  createTeamProvisioningTransientRunStatePorts,
  createTeamProvisioningTransientRunStatePortsFromService,
  type TeamProvisioningCliLogRun,
  TeamProvisioningTransientRunState,
  type TeamProvisioningTransientRunStatePorts,
  type TeamProvisioningTransientRunStateServiceHost,
} from '../TeamProvisioningTransientRunState';

type FakeTimer = ReturnType<typeof setTimeout> & {
  fire(): void;
  ms: number;
  unref: ReturnType<typeof vi.fn>;
};

function makeTimer(handler: () => void, ms = 0): FakeTimer {
  return {
    fire: handler,
    ms,
    unref: vi.fn(),
  } as unknown as FakeTimer;
}

function makeLogRun(): TeamProvisioningCliLogRun {
  return {
    claudeLogLines: [],
    stdoutLogLineBuf: '',
    stderrLogLineBuf: '',
  };
}

function totalStringChars(values: readonly string[]): number {
  return values.reduce((sum, value) => sum + value.length, 0);
}

function makePorts(
  overrides: Partial<TeamProvisioningTransientRunStatePorts> = {}
): TeamProvisioningTransientRunStatePorts {
  return createTeamProvisioningTransientRunStatePorts({
    pendingTimeouts: new Map(),
    teamOpLocks: new Map(),
    cancelPendingAutoResume: vi.fn(),
    clearOpenCodeRuntimeToolApprovals: vi.fn(),
    invalidateRuntimeSnapshotCaches: vi.fn(),
    clearRuntimeProcessRowsForTeam: vi.fn(),
    retainedClaudeLogsByTeam: new Map(),
    persistedTranscriptClaudeLogs: { invalidate: vi.fn() },
    leadInboxRelayInFlight: new Map(),
    relayedLeadInboxMessageIds: new Map(),
    leadRecoveryMessageIds: new Map(),
    successfulLeadRecoveryMessageIds: new Map(),
    pendingCrossTeamFirstReplies: new Map(),
    recentCrossTeamLeadDeliveryMessageIds: new Map(),
    recentSameTeamNativeFingerprints: new Map(),
    memberInboxRelayInFlight: new Map(),
    openCodeMemberInboxRelayInFlight: new Map(),
    openCodeMemberSendInFlightByLane: new Map(),
    openCodePromptDeliveryWatchdogScheduler: { cancelTeam: vi.fn() },
    openCodeRuntimeDeliveryAdvisory: { cancelTeam: vi.fn() },
    relayedMemberInboxMessageIds: new Map(),
    liveLeadProcessMessages: new Map(),
    relayLeadInboxMessages: vi.fn().mockResolvedValue(0),
    warn: vi.fn(),
    nowMs: () => Date.parse('2026-01-02T03:04:05.000Z'),
    ...overrides,
  });
}

describe('TeamProvisioningTransientRunState', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('builds transient run state ports from service-shaped dependencies', async () => {
    const pendingTimeouts = new Map<string, ReturnType<typeof setTimeout>>();
    const teamOpLocks = new Map<string, Promise<void>>();
    const cancelPendingAutoResume = vi.fn();
    const warn = vi.fn();
    const relayLeadInboxMessages = vi.fn().mockResolvedValue(1);
    const service = {
      pendingTimeouts,
      teamOpLocks,
      toolApprovalFacade: {
        clearOpenCodeRuntimeToolApprovals: vi.fn(),
      },
      invalidateRuntimeSnapshotCaches: vi.fn(),
      runtimeResourceSampling: {
        clearRuntimeProcessRowsForTeam: vi.fn(),
      },
      retainedClaudeLogsByTeam: new Map(),
      bootstrapTranscriptFacade: {
        invalidatePersistedTranscriptClaudeLogs: vi.fn(),
      },
      leadInboxRelayInFlight: new Map(),
      relayedLeadInboxMessageIds: new Map(),
      leadRecoveryMessageIds: new Map(),
      successfulLeadRecoveryMessageIds: new Map(),
      pendingCrossTeamFirstReplies: new Map(),
      recentCrossTeamLeadDeliveryMessageIds: new Map(),
      sameTeamNativeDelivery: new Map(),
      memberInboxRelayInFlight: new Map(),
      openCodeMemberInboxRelayInFlight: new Map(),
      openCodeMemberSendInFlightByLane: new Map(),
      openCodePromptDeliveryWatchdogScheduler: { cancelTeam: vi.fn() },
      openCodeRuntimeDeliveryAdvisory: { cancelTeam: vi.fn() },
      relayedMemberInboxMessageIds: new Map(),
      liveLeadProcessMessages: new Map(),
      relayLeadInboxMessages,
    } satisfies TeamProvisioningTransientRunStateServiceHost;
    const ports = createTeamProvisioningTransientRunStatePortsFromService(service, {
      cancelPendingAutoResume,
      warn,
      nowMs: () => 42,
    });

    ports.cancelPendingAutoResume('alpha');
    ports.clearOpenCodeRuntimeToolApprovals('alpha', { emitDismiss: true });
    ports.invalidateRuntimeSnapshotCaches('alpha');
    ports.clearRuntimeProcessRowsForTeam('alpha');
    ports.persistedTranscriptClaudeLogs.invalidate('alpha');
    await ports.relayLeadInboxMessages('alpha');
    ports.warn('careful');

    expect(ports.pendingTimeouts).toBe(pendingTimeouts);
    expect(ports.teamOpLocks).toBe(teamOpLocks);
    expect(ports.retainedClaudeLogsByTeam).toBe(service.retainedClaudeLogsByTeam);
    expect(ports.recentSameTeamNativeFingerprints).toBe(service.sameTeamNativeDelivery);
    expect(ports.nowMs()).toBe(42);
    expect(cancelPendingAutoResume).toHaveBeenCalledWith('alpha');
    expect(service.toolApprovalFacade.clearOpenCodeRuntimeToolApprovals).toHaveBeenCalledWith(
      'alpha',
      { emitDismiss: true }
    );
    expect(service.invalidateRuntimeSnapshotCaches).toHaveBeenCalledWith('alpha');
    expect(service.runtimeResourceSampling.clearRuntimeProcessRowsForTeam).toHaveBeenCalledWith(
      'alpha'
    );
    expect(
      service.bootstrapTranscriptFacade.invalidatePersistedTranscriptClaudeLogs
    ).toHaveBeenCalledWith('alpha');
    expect(relayLeadInboxMessages).toHaveBeenCalledWith('alpha');
    expect(warn).toHaveBeenCalledWith('careful');
  });

  it('clears same-team retry timers from the shared timeout map', () => {
    const clearTimeout = vi.fn();
    const ports = makePorts({ clearTimeout });
    const deferred = makeTimer(() => undefined);
    const persist = makeTimer(() => undefined);
    const other = makeTimer(() => undefined);
    ports.pendingTimeouts.set('same-team-deferred:alpha', deferred);
    ports.pendingTimeouts.set('same-team-persist:alpha', persist);
    ports.pendingTimeouts.set('same-team-deferred:beta', other);

    new TeamProvisioningTransientRunState(ports).clearSameTeamRetryTimers('alpha');

    expect(clearTimeout).toHaveBeenCalledWith(deferred);
    expect(clearTimeout).toHaveBeenCalledWith(persist);
    expect(ports.pendingTimeouts.has('same-team-deferred:alpha')).toBe(false);
    expect(ports.pendingTimeouts.has('same-team-persist:alpha')).toBe(false);
    expect(ports.pendingTimeouts.get('same-team-deferred:beta')).toBe(other);
  });

  it('schedules one unrefed lead inbox follow-up relay and deletes it after firing', async () => {
    const scheduled: FakeTimer[] = [];
    const relayLeadInboxMessages = vi.fn().mockResolvedValue(1);
    const ports = makePorts({
      relayLeadInboxMessages,
      setTimeout: (handler, ms) => {
        const timer = makeTimer(handler, ms);
        scheduled.push(timer);
        return timer;
      },
    });
    const state = new TeamProvisioningTransientRunState(ports);

    state.scheduleLeadInboxFollowUpRelay('alpha');
    state.scheduleLeadInboxFollowUpRelay('alpha');

    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]?.ms).toBe(50);
    expect(scheduled[0]?.unref).toHaveBeenCalledTimes(1);
    expect(ports.pendingTimeouts.has('lead-inbox-follow-up:alpha')).toBe(true);

    scheduled[0]?.fire();
    await Promise.resolve();

    expect(ports.pendingTimeouts.has('lead-inbox-follow-up:alpha')).toBe(false);
    expect(relayLeadInboxMessages).toHaveBeenCalledWith('alpha');
  });

  it('resets only team-scoped transient maps for a new run', () => {
    const clearTimeout = vi.fn();
    const ports = makePorts({ clearTimeout });
    const timer = makeTimer(() => undefined);
    ports.pendingTimeouts.set('same-team-deferred:alpha', timer);
    ports.pendingTimeouts.set('lead-inbox-follow-up:alpha', timer);
    ports.pendingTimeouts.set(
      'same-team-deferred:beta',
      makeTimer(() => undefined)
    );
    (ports.retainedClaudeLogsByTeam as Map<string, unknown>).set('alpha', {});
    (ports.leadInboxRelayInFlight as Map<string, unknown>).set('alpha', {});
    (ports.relayedLeadInboxMessageIds as Map<string, unknown>).set('alpha', {});
    (ports.leadRecoveryMessageIds as Map<string, unknown>).set('alpha', {});
    (ports.successfulLeadRecoveryMessageIds as Map<string, unknown>).set('alpha', {});
    (ports.pendingCrossTeamFirstReplies as Map<string, unknown>).set('alpha', {});
    (ports.recentCrossTeamLeadDeliveryMessageIds as Map<string, unknown>).set('alpha', {});
    (ports.recentSameTeamNativeFingerprints as Map<string, unknown>).set('alpha', {});
    (ports.memberInboxRelayInFlight as Map<string, unknown>).set('alpha:dev', {});
    (ports.memberInboxRelayInFlight as Map<string, unknown>).set('beta:dev', {});
    (ports.openCodeMemberInboxRelayInFlight as Map<string, unknown>).set('opencode:alpha:dev', {});
    (ports.openCodeMemberInboxRelayInFlight as Map<string, unknown>).set('opencode:beta:dev', {});
    (ports.openCodeMemberSendInFlightByLane as Map<string, unknown>).set(
      'opencode-send:alpha:lane',
      {}
    );
    (ports.openCodeMemberSendInFlightByLane as Map<string, unknown>).set(
      'opencode-send:beta:lane',
      {}
    );
    (ports.relayedMemberInboxMessageIds as Map<string, unknown>).set('alpha:dev', {});
    (ports.relayedMemberInboxMessageIds as Map<string, unknown>).set('beta:dev', {});
    (ports.liveLeadProcessMessages as Map<string, unknown>).set('alpha', {});

    new TeamProvisioningTransientRunState(ports).resetTeamScopedTransientStateForNewRun('alpha');

    expect(ports.cancelPendingAutoResume).toHaveBeenCalledWith('alpha');
    expect(ports.clearOpenCodeRuntimeToolApprovals).toHaveBeenCalledWith('alpha', {
      emitDismiss: true,
    });
    expect(ports.invalidateRuntimeSnapshotCaches).toHaveBeenCalledWith('alpha');
    expect(ports.persistedTranscriptClaudeLogs.invalidate).toHaveBeenCalledWith('alpha');
    expect(ports.openCodePromptDeliveryWatchdogScheduler.cancelTeam).toHaveBeenCalledWith('alpha');
    expect(ports.openCodeRuntimeDeliveryAdvisory.cancelTeam).toHaveBeenCalledWith('alpha');
    expect(ports.pendingTimeouts.has('same-team-deferred:alpha')).toBe(false);
    expect(ports.pendingTimeouts.has('lead-inbox-follow-up:alpha')).toBe(false);
    expect((ports.successfulLeadRecoveryMessageIds as Map<string, unknown>).has('alpha')).toBe(
      false
    );
    expect((ports.leadRecoveryMessageIds as Map<string, unknown>).has('alpha')).toBe(false);
    expect(ports.pendingTimeouts.has('same-team-deferred:beta')).toBe(true);
    expect((ports.memberInboxRelayInFlight as Map<string, unknown>).has('alpha:dev')).toBe(false);
    expect((ports.memberInboxRelayInFlight as Map<string, unknown>).has('beta:dev')).toBe(true);
    expect(
      (ports.openCodeMemberInboxRelayInFlight as Map<string, unknown>).has('opencode:alpha:dev')
    ).toBe(false);
    expect(
      (ports.openCodeMemberInboxRelayInFlight as Map<string, unknown>).has('opencode:beta:dev')
    ).toBe(true);
    expect(
      (ports.openCodeMemberSendInFlightByLane as Map<string, unknown>).has(
        'opencode-send:alpha:lane'
      )
    ).toBe(false);
    expect(
      (ports.openCodeMemberSendInFlightByLane as Map<string, unknown>).has(
        'opencode-send:beta:lane'
      )
    ).toBe(true);
    expect((ports.relayedMemberInboxMessageIds as Map<string, unknown>).has('alpha:dev')).toBe(
      false
    );
    expect((ports.relayedMemberInboxMessageIds as Map<string, unknown>).has('beta:dev')).toBe(true);
    expect((ports.liveLeadProcessMessages as Map<string, unknown>).has('alpha')).toBe(false);
    expect(clearTimeout).toHaveBeenCalledTimes(2);
  });

  it('appends stream markers, complete lines, and bounded pending log carry', () => {
    const run = makeLogRun();
    const state = new TeamProvisioningTransientRunState(makePorts());

    state.appendCliLogs(run, 'stdout', 'hello\r\npartial');
    state.appendCliLogs(run, 'stderr', 'err\n');
    state.appendCliLogs(run, 'stdout', 'x'.repeat(256 * 1024));

    expect(run.claudeLogsUpdatedAt).toBe('2026-01-02T03:04:05.000Z');
    expect(run.claudeLogLines).toEqual(['[stdout]', 'hello', '[stderr]', 'err', '[stdout]']);
    expect(run.stdoutLogLineBuf).toContain('...[truncated pending line]');
    expect(run.stdoutLogLineBuf.length).toBeLessThan(256 * 1024);
  });

  it('bounds retained CLI log lines as stdout is appended', () => {
    const run = makeLogRun();
    const state = new TeamProvisioningTransientRunState(makePorts());
    const lines = Array.from(
      { length: PROGRESS_RETAINED_LOG_LINES + 600 },
      (_, index) => `line-${index}-${'x'.repeat(700)}`
    );
    const hugeLine = `huge-${'h'.repeat(PROGRESS_RETAINED_LOG_LINE_CHARS + 1_000)}`;
    const latestLine = 'latest-marker';
    const text = [...lines, hugeLine, latestLine].join('\n') + '\n';

    state.appendCliLogs(run, 'stdout', text);

    expect(run.claudeLogLines.length).toBeLessThanOrEqual(PROGRESS_RETAINED_LOG_LINES);
    expect(totalStringChars(run.claudeLogLines)).toBeLessThanOrEqual(PROGRESS_RETAINED_LOG_CHARS);
    expect(run.claudeLogLines.at(-1)).toBe(latestLine);
    expect(run.claudeLogLines.some((line) => line.includes('[truncated]'))).toBe(true);
    expect(run.claudeLogLines.join('\n')).not.toContain('line-0-');
  });

  it('bounds pending CLI line carry buffers before newline arrives', () => {
    const run = makeLogRun();
    const state = new TeamProvisioningTransientRunState(makePorts());
    const hugePendingLine = 'x'.repeat(PROGRESS_RETAINED_LOG_LINE_CHARS + 5_000);

    state.appendCliLogs(run, 'stdout', hugePendingLine);
    state.appendCliLogs(run, 'stderr', hugePendingLine);

    expect(run.stdoutLogLineBuf.length).toBeLessThanOrEqual(PROGRESS_RETAINED_LOG_LINE_CHARS);
    expect(run.stderrLogLineBuf.length).toBeLessThanOrEqual(PROGRESS_RETAINED_LOG_LINE_CHARS);
    expect(run.stdoutLogLineBuf).toContain('[truncated pending line]');
    expect(run.stderrLogLineBuf).toContain('[truncated pending line]');
  });

  it('serializes concurrent operations by team and releases the lock', async () => {
    const ports = makePorts();
    const state = new TeamProvisioningTransientRunState(ports);
    const events: string[] = [];
    let releaseFirst!: () => void;

    const first = state.withTeamLock('alpha', async () => {
      events.push('first:start');
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      events.push('first:end');
      return 'first';
    });
    const second = state.withTeamLock('alpha', async () => {
      events.push('second');
      return 'second';
    });

    await Promise.resolve();
    expect(events).toEqual(['first:start']);

    releaseFirst();
    await expect(Promise.all([first, second])).resolves.toEqual(['first', 'second']);
    expect(events).toEqual(['first:start', 'first:end', 'second']);
    expect(ports.teamOpLocks.has('alpha')).toBe(false);
  });

  it('allows the current async owner to reenter the same team lock without deadlocking', async () => {
    const ports = makePorts();
    const state = new TeamProvisioningTransientRunState(ports);
    const events: string[] = [];

    const outcome = await Promise.race([
      state.withTeamLock('alpha', async () => {
        events.push('outer');
        await state.withTeamLock('alpha', async () => {
          events.push('inner');
        });
        return 'completed';
      }),
      new Promise<string>((resolve) => setTimeout(() => resolve('deadlocked'), 100)),
    ]);

    expect(outcome).toBe('completed');
    expect(events).toEqual(['outer', 'inner']);
    expect(ports.teamOpLocks.has('alpha')).toBe(false);
  });

  it('starts an uncontended team operation synchronously', async () => {
    const ports = makePorts();
    const state = new TeamProvisioningTransientRunState(ports);
    let started = false;

    const operation = state.withTeamLock('alpha', async () => {
      started = true;
    });

    expect(started).toBe(true);
    await operation;
  });

  it('does not let stale async ownership bypass a later team lock owner', async () => {
    const ports = makePorts();
    const state = new TeamProvisioningTransientRunState(ports);
    const events: string[] = [];
    let releaseDetached!: () => void;
    const detachedGate = new Promise<void>((resolve) => {
      releaseDetached = resolve;
    });
    let detachedOperation!: Promise<void>;

    await state.withTeamLock('alpha', async () => {
      detachedOperation = (async () => {
        await detachedGate;
        await state.withTeamLock('alpha', async () => {
          events.push('detached');
        });
      })();
    });

    let releaseCurrent!: () => void;
    let currentStarted!: () => void;
    const currentStartedSignal = new Promise<void>((resolve) => {
      currentStarted = resolve;
    });
    const currentOperation = state.withTeamLock('alpha', async () => {
      events.push('current:start');
      currentStarted();
      await new Promise<void>((resolve) => {
        releaseCurrent = resolve;
      });
      events.push('current:end');
    });
    await currentStartedSignal;

    releaseDetached();
    await Promise.resolve();
    await Promise.resolve();
    expect(events).toEqual(['current:start']);

    releaseCurrent();
    await Promise.all([currentOperation, detachedOperation]);
    expect(events).toEqual(['current:start', 'current:end', 'detached']);
    expect(ports.teamOpLocks.has('alpha')).toBe(false);
  });
});
