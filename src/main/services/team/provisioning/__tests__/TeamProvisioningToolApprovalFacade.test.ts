import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  TeamProvisioningToolApprovalFacade,
  type TeamProvisioningToolApprovalFacadeDeps,
  type TeamProvisioningToolApprovalFacadeRun,
} from '../TeamProvisioningToolApprovalFacade';
import {
  type TeamProvisioningToolApprovalNotification,
  type TeamProvisioningToolApprovalNotificationConstructor,
  type TeamProvisioningToolApprovalNotificationOptions,
} from '../TeamProvisioningToolApprovalNotifications';

import type {
  TeamLaunchRuntimeAdapter,
  TeamRuntimeLaunchResult,
  TeamRuntimeMemberLaunchEvidence,
  TeamRuntimeMemberSpec,
  TeamRuntimePermissionAnswerInput,
  TeamRuntimePrepareResult,
  TeamRuntimeReconcileResult,
  TeamRuntimeStopResult,
} from '../../runtime/TeamRuntimeAdapter';
import type {
  InboxMessage,
  TeamChangeEvent,
  ToolApprovalEvent,
  ToolApprovalRequest,
  ToolApprovalSettings,
} from '@shared/types';
import type { ParsedPermissionRequest } from '@shared/utils/inboxNoise';

class FakeNotification implements TeamProvisioningToolApprovalNotification {
  static readonly instances: FakeNotification[] = [];

  static isSupported(): boolean {
    return true;
  }

  readonly clickListeners: Array<() => void> = [];
  readonly closeListeners: Array<() => void> = [];
  readonly actionListeners: Array<(event: unknown, index: number) => void> = [];
  closeCalls = 0;
  shown = false;

  constructor(readonly options: TeamProvisioningToolApprovalNotificationOptions) {
    FakeNotification.instances.push(this);
  }

  on(event: 'click' | 'close', listener: () => void): this;
  on(event: 'action', listener: (event: unknown, index: number) => void): this;
  on(
    event: 'click' | 'close' | 'action',
    listener: (() => void) | ((event: unknown, index: number) => void)
  ): this {
    if (event === 'click') {
      this.clickListeners.push(listener as () => void);
    } else if (event === 'close') {
      this.closeListeners.push(listener as () => void);
    } else {
      this.actionListeners.push(listener as (event: unknown, index: number) => void);
    }
    return this;
  }

  show(): void {
    this.shown = true;
  }

  close(): void {
    this.closeCalls += 1;
    for (const listener of this.closeListeners) listener();
  }
}

