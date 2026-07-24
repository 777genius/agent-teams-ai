import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  collectOpenCodeRuntimeApprovalEntries,
  openCodeApprovalToolInput,
  openCodeApprovalToolName,
} from '../../../../src/main/services/team/approvals/OpenCodeRuntimeApprovalProvider';
import {
  RuntimeToolApprovalCoordinator,
  type RuntimeToolApprovalEntry,
  type RuntimeToolApprovalEvent,
} from '../../../../src/main/services/team/approvals/RuntimeToolApprovalCoordinator';
import {
  DEFAULT_TOOL_APPROVAL_SETTINGS,
  type ToolApprovalSettings,
} from '../../../../src/shared/types/team';

import type { TeamRuntimeMemberLaunchEvidence } from '../../../../src/main/services/team/runtime';

function settings(overrides: Partial<ToolApprovalSettings> = {}): ToolApprovalSettings {
  return {
    ...DEFAULT_TOOL_APPROVAL_SETTINGS,
    ...overrides,
  };
}

function approvalEntry(
  overrides: Partial<RuntimeToolApprovalEntry> = {}
): RuntimeToolApprovalEntry {
  const approval = overrides.approval ?? {
    requestId: 'opencode:run-1:perm-1',
    runId: 'run-1',
    teamName: 'team-a',
    providerId: 'opencode' as const,
    source: 'alice',
    toolName: 'Bash',
    toolInput: { command: 'npm test' },
    receivedAt: '2026-05-22T10:00:00.000Z',
    runtimePermission: {
      providerId: 'opencode' as const,
      laneId: 'primary',
      memberName: 'alice',
      providerRequestId: 'perm-1',
      sessionId: 'ses-1',
    },
  };
  return {
    providerId: 'opencode',
    approval,
    providerRequestId: 'perm-1',
    laneId: 'primary',
    memberName: 'alice',
    cwd: '/repo',
    expectedMembers: [
      {
        name: 'alice',
        providerId: 'opencode',
        cwd: '/repo',
      },
    ],
    ...overrides,
  };
}

