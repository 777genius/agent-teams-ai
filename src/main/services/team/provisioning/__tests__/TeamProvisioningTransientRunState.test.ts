import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createTeamProvisioningTransientRunStatePorts,
  type TeamProvisioningCliLogRun,
  TeamProvisioningTransientRunState,
  type TeamProvisioningTransientRunStatePorts,
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
});