describe('TeamProvisioningToolApprovalFacade', () => {
  beforeEach(() => {
    FakeNotification.instances.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('forwards approval events through the configured emitter', () => {
    const { facade, events } = createHarness();
    const event: ToolApprovalEvent = { dismissed: true, teamName: 'alpha', runId: 'run-1' };

    facade.emitToolApprovalEvent(event);

    expect(events).toEqual([event]);
  });

  it('exposes the shared in-flight response state for cleanup', () => {
    const { facade } = createHarness();

    expect(facade.tryClaimResponse('req-shared')).toBe(true);
    expect(facade.inFlightResponsesForCleanup.has('req-shared')).toBe(true);
    expect(facade.tryClaimResponse('req-shared')).toBe(false);

    facade.inFlightResponsesForCleanup.delete('req-shared');

    expect(facade.tryClaimResponse('req-shared')).toBe(true);
  });

  it('re-evaluates pending lead approvals when settings are updated', () => {
    const { facade, run, events } = createHarness();

    facade.handleControlRequest(
      run,
      controlRequest('req-settings', 'Bash', { command: 'rm -rf dist' })
    );
    expect(run.pendingApprovals.has('req-settings')).toBe(true);

    facade.updateToolApprovalSettings('alpha', buildSettings({ autoAllowAll: true }));

    expect(getWrittenPayloads(run)).toContainEqual({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: 'req-settings',
        response: { behavior: 'allow', updatedInput: {} },
      },
    });
    expect(run.pendingApprovals.has('req-settings')).toBe(false);
    expect(events).toContainEqual({
      autoResolved: true,
      requestId: 'req-settings',
      runId: 'run-1',
      teamName: 'alpha',
      reason: 'auto_allow_category',
    });
  });

  it('responds to lead tool approvals and dismisses the tracked notification', async () => {
    const { facade, run } = createHarness();

    facade.handleControlRequest(
      run,
      controlRequest('req-lead', 'AskUserQuestion', {
        questions: [{ question: 'Continue?' }],
      })
    );
    const notification = notificationAt(0);

    await facade.respondToToolApproval('alpha', 'run-1', 'req-lead', true, 'yes');

    expect(getWrittenPayloads(run)).toContainEqual({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: 'req-lead',
        response: {
          behavior: 'allow',
          updatedInput: {
            questions: [{ question: 'Continue?' }],
            answers: { 'Continue?': 'yes' },
          },
        },
      },
    });
    expect(run.pendingApprovals.has('req-lead')).toBe(false);
    expect(facade.inFlightResponsesForCleanup.has('req-lead')).toBe(false);
    expect(notification.closeCalls).toBe(1);
  });

  it('responds to teammate permission approvals through inbox and control response ports', async () => {
    const { facade, run, persistedMessages, deps } = createHarness();

    facade.handleTeammatePermissionRequest(
      run,
      permissionRequest('req-worker', {
        toolName: 'AskUserQuestion',
        input: { questions: [{ question: 'Which path?' }] },
      }),
      '2026-01-01T00:00:00.000Z'
    );

    await facade.respondToToolApproval('alpha', 'run-1', 'req-worker', true, 'src/main');

    expect(persistedMessages).toHaveLength(1);
    expect(persistedMessages[0]).toMatchObject({
      from: 'Lead',
      to: 'Worker',
      summary: 'Approved AskUserQuestion request',
      source: 'lead_process',
    });
    expect(JSON.parse(persistedMessages[0].text)).toEqual({
      type: 'permission_response',
      request_id: 'req-worker',
      subtype: 'success',
      response: {
        updated_input: {
          questions: [{ question: 'Which path?' }],
          answers: { 'Which path?': 'src/main' },
        },
        permission_updates: [],
      },
    });
    expect(getWrittenPayloads(run)).toContainEqual({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: 'req-worker',
        response: {
          behavior: 'allow',
          updatedInput: {
            questions: [{ question: 'Which path?' }],
            answers: { 'Which path?': 'src/main' },
          },
        },
      },
    });
    expect(deps.emitTeamChange).toHaveBeenCalledWith({
      type: 'inbox',
      teamName: 'alpha',
      detail: 'inboxes/Worker.json',
    });
    expect(run.pendingApprovals.has('req-worker')).toBe(false);
  });

  it('syncs and clears OpenCode runtime approvals', () => {
    const { facade, events } = createHarness();

    facade.syncOpenCodeRuntimeToolApprovals(syncInputWithPendingApproval('provider-req'));

    expect(events).toContainEqual(
      expect.objectContaining({
        requestId: 'opencode:run-1:provider-req',
        providerId: 'opencode',
        source: 'Worker',
        toolName: 'Bash',
      })
    );
    expect(notificationAt(0).shown).toBe(true);

    facade.clearOpenCodeRuntimeToolApprovals('alpha', {
      runId: 'run-1',
      laneId: 'primary',
      emitDismiss: true,
    });

    expect(events).toContainEqual({ dismissed: true, teamName: 'alpha', runId: 'run-1' });
    expect(notificationAt(0).closeCalls).toBe(1);
  });

  it('answers OpenCode runtime approvals through respondToToolApproval', async () => {
    const launchResult = buildLaunchResult({
      members: { Worker: runtimeMemberEvidence({ pendingApprovals: [] }) },
    });
    const runtime = createRuntimeAdapter(launchResult);
    const { facade, deps } = createHarness({ runtimeAdapter: runtime.adapter });

    facade.syncOpenCodeRuntimeToolApprovals(syncInputWithPendingApproval('provider-answer'));

    await facade.respondToToolApproval('alpha', 'run-1', 'opencode:run-1:provider-answer', true);

    expect(runtime.answerRuntimePermission).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run-1',
        teamName: 'alpha',
        laneId: 'primary',
        memberName: 'Worker',
        requestId: 'provider-answer',
        decision: 'allow',
      })
    );
    expect(deps.setRuntimeAdapterRunByTeam).toHaveBeenCalledWith(
      'alpha',
      expect.objectContaining({
        runId: 'run-1',
        providerId: 'opencode',
        members: launchResult.members,
      })
    );
    expect(deps.setAliveRunId).toHaveBeenCalledWith('alpha', 'run-1');
    expect(deps.emitTeamChange).toHaveBeenCalledWith({
      type: 'process',
      teamName: 'alpha',
      runId: 'run-1',
      detail: 'permission-allowed',
    });
  });

  it('dismisses notification state exactly once for a request', () => {
    const { facade, run } = createHarness();

    facade.maybeShowToolApprovalOsNotification(run, approvalRequest({ requestId: 'req-notify' }));

    const notification = notificationAt(0);
    facade.dismissApprovalNotification('req-notify');
    facade.dismissApprovalNotification('req-notify');

    expect(notification.closeCalls).toBe(1);
  });

  it('auto-allows lead approvals when the timeout fires', async () => {
    vi.useFakeTimers();
    const { facade, run, events } = createHarness({
      notificationsEnabled: false,
      settings: buildSettings({ timeoutAction: 'allow', timeoutSeconds: 2 }),
    });

    facade.handleControlRequest(
      run,
      controlRequest('req-timeout-allow', 'Bash', { command: 'pnpm test' })
    );
    await vi.advanceTimersByTimeAsync(1_999);
    expect(getWrittenPayloads(run)).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);

    expect(getWrittenPayloads(run)).toContainEqual({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: 'req-timeout-allow',
        response: { behavior: 'allow', updatedInput: {} },
      },
    });
    expect(run.pendingApprovals.has('req-timeout-allow')).toBe(false);
    expect(events).toContainEqual({
      autoResolved: true,
      requestId: 'req-timeout-allow',
      runId: 'run-1',
      teamName: 'alpha',
      reason: 'timeout_allow',
    });
  });

  it('auto-denies teammate approvals when the timeout fires', async () => {
    vi.useFakeTimers();
    const { facade, run, events, persistedMessages } = createHarness({
      notificationsEnabled: false,
      settings: buildSettings({ timeoutAction: 'deny', timeoutSeconds: 1 }),
    });

    facade.handleTeammatePermissionRequest(
      run,
      permissionRequest('req-timeout-deny', { toolName: 'Bash' }),
      '2026-01-01T00:00:00.000Z'
    );

    await vi.advanceTimersByTimeAsync(1_000);

    expect(persistedMessages).toHaveLength(1);
    expect(JSON.parse(persistedMessages[0].text)).toEqual({
      type: 'permission_response',
      request_id: 'req-timeout-deny',
      subtype: 'error',
      error: 'Timed out - auto-denied by settings',
    });
    expect(run.pendingApprovals.has('req-timeout-deny')).toBe(false);
    expect(facade.inFlightResponsesForCleanup.has('req-timeout-deny')).toBe(false);
    expect(events).toContainEqual({
      autoResolved: true,
      requestId: 'req-timeout-deny',
      runId: 'run-1',
      teamName: 'alpha',
      reason: 'timeout_deny',
    });
  });
});