describe('RuntimeToolApprovalCoordinator', () => {
  let currentSettings: ToolApprovalSettings;
  let events: RuntimeToolApprovalEvent[];
  let answers: { requestId: string; allow: boolean; message?: string }[];
  let coordinator: RuntimeToolApprovalCoordinator;

  beforeEach(() => {
    vi.useFakeTimers();
    currentSettings = settings();
    events = [];
    answers = [];
    coordinator = new RuntimeToolApprovalCoordinator({
      getSettings: () => currentSettings,
      answerApproval: async ({ entry, allow, message }) => {
        answers.push({ requestId: entry.approval.requestId, allow, message });
      },
      emitApprovalEvent: (event) => {
        events.push(event);
      },
    });
  });

  afterEach(() => {
    coordinator.dispose();
    vi.useRealTimers();
  });

  it('deduplicates pending runtime approvals by app request id', () => {
    const entry = approvalEntry();

    coordinator.sync({ teamName: 'team-a', runId: 'run-1', laneId: 'primary' }, [entry]);
    coordinator.sync({ teamName: 'team-a', runId: 'run-1', laneId: 'primary' }, [entry]);

    expect(coordinator.size('team-a')).toBe(1);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ requestId: 'opencode:run-1:perm-1' });
  });

  it('queries pending runtime approvals by member identity', () => {
    coordinator.sync({ teamName: 'team-a', runId: 'run-1', laneId: 'primary' }, [approvalEntry()]);

    expect(coordinator.hasPendingApprovalForMember('team-a', ' ALICE ')).toBe(true);
    expect(coordinator.hasPendingApprovalForMember('team-a', 'bob')).toBe(false);
    expect(coordinator.hasPendingApprovalForMember('team-b', 'alice')).toBe(false);
    expect(coordinator.hasPendingApprovalForMember('team-a', '   ')).toBe(false);

    coordinator.sync({ teamName: 'team-a', runId: 'run-1', laneId: 'primary' }, []);

    expect(coordinator.hasPendingApprovalForMember('team-a', 'alice')).toBe(false);
  });

  it('auto-allows matching categories without emitting a manual prompt', async () => {
    currentSettings = settings({ autoAllowSafeBash: true });

    coordinator.sync({ teamName: 'team-a', runId: 'run-1', laneId: 'primary' }, [approvalEntry()]);
    await vi.runAllTimersAsync();

    expect(coordinator.size()).toBe(0);
    expect(answers).toEqual([{ requestId: 'opencode:run-1:perm-1', allow: true }]);
    expect(events).toEqual([
      expect.objectContaining({
        autoResolved: true,
        reason: 'auto_allow_category',
        requestId: 'opencode:run-1:perm-1',
      }),
    ]);
  });

  it('resolves timeout decisions through the provider answer callback', async () => {
    currentSettings = settings({ timeoutAction: 'deny', timeoutSeconds: 5 });

    coordinator.sync({ teamName: 'team-a', runId: 'run-1', laneId: 'primary' }, [approvalEntry()]);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(answers).toEqual([
      {
        requestId: 'opencode:run-1:perm-1',
        allow: false,
        message: 'Timed out - auto-denied by settings',
      },
    ]);
    expect(events.at(-1)).toMatchObject({
      autoResolved: true,
      reason: 'timeout_deny',
      requestId: 'opencode:run-1:perm-1',
    });
  });

  it('keeps timeout-resolved approvals pending when provider answer fails', async () => {
    currentSettings = settings({ timeoutAction: 'deny', timeoutSeconds: 5 });
    let failNextAnswer = true;
    coordinator.dispose();
    coordinator = new RuntimeToolApprovalCoordinator({
      getSettings: () => currentSettings,
      answerApproval: async ({ entry, allow, message }) => {
        if (failNextAnswer) {
          failNextAnswer = false;
          throw new Error('bridge unavailable');
        }
        answers.push({ requestId: entry.approval.requestId, allow, message });
      },
      emitApprovalEvent: (event) => {
        events.push(event);
      },
    });

    const entry = approvalEntry();
    coordinator.sync({ teamName: 'team-a', runId: 'run-1', laneId: 'primary' }, [entry]);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(coordinator.get('team-a', 'opencode:run-1:perm-1')).toBe(entry);
    expect(events.filter((event) => 'autoResolved' in event)).toEqual([]);

    await vi.advanceTimersByTimeAsync(5_000);

    expect(answers).toEqual([
      {
        requestId: 'opencode:run-1:perm-1',
        allow: false,
        message: 'Timed out - auto-denied by settings',
      },
    ]);
    expect(events.at(-1)).toMatchObject({
      autoResolved: true,
      reason: 'timeout_deny',
      requestId: 'opencode:run-1:perm-1',
    });
    expect(coordinator.get('team-a', 'opencode:run-1:perm-1')).toBeUndefined();
  });

  it('removes stale lane approvals when runtime state no longer reports them', () => {
    coordinator.sync({ teamName: 'team-a', runId: 'run-1', laneId: 'primary' }, [approvalEntry()]);

    coordinator.sync({ teamName: 'team-a', runId: 'run-1', laneId: 'primary' }, []);

    expect(coordinator.size()).toBe(0);
    expect(events.at(-1)).toMatchObject({
      autoResolved: true,
      reason: 'runtime_resolved',
      requestId: 'opencode:run-1:perm-1',
    });
  });

  it('keeps other member approvals when runtime sync is scoped to one member', () => {
    const alice = approvalEntry();
    const bob = approvalEntry({
      providerRequestId: 'perm-bob',
      memberName: 'bob',
      approval: {
        requestId: 'opencode:run-1:perm-bob',
        runId: 'run-1',
        teamName: 'team-a',
        providerId: 'opencode',
        source: 'bob',
        toolName: 'Bash',
        toolInput: { command: 'pnpm test' },
        receivedAt: '2026-05-22T10:00:00.000Z',
        runtimePermission: {
          providerId: 'opencode',
          laneId: 'primary',
          memberName: 'bob',
          providerRequestId: 'perm-bob',
          sessionId: 'ses-bob',
        },
      },
    });
    coordinator.sync({ teamName: 'team-a', runId: 'run-1', laneId: 'primary' }, [alice, bob]);

    coordinator.sync(
      { teamName: 'team-a', runId: 'run-1', laneId: 'primary', memberNames: ['alice'] },
      [alice]
    );

    expect(coordinator.get('team-a', 'opencode:run-1:perm-bob')).toBe(bob);
    expect(coordinator.size('team-a')).toBe(2);
    expect(
      events.some(
        (event) =>
          'autoResolved' in event &&
          event.requestId === 'opencode:run-1:perm-bob' &&
          event.reason === 'runtime_resolved'
      )
    ).toBe(false);
  });

  it('rejects stale UI responses by run id', async () => {
    coordinator.sync({ teamName: 'team-a', runId: 'run-1', laneId: 'primary' }, [approvalEntry()]);

    await expect(
      coordinator.respond('team-a', 'run-old', 'opencode:run-1:perm-1', true)
    ).rejects.toThrow('Stale approval: runId mismatch');
    expect(answers).toEqual([]);
  });

  it('keeps manual approvals pending when provider answer fails so users can retry', async () => {
    let failNextAnswer = true;
    coordinator.dispose();
    coordinator = new RuntimeToolApprovalCoordinator({
      getSettings: () => currentSettings,
      answerApproval: async ({ entry, allow, message }) => {
        if (failNextAnswer) {
          failNextAnswer = false;
          throw new Error('bridge unavailable');
        }
        answers.push({ requestId: entry.approval.requestId, allow, message });
      },
      emitApprovalEvent: (event) => {
        events.push(event);
      },
    });

    const entry = approvalEntry();
    coordinator.sync({ teamName: 'team-a', runId: 'run-1', laneId: 'primary' }, [entry]);

    await expect(
      coordinator.respond('team-a', 'run-1', 'opencode:run-1:perm-1', true)
    ).rejects.toThrow('bridge unavailable');
    expect(coordinator.get('team-a', 'opencode:run-1:perm-1')).toBe(entry);
    expect(coordinator.size('team-a')).toBe(1);

    await expect(
      coordinator.respond('team-a', 'run-1', 'opencode:run-1:perm-1', true, 'retry')
    ).resolves.toBe(true);
    expect(answers).toEqual([
      { requestId: 'opencode:run-1:perm-1', allow: true, message: 'retry' },
    ]);
    expect(coordinator.get('team-a', 'opencode:run-1:perm-1')).toBeUndefined();
  });

  it('leaves an in-flight approval tracked when a duplicate UI response arrives', async () => {
    let releaseAnswer!: () => void;
    let answerStarted!: () => void;
    const answerStartedPromise = new Promise<void>((resolve) => {
      answerStarted = resolve;
    });
    const releaseAnswerPromise = new Promise<void>((resolve) => {
      releaseAnswer = resolve;
    });
    coordinator.dispose();
    coordinator = new RuntimeToolApprovalCoordinator({
      getSettings: () => currentSettings,
      answerApproval: async ({ entry, allow, message }) => {
        answerStarted();
        await releaseAnswerPromise;
        answers.push({ requestId: entry.approval.requestId, allow, message });
      },
      emitApprovalEvent: (event) => {
        events.push(event);
      },
    });

    const entry = approvalEntry();
    coordinator.sync({ teamName: 'team-a', runId: 'run-1', laneId: 'primary' }, [entry]);

    const firstResponse = coordinator.respond('team-a', 'run-1', 'opencode:run-1:perm-1', true);
    await answerStartedPromise;
    await expect(
      coordinator.respond('team-a', 'run-1', 'opencode:run-1:perm-1', false)
    ).resolves.toBe(true);
    expect(coordinator.get('team-a', 'opencode:run-1:perm-1')).toBe(entry);

    releaseAnswer();
    await expect(firstResponse).resolves.toBe(true);
    expect(answers).toEqual([{ requestId: 'opencode:run-1:perm-1', allow: true }]);
    expect(coordinator.get('team-a', 'opencode:run-1:perm-1')).toBeUndefined();
  });
});