interface TestRun extends TeamProvisioningToolApprovalFacadeRun {
  request: {
    color: string;
    displayName: string;
    members: Array<{ name: string; role?: string }>;
  };
  child: {
    stdin: {
      writable: boolean;
      write: ReturnType<typeof vi.fn>;
    };
  };
  pendingApprovals: Map<string, ToolApprovalRequest>;
  processedPermissionRequestIds: Set<string>;
  mixedSecondaryLanes: [];
}

interface Harness {
  facade: TeamProvisioningToolApprovalFacade<TestRun>;
  deps: TeamProvisioningToolApprovalFacadeDeps<TestRun>;
  run: TestRun;
  events: ToolApprovalEvent[];
  persistedMessages: InboxMessage[];
  teamChanges: TeamChangeEvent[];
}

function createHarness(
  options: {
    run?: TestRun;
    runtimeAdapter?: TeamLaunchRuntimeAdapter | null;
    settings?: ToolApprovalSettings;
    notificationsEnabled?: boolean;
  } = {}
): Harness {
  const run = options.run ?? buildRun();
  const runs = new Map([[run.runId, run]]);
  const pendingTimeouts = new Map<string, NodeJS.Timeout>();
  const events: ToolApprovalEvent[] = [];
  const persistedMessages: InboxMessage[] = [];
  const teamChanges: TeamChangeEvent[] = [];
  const deps: TeamProvisioningToolApprovalFacadeDeps<TestRun> = {
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    pendingTimeouts,
    getRuns: vi.fn(() => runs.values()),
    getTrackedRunId: vi.fn(() => run.runId),
    getRun: vi.fn((runId) => runs.get(runId)),
    getOpenCodeRuntimeAdapter: vi.fn(() => options.runtimeAdapter ?? null),
    readLaunchState: vi.fn(async () => null),
    persistOpenCodeRuntimeAdapterLaunchResult: vi.fn(async (result) => ({ result })),
    deleteRuntimeAdapterRunByTeam: vi.fn(),
    setRuntimeAdapterRunByTeam: vi.fn(),
    setAliveRunId: vi.fn(),
    guardCommittedOpenCodeSecondaryLaneEvidence: vi.fn(async ({ result }) => result),
    publishMixedSecondaryLaneStatusChange: vi.fn(async () => undefined),
    emitTeamChange: vi.fn((event) => {
      teamChanges.push(event);
    }),
    readConfigForStrictDecision: vi.fn(async () => ({
      name: 'alpha',
      projectPath: '/repo',
    })),
    addPermissionRulesToSettings: vi.fn(async () => 1),
    persistInboxMessage: vi.fn((_teamName, _recipient, message) => {
      persistedMessages.push(message);
    }),
    nowIso: vi.fn(() => '2026-01-01T00:00:00.000Z'),
    nowMs: vi.fn(() => 1_234),
    joinPath: vi.fn((...parts: string[]) => parts.join('/')),
    teammateOperationalToolNames: [],
    notifications: {
      getNotificationSettings: vi.fn(() => ({
        enabled: options.notificationsEnabled ?? true,
        notifyOnToolApproval: options.notificationsEnabled ?? true,
        soundEnabled: true,
      })),
      getNotificationConstructor: vi.fn(
        () => FakeNotification as unknown as TeamProvisioningToolApprovalNotificationConstructor
      ),
      getAppIconPath: vi.fn(() => '/app/icon.png'),
      platform: 'win32',
      nowMs: vi.fn(() => 1_234),
    },
  };
  const facade = new TeamProvisioningToolApprovalFacade<TestRun>(deps);
  facade.setToolApprovalEventEmitter((event) => {
    events.push(event);
  });
  if (options.settings) {
    facade.updateToolApprovalSettings(run.teamName, options.settings);
  }

  return {
    facade,
    deps,
    run,
    events,
    persistedMessages,
    teamChanges,
  };
}

function buildRun(): TestRun {
  return {
    runId: 'run-1',
    teamName: 'alpha',
    request: {
      color: 'blue',
      displayName: 'Alpha Team',
      members: [
        { name: 'Lead', role: 'lead' },
        { name: 'Worker', role: 'engineer' },
      ],
    },
    child: {
      stdin: {
        writable: true,
        write: vi.fn((_data: string, callback?: (err?: Error | null) => void) => {
          callback?.(null);
          return true;
        }),
      },
    },
    pendingApprovals: new Map(),
    processedPermissionRequestIds: new Set(),
    mixedSecondaryLanes: [],
  };
}

function buildSettings(input: Partial<ToolApprovalSettings> = {}): ToolApprovalSettings {
  return {
    autoAllowAll: false,
    autoAllowFileEdits: false,
    autoAllowSafeBash: false,
    timeoutAction: 'wait',
    timeoutSeconds: 30,
    ...input,
  };
}

function controlRequest(
  requestId: string,
  toolName: string,
  toolInput: Record<string, unknown>
): Record<string, unknown> {
  return {
    request_id: requestId,
    request: {
      subtype: 'can_use_tool',
      tool_name: toolName,
      input: toolInput,
    },
  };
}

function permissionRequest(
  requestId: string,
  input: Partial<ParsedPermissionRequest> = {}
): ParsedPermissionRequest {
  return {
    requestId,
    agentId: input.agentId ?? 'Worker',
    toolName: input.toolName ?? 'Bash',
    toolUseId: input.toolUseId ?? 'toolu-1',
    description: input.description ?? 'Permission needed',
    input: input.input ?? { command: 'pnpm test' },
    permissionSuggestions: input.permissionSuggestions ?? [],
  };
}