describe('OpenCodeRuntimeApprovalProvider', () => {
  it('normalizes bridge pending permissions into provider-neutral approval entries', () => {
    const member: TeamRuntimeMemberLaunchEvidence = {
      memberName: 'bob',
      providerId: 'opencode',
      launchState: 'runtime_pending_permission',
      agentToolAccepted: true,
      runtimeAlive: false,
      bootstrapConfirmed: false,
      hardFailure: false,
      pendingApprovals: [
        {
          providerId: 'opencode',
          requestId: 'perm-1',
          sessionId: 'ses-1',
          tool: 'bash',
          raw: { patterns: ['pnpm test'] },
        },
      ],
      diagnostics: [],
    };

    const entries = collectOpenCodeRuntimeApprovalEntries({
      teamName: 'team-a',
      runId: 'run-1',
      laneId: 'primary',
      cwd: '/repo',
      members: { bob: member },
      expectedMembers: [{ name: 'bob', providerId: 'opencode', cwd: '/repo' }],
      nowIso: () => '2026-05-22T10:00:00.000Z',
    });

    expect(entries).toHaveLength(1);
    expect(entries[0]?.approval).toMatchObject({
      requestId: 'opencode:run-1:perm-1',
      providerId: 'opencode',
      source: 'bob',
      toolName: 'Bash',
      toolInput: {
        provider: 'opencode',
        providerRequestId: 'perm-1',
        command: 'pnpm test',
      },
      runtimePermission: {
        providerId: 'opencode',
        laneId: 'primary',
        memberName: 'bob',
        providerRequestId: 'perm-1',
      },
    });
  });

  it('maps OpenCode permission display metadata without leaking protocol shape to UI', () => {
    const approval = {
      providerId: 'opencode' as const,
      requestId: 'perm-2',
      sessionId: 'ses-2',
      kind: 'write',
      title: 'Write file',
      raw: { patterns: ['/repo/file.ts'] },
    };

    expect(openCodeApprovalToolName(approval)).toBe('Write');
    expect(openCodeApprovalToolInput(approval)).toMatchObject({
      provider: 'opencode',
      providerRequestId: 'perm-2',
      patterns: ['/repo/file.ts'],
      title: 'Write file',
    });
  });
});