function approvalRequest(
  input: Partial<ToolApprovalRequest> & { requestId: string }
): ToolApprovalRequest {
  return {
    requestId: input.requestId,
    runId: input.runId ?? 'run-1',
    teamName: input.teamName ?? 'alpha',
    source: input.source ?? 'lead',
    toolName: input.toolName ?? 'Bash',
    toolInput: input.toolInput ?? { command: 'pnpm test' },
    receivedAt: input.receivedAt ?? '2026-01-01T00:00:00.000Z',
    teamColor: input.teamColor,
    teamDisplayName: input.teamDisplayName,
    permissionSuggestions: input.permissionSuggestions,
    providerId: input.providerId,
    runtimePermission: input.runtimePermission,
  };
}

function getWrittenPayloads(run: TestRun): unknown[] {
  return run.child.stdin.write.mock.calls.map(([data]) => JSON.parse(String(data).trim()));
}

function notificationAt(index: number): FakeNotification {
  const notification = FakeNotification.instances[index];
  if (!notification) {
    throw new Error(`Expected fake notification at index ${index}`);
  }
  return notification;
}

function expectedMembers(): TeamRuntimeMemberSpec[] {
  return [
    {
      name: 'Worker',
      role: 'engineer',
      providerId: 'opencode',
      cwd: '/repo',
    },
  ];
}

function syncInputWithPendingApproval(providerRequestId: string): {
  teamName: string;
  runId: string;
  laneId: string;
  cwd: string;
  members: Record<string, TeamRuntimeMemberLaunchEvidence>;
  expectedMembers: TeamRuntimeMemberSpec[];
  teamColor: string;
  teamDisplayName: string;
} {
  return {
    teamName: 'alpha',
    runId: 'run-1',
    laneId: 'primary',
    cwd: '/repo',
    members: {
      Worker: runtimeMemberEvidence({
        pendingApprovals: [
          {
            providerId: 'opencode',
            requestId: providerRequestId,
            sessionId: 'session-1',
            tool: 'bash',
            raw: { patterns: ['pnpm test'] },
          },
        ],
      }),
    },
    expectedMembers: expectedMembers(),
    teamColor: 'blue',
    teamDisplayName: 'Alpha Team',
  };
}

function runtimeMemberEvidence(
  input: Partial<TeamRuntimeMemberLaunchEvidence> = {}
): TeamRuntimeMemberLaunchEvidence {
  return {
    memberName: 'Worker',
    providerId: 'opencode',
    launchState: 'runtime_pending_permission',
    agentToolAccepted: true,
    runtimeAlive: true,
    bootstrapConfirmed: true,
    hardFailure: false,
    sessionId: 'session-1',
    diagnostics: [],
    ...input,
  };
}

function buildLaunchResult(input: Partial<TeamRuntimeLaunchResult> = {}): TeamRuntimeLaunchResult {
  return {
    runId: 'run-1',
    teamName: 'alpha',
    launchPhase: 'finished',
    teamLaunchState: 'clean_success',
    members: {
      Worker: runtimeMemberEvidence({ pendingApprovals: [] }),
    },
    warnings: [],
    diagnostics: [],
    ...input,
  };
}

function createRuntimeAdapter(result: TeamRuntimeLaunchResult): {
  adapter: TeamLaunchRuntimeAdapter;
  answerRuntimePermission: ReturnType<typeof vi.fn>;
} {
  const answerRuntimePermission = vi.fn(async (_input: TeamRuntimePermissionAnswerInput) => result);
  const adapter: TeamLaunchRuntimeAdapter = {
    providerId: 'opencode',
    prepare: vi.fn(
      async (): Promise<TeamRuntimePrepareResult> => ({
        ok: true,
        providerId: 'opencode',
        modelId: null,
        diagnostics: [],
        warnings: [],
      })
    ),
    launch: vi.fn(async () => result),
    reconcile: vi.fn(
      async (): Promise<TeamRuntimeReconcileResult> => ({
        ...result,
        snapshot: null,
      })
    ),
    stop: vi.fn(
      async (): Promise<TeamRuntimeStopResult> => ({
        runId: result.runId,
        teamName: result.teamName,
        stopped: true,
        members: {},
        warnings: [],
        diagnostics: [],
      })
    ),
    answerRuntimePermission,
  };
  return { adapter, answerRuntimePermission };
}
