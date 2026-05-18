import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { create } from 'zustand';

import {
  __getTeamScopedTransientStateForTests,
  __resetTeamSliceModuleStateForTests,
  createTeamSlice,
  getActiveTeamPendingReplyWaits,
  hasActiveTeamPendingReplyWait,
  getCurrentProvisioningProgressForTeam,
  selectMemberMessagesForTeamMember,
  selectResolvedMemberForTeamName,
  selectResolvedMembersForTeamName,
  selectTeamDataForName,
} from '../../../src/renderer/store/slices/teamSlice';
import {
  __resetTeamRefreshFanoutDiagnosticsForTests,
  getTeamRefreshFanoutSnapshotForTests,
  type TeamRefreshFanoutSnapshot,
} from '../../../src/renderer/store/teamRefreshFanoutDiagnostics';

const hoisted = vi.hoisted(() => ({
  list: vi.fn(),
  getData: vi.fn(),
  getMessagesPage: vi.fn(),
  getMemberActivityMeta: vi.fn(),
  createTeam: vi.fn(),
  launchTeam: vi.fn(),
  getProvisioningStatus: vi.fn(),
  getMemberSpawnStatuses: vi.fn(),
  getTeamAgentRuntime: vi.fn(),
  cancelProvisioning: vi.fn(),
  deleteTeam: vi.fn(),
  restoreTeam: vi.fn(),
  permanentlyDeleteTeam: vi.fn(),
  sendMessage: vi.fn(),
  getOpenCodeRuntimeDeliveryStatus: vi.fn(),
  retryFailedOpenCodeSecondaryLanes: vi.fn(),
  restartMember: vi.fn(),
  skipMemberForLaunch: vi.fn(),
  requestReview: vi.fn(),
  updateKanban: vi.fn(),
  invalidateTaskChangeSummaries: vi.fn(),
  onProvisioningProgress: vi.fn(() => () => undefined),
}));

const originalWindowAnimationFrame =
  typeof window === 'undefined'
    ? null
    : {
        hasRequest: Object.prototype.hasOwnProperty.call(window, 'requestAnimationFrame'),
        hasCancel: Object.prototype.hasOwnProperty.call(window, 'cancelAnimationFrame'),
        requestAnimationFrame: window.requestAnimationFrame,
        cancelAnimationFrame: window.cancelAnimationFrame,
      };

vi.mock('@renderer/api', () => ({
  api: {
    teams: {
      list: hoisted.list,
      getData: hoisted.getData,
      getMessagesPage: hoisted.getMessagesPage,
      getMemberActivityMeta: hoisted.getMemberActivityMeta,
      createTeam: hoisted.createTeam,
      launchTeam: hoisted.launchTeam,
      getProvisioningStatus: hoisted.getProvisioningStatus,
      getMemberSpawnStatuses: hoisted.getMemberSpawnStatuses,
      getTeamAgentRuntime: hoisted.getTeamAgentRuntime,
      cancelProvisioning: hoisted.cancelProvisioning,
      deleteTeam: hoisted.deleteTeam,
      restoreTeam: hoisted.restoreTeam,
      permanentlyDeleteTeam: hoisted.permanentlyDeleteTeam,
      sendMessage: hoisted.sendMessage,
      getOpenCodeRuntimeDeliveryStatus: hoisted.getOpenCodeRuntimeDeliveryStatus,
      retryFailedOpenCodeSecondaryLanes: hoisted.retryFailedOpenCodeSecondaryLanes,
      restartMember: hoisted.restartMember,
      skipMemberForLaunch: hoisted.skipMemberForLaunch,
      requestReview: hoisted.requestReview,
      updateKanban: hoisted.updateKanban,
      onProvisioningProgress: hoisted.onProvisioningProgress,
    },
    review: {
      invalidateTaskChangeSummaries: hoisted.invalidateTaskChangeSummaries,
    },
  },
}));

vi.mock('../../../src/renderer/utils/unwrapIpc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/renderer/utils/unwrapIpc')>();
  return {
    ...actual,
    unwrapIpc: async <T>(_operation: string, fn: () => Promise<T>): Promise<T> => {
      try {
        return await fn();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new actual.IpcError('mock-op', message, error);
      }
    },
  };
});

function createSliceStore() {
  return create<any>()((set, get, store) => ({
    ...createTeamSlice(set as never, get as never, store as never),
    paneLayout: {
      focusedPaneId: 'pane-default',
      panes: [
        {
          id: 'pane-default',
          widthFraction: 1,
          tabs: [],
          activeTabId: null,
        },
      ],
    },
    openTab: vi.fn(),
    setActiveTab: vi.fn(),
    updateTabLabel: vi.fn(),
    getAllPaneTabs: vi.fn(() => []),
    warmTaskChangeSummaries: vi.fn(async () => undefined),
    invalidateTaskChangePresence: vi.fn(),
    fetchTeams: vi.fn(async () => undefined),
    fetchAllTasks: vi.fn(async () => undefined),
  }));
}

function createTeamSnapshot(overrides: Record<string, unknown> = {}): {
  teamName: string;
  config: { name: string; members?: unknown[]; projectPath?: string };
  tasks: unknown[];
  members: unknown[];
  kanbanState: { teamName: string; reviewers: unknown[]; tasks: Record<string, unknown> };
  processes: unknown[];
  isAlive?: boolean;
} {
  return {
    teamName: 'my-team',
    config: { name: 'My Team' },
    tasks: [],
    members: [],
    kanbanState: { teamName: 'my-team', reviewers: [], tasks: {} },
    processes: [],
    ...overrides,
  };
}

function createMemberSpawnStatus(overrides: Record<string, unknown> = {}) {
  return {
    status: 'online',
    launchState: 'confirmed_alive',
    error: undefined,
    updatedAt: '2026-03-12T10:00:00.000Z',
    runtimeAlive: true,
    livenessSource: 'heartbeat',
    bootstrapConfirmed: true,
    hardFailure: false,
    firstSpawnAcceptedAt: '2026-03-12T09:59:30.000Z',
    lastHeartbeatAt: '2026-03-12T10:00:00.000Z',
    ...overrides,
  };
}

function createMemberSpawnSnapshot(overrides: Record<string, unknown> = {}) {
  const typedOverrides = overrides as {
    statuses?: Record<string, ReturnType<typeof createMemberSpawnStatus>>;
  };
  return {
    runId: 'runtime-run',
    teamLaunchState: 'clean_success',
    launchPhase: 'finished',
    expectedMembers: ['alice'],
    updatedAt: '2026-03-12T10:00:00.000Z',
    summary: {
      confirmedCount: 1,
      pendingCount: 0,
      failedCount: 0,
      runtimeAlivePendingCount: 0,
    },
    source: 'merged',
    statuses: typedOverrides.statuses ?? { alice: createMemberSpawnStatus() },
    ...overrides,
  };
}

function createDeferredPromise<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function defineWindowAnimationFrame(
  requestAnimationFrame: ((callback: FrameRequestCallback) => number) | undefined,
  cancelAnimationFrame: ((handle: number) => void) | undefined
): void {
  if (typeof window === 'undefined') {
    return;
  }
  if (requestAnimationFrame === undefined) {
    delete (window as Partial<Window>).requestAnimationFrame;
  } else {
    Object.defineProperty(window, 'requestAnimationFrame', {
      configurable: true,
      writable: true,
      value: requestAnimationFrame,
    });
  }
  if (cancelAnimationFrame === undefined) {
    delete (window as Partial<Window>).cancelAnimationFrame;
  } else {
    Object.defineProperty(window, 'cancelAnimationFrame', {
      configurable: true,
      writable: true,
      value: cancelAnimationFrame,
    });
  }
}

function restoreWindowAnimationFrame(): void {
  if (typeof window === 'undefined' || originalWindowAnimationFrame === null) {
    return;
  }
  defineWindowAnimationFrame(
    originalWindowAnimationFrame.hasRequest
      ? originalWindowAnimationFrame.requestAnimationFrame
      : undefined,
    originalWindowAnimationFrame.hasCancel
      ? originalWindowAnimationFrame.cancelAnimationFrame
      : undefined
  );
}

function stubAnimationFrameWithTimer(): void {
  defineWindowAnimationFrame(
    (callback) => setTimeout(() => callback(Date.now()), 16) as unknown as number,
    (handle) => clearTimeout(handle as unknown as ReturnType<typeof setTimeout>)
  );
}

function stubAnimationFrameNeverFires(): void {
  defineWindowAnimationFrame(
    () => 1,
    () => undefined
  );
}

async function flushPostPaintTeamEnrichments(): Promise<void> {
  await vi.advanceTimersByTimeAsync(16);
  await vi.runOnlyPendingTimersAsync();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

async function flushAsyncWork(): Promise<void> {
  await flushMicrotasks();
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
  await flushMicrotasks();
}

function createRuntimeSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    teamName: 'my-team',
    updatedAt: '2026-03-12T10:00:00.000Z',
    runId: 'runtime-run',
    members: {
      alice: {
        memberName: 'alice',
        alive: true,
        restartable: true,
        backendType: 'tmux',
        pid: 4242,
        runtimeModel: 'gpt-5.4-mini',
        rssBytes: 256 * 1024 * 1024,
        updatedAt: '2026-03-12T10:00:00.000Z',
      },
    },
    ...overrides,
  };
}

describe('teamSlice actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetTeamSliceModuleStateForTests();
    __resetTeamRefreshFanoutDiagnosticsForTests();
    hoisted.list.mockResolvedValue([]);
    hoisted.getData.mockResolvedValue(createTeamSnapshot());
    hoisted.getMessagesPage.mockResolvedValue({
      messages: [],
      nextCursor: null,
      hasMore: false,
      feedRevision: 'rev-1',
    });
    hoisted.getMemberActivityMeta.mockResolvedValue({
      teamName: 'my-team',
      computedAt: '2026-03-12T10:00:00.000Z',
      members: {},
      feedRevision: 'rev-1',
    });
    hoisted.sendMessage.mockResolvedValue({ deliveredToInbox: true, messageId: 'm1' });
    hoisted.getOpenCodeRuntimeDeliveryStatus.mockResolvedValue(null);
    hoisted.requestReview.mockResolvedValue(undefined);
    hoisted.updateKanban.mockResolvedValue(undefined);
    hoisted.createTeam.mockResolvedValue({ runId: 'run-1' });
    hoisted.launchTeam.mockResolvedValue({ runId: 'run-1' });
    hoisted.invalidateTaskChangeSummaries.mockResolvedValue(undefined);
    hoisted.getProvisioningStatus.mockResolvedValue({
      runId: 'run-1',
      teamName: 'my-team',
      state: 'spawning',
      message: 'Starting',
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    hoisted.getMemberSpawnStatuses.mockResolvedValue({ statuses: {}, runId: null });
    hoisted.getTeamAgentRuntime.mockResolvedValue(
      createRuntimeSnapshot({ runId: null, members: {} })
    );
    hoisted.cancelProvisioning.mockResolvedValue(undefined);
    hoisted.deleteTeam.mockResolvedValue(undefined);
    hoisted.restoreTeam.mockResolvedValue(undefined);
    hoisted.permanentlyDeleteTeam.mockResolvedValue(undefined);
    hoisted.retryFailedOpenCodeSecondaryLanes.mockResolvedValue({
      attempted: [],
      confirmed: [],
      pending: [],
      failed: [],
      skipped: [],
    });
    hoisted.restartMember.mockResolvedValue(undefined);
    hoisted.skipMemberForLaunch.mockResolvedValue(undefined);
  });

  afterEach(() => {
    restoreWindowAnimationFrame();
    vi.useRealTimers();
  });

  it('records terminal provisioning fanout diagnostics without changing visible graph hydrate behavior', () => {
    const store = createSliceStore();
    const fetchTeams = vi.fn(async () => undefined);
    const refreshTeamData = vi.fn(async () => undefined);
    store.setState({
      fetchTeams,
      refreshTeamData,
      selectedTeamName: 'other-team',
      selectedTeamData: createTeamSnapshot({
        teamName: 'other-team',
        config: { name: 'Other Team' },
      }),
      paneLayout: {
        focusedPaneId: 'pane-default',
        panes: [
          {
            id: 'pane-default',
            widthFraction: 1,
            tabs: [{ id: 'graph-my-team', type: 'graph', teamName: 'my-team', label: 'Graph' }],
            activeTabId: 'graph-my-team',
          },
        ],
      },
    });

    store.getState().onProvisioningProgress({
      runId: 'run-ready',
      teamName: 'my-team',
      state: 'ready',
      message: 'Ready',
      startedAt: '2026-03-12T10:00:00.000Z',
      updatedAt: '2026-03-12T10:00:01.000Z',
    } as never);

    expect(fetchTeams).toHaveBeenCalledTimes(1);
    expect(refreshTeamData).toHaveBeenCalledTimes(1);
    expect(refreshTeamData).toHaveBeenCalledWith('my-team', { withDedup: true });

    const snapshot = getTeamRefreshFanoutSnapshotForTests(
      'my-team'
    ) as TeamRefreshFanoutSnapshot | null;
    expect(
      snapshot?.counts['provisioning-progress:provisioning:terminal-ready:fetchTeams:scheduled']
    ).toBe(1);
    expect(
      snapshot?.counts[
        'provisioning-progress:provisioning:terminal-ready:refreshTeamData:scheduled'
      ]
    ).toBe(1);
  });

  it('maps inbox verify failure to user-friendly text', async () => {
    const store = createSliceStore();
    hoisted.sendMessage.mockRejectedValue(new Error('Failed to verify inbox write'));

    await expect(
      store.getState().sendTeamMessage('my-team', { member: 'alice', text: 'hello' })
    ).rejects.toThrow('Failed to verify inbox write');

    expect(store.getState().sendMessageError).toBe(
      'Message was written but not verified (race). Please try again.'
    );
  });

  it('keeps send dialog result non-terminal when OpenCode runtime delivery fails after inbox persistence', async () => {
    const store = createSliceStore();
    hoisted.sendMessage.mockResolvedValue({
      deliveredToInbox: true,
      messageId: 'm-opencode-1',
      runtimeDelivery: {
        providerId: 'opencode',
        attempted: true,
        delivered: false,
        reason: 'opencode_runtime_not_active',
      },
    });

    const result = await store.getState().sendTeamMessage('my-team', {
      member: 'bob',
      text: 'hello',
    });

    expect(result.messageId).toBe('m-opencode-1');
    expect(store.getState().lastSendMessageResult).toBeNull();
    expect(store.getState().sendMessageError).toBeNull();
    expect(store.getState().sendMessageWarning).toBe(
      'OpenCode runtime delivery failed. Message was saved to inbox, but live delivery did not complete.'
    );
    expect(store.getState().sendMessageDebugDetails).toMatchObject({
      messageId: 'm-opencode-1',
      providerId: 'opencode',
      delivered: false,
      responsePending: null,
      responseState: null,
      ledgerStatus: null,
      acceptanceUnknown: null,
      reason: 'opencode_runtime_not_active',
      diagnostics: [],
    });
  });

  it('stores hidden OpenCode runtime diagnostics while live response is pending', async () => {
    const store = createSliceStore();
    hoisted.sendMessage.mockResolvedValue({
      deliveredToInbox: true,
      messageId: 'm-opencode-pending',
      runtimeDelivery: {
        providerId: 'opencode',
        attempted: true,
        delivered: true,
        responsePending: true,
        responseState: 'pending',
        ledgerStatus: 'accepted',
        acceptanceUnknown: false,
        reason: 'assistant_response_pending',
        diagnostics: ['assistant_response_pending'],
      },
    });

    const result = await store.getState().sendTeamMessage('my-team', {
      member: 'bob',
      text: 'hello',
    });

    expect(store.getState().lastSendMessageResult).toBe(result);
    expect(store.getState().sendMessageWarning).toBe(
      'OpenCode delivery is still being checked. Message was saved and will be observed before retry if needed.'
    );
    expect(store.getState().sendMessageDebugDetails).toMatchObject({
      messageId: 'm-opencode-pending',
      providerId: 'opencode',
      delivered: true,
      responsePending: true,
      responseState: 'pending',
      ledgerStatus: 'accepted',
      acceptanceUnknown: false,
      reason: 'assistant_response_pending',
      diagnostics: ['assistant_response_pending'],
    });
  });

  it('updates pending OpenCode runtime diagnostics when delivery becomes terminal', async () => {
    const store = createSliceStore();
    hoisted.sendMessage.mockResolvedValue({
      deliveredToInbox: true,
      messageId: 'm-opencode-pending',
      runtimeDelivery: {
        providerId: 'opencode',
        attempted: true,
        delivered: true,
        responsePending: true,
        responseState: 'pending',
        ledgerStatus: 'accepted',
        acceptanceUnknown: false,
        reason: 'assistant_response_pending',
        diagnostics: ['assistant_response_pending'],
      },
    });
    hoisted.getOpenCodeRuntimeDeliveryStatus.mockResolvedValue({
      messageId: 'm-opencode-pending',
      providerId: 'opencode',
      attempted: true,
      delivered: false,
      responsePending: false,
      responseState: 'empty_assistant_turn',
      ledgerStatus: 'failed_terminal',
      acceptanceUnknown: false,
      reason: 'empty_assistant_turn',
      diagnostics: ['empty_assistant_turn'],
    });

    await store.getState().sendTeamMessage('my-team', {
      member: 'bob',
      text: 'hello',
    });
    await store.getState().refreshSendMessageRuntimeDeliveryStatus('my-team', 'm-opencode-pending');

    expect(store.getState().sendMessageWarning).toBe(
      'OpenCode runtime delivery failed. Message was saved to inbox, but live delivery did not complete. Reason: OpenCode returned an empty assistant turn.'
    );
    expect(store.getState().sendMessageDebugDetails).toMatchObject({
      messageId: 'm-opencode-pending',
      delivered: false,
      responsePending: false,
      responseState: 'empty_assistant_turn',
      ledgerStatus: 'failed_terminal',
      reason: 'empty_assistant_turn',
      diagnostics: ['empty_assistant_turn'],
    });
  });

  it('checks the original message when queued blocker impact is no longer user-visible', async () => {
    const store = createSliceStore();
    hoisted.sendMessage.mockResolvedValue({
      deliveredToInbox: true,
      messageId: 'm-opencode-queued',
      runtimeDelivery: {
        providerId: 'opencode',
        attempted: true,
        delivered: true,
        responsePending: true,
        responseState: 'pending',
        ledgerStatus: 'accepted',
        queuedBehindMessageId: 'm-opencode-blocker',
        reason: 'opencode_delivery_response_pending',
        diagnostics: ['opencode_delivery_response_pending'],
        userVisibleImpact: {
          state: 'checking',
        },
      },
    });
    hoisted.getOpenCodeRuntimeDeliveryStatus
      .mockResolvedValueOnce({
        messageId: 'm-opencode-blocker',
        providerId: 'opencode',
        attempted: true,
        delivered: true,
        responsePending: true,
        responseState: 'responded_non_visible_tool',
        ledgerStatus: 'responded',
        acceptanceUnknown: false,
        reason: 'non_visible_tool_without_task_progress',
        diagnostics: ['non_visible_tool_without_task_progress'],
        userVisibleImpact: {
          state: 'none',
        },
      })
      .mockResolvedValueOnce({
        messageId: 'm-opencode-queued',
        providerId: 'opencode',
        attempted: true,
        delivered: false,
        responsePending: false,
        responseState: 'empty_assistant_turn',
        ledgerStatus: 'failed_terminal',
        acceptanceUnknown: false,
        reason: 'empty_assistant_turn',
        diagnostics: ['empty_assistant_turn'],
        userVisibleImpact: {
          state: 'error',
          reasonCode: 'backend_error',
          message: 'empty_assistant_turn',
        },
      });

    await store.getState().sendTeamMessage('my-team', {
      member: 'bob',
      text: 'hello',
    });
    await store.getState().refreshSendMessageRuntimeDeliveryStatus('my-team', {
      messageId: 'm-opencode-queued',
      statusMessageId: 'm-opencode-blocker',
    });

    expect(hoisted.getOpenCodeRuntimeDeliveryStatus).toHaveBeenNthCalledWith(
      1,
      'my-team',
      'm-opencode-blocker'
    );
    expect(hoisted.getOpenCodeRuntimeDeliveryStatus).toHaveBeenNthCalledWith(
      2,
      'my-team',
      'm-opencode-queued'
    );
    expect(store.getState().sendMessageWarning).toBe(
      'OpenCode runtime delivery failed. Message was saved to inbox, but live delivery did not complete. Reason: OpenCode returned an empty assistant turn.'
    );
    expect(store.getState().sendMessageDebugDetails).toMatchObject({
      messageId: 'm-opencode-queued',
      statusMessageId: 'm-opencode-queued',
      userVisibleState: 'error',
    });
  });

  it('clears OpenCode runtime diagnostics only for the matching message id', async () => {
    const store = createSliceStore();
    hoisted.sendMessage.mockResolvedValue({
      deliveredToInbox: true,
      messageId: 'm-opencode-pending',
      runtimeDelivery: {
        providerId: 'opencode',
        attempted: true,
        delivered: true,
        responsePending: true,
        responseState: 'pending',
        ledgerStatus: 'accepted',
        acceptanceUnknown: false,
        reason: 'assistant_response_pending',
        diagnostics: ['assistant_response_pending'],
      },
    });

    await store.getState().sendTeamMessage('my-team', {
      member: 'bob',
      text: 'hello',
    });

    store.getState().clearSendMessageRuntimeDiagnostics('other-message');
    expect(store.getState().sendMessageWarning).toBe(
      'OpenCode delivery is still being checked. Message was saved and will be observed before retry if needed.'
    );
    expect(store.getState().sendMessageDebugDetails?.messageId).toBe('m-opencode-pending');

    store.getState().clearSendMessageRuntimeDiagnostics('m-opencode-pending');
    expect(store.getState().sendMessageWarning).toBeNull();
    expect(store.getState().sendMessageDebugDetails).toBeNull();
  });

  it('clears OpenCode runtime diagnostics after normal success or send failure', async () => {
    const store = createSliceStore();
    hoisted.sendMessage
      .mockResolvedValueOnce({
        deliveredToInbox: true,
        messageId: 'm-opencode-failed',
        runtimeDelivery: {
          providerId: 'opencode',
          attempted: true,
          delivered: false,
          reason: 'runtime_unavailable',
        },
      })
      .mockResolvedValueOnce({
        deliveredToInbox: true,
        messageId: 'm-ok',
      })
      .mockRejectedValueOnce(new Error('boom'));

    await store.getState().sendTeamMessage('my-team', { member: 'bob', text: 'first' });
    expect(store.getState().sendMessageDebugDetails?.messageId).toBe('m-opencode-failed');

    await store.getState().sendTeamMessage('my-team', { member: 'alice', text: 'second' });
    expect(store.getState().sendMessageWarning).toBeNull();
    expect(store.getState().sendMessageDebugDetails).toBeNull();
    expect(store.getState().lastSendMessageResult?.messageId).toBe('m-ok');

    await expect(
      store.getState().sendTeamMessage('my-team', { member: 'alice', text: 'third' })
    ).rejects.toThrow('boom');
    expect(store.getState().sendMessageWarning).toBeNull();
    expect(store.getState().sendMessageDebugDetails).toBeNull();
    expect(store.getState().sendMessageError).toBe('boom');
  });

  it('maps task status verify failure in updateKanban and rethrows', async () => {
    const store = createSliceStore();
    hoisted.updateKanban.mockRejectedValue(new Error('Task status update verification failed: 12'));

    await expect(
      store.getState().updateKanban('my-team', '12', { op: 'request_changes' })
    ).rejects.toThrow('Task status update verification failed: 12');

    expect(store.getState().reviewActionError).toBe(
      'Failed to update task status (possible agent conflict).'
    );
  });

  it('maps task status verify failure in requestReview and rethrows', async () => {
    const store = createSliceStore();
    hoisted.requestReview.mockRejectedValue(
      new Error('Task status update verification failed: 22')
    );

    await expect(store.getState().requestReview('my-team', '22')).rejects.toThrow(
      'Task status update verification failed: 22'
    );
    expect(store.getState().reviewActionError).toBe(
      'Failed to update task status (possible agent conflict).'
    );
  });

  it('does not warm task-change summaries on team open', async () => {
    const store = createSliceStore();
    hoisted.getData.mockResolvedValue({
      teamName: 'my-team',
      config: { name: 'My Team' },
      tasks: [
        {
          id: 'completed-1',
          owner: 'alice',
          status: 'completed',
          createdAt: '2026-03-20T08:00:00.000Z',
          updatedAt: '2026-03-20T12:00:00.000Z',
        },
      ],
      members: [],
      messages: [],
      kanbanState: { teamName: 'my-team', reviewers: [], tasks: {} },
    });

    await store.getState().selectTeam('my-team');

    expect(store.getState().warmTaskChangeSummaries).not.toHaveBeenCalled();
  });

  it('commits owner slot drops in the current session while persistence is disabled', () => {
    const store = createSliceStore();

    store
      .getState()
      .commitTeamGraphOwnerSlotDrop(
        'my-team',
        'agent-alice',
        { ringIndex: 0, sectorIndex: 2 },
        'agent-bob',
        { ringIndex: 0, sectorIndex: 1 }
      );

    expect(store.getState().slotAssignmentsByTeam['my-team']).toEqual({
      'agent-alice': { ringIndex: 0, sectorIndex: 2 },
      'agent-bob': { ringIndex: 0, sectorIndex: 1 },
    });
    expect(store.getState().graphLayoutSessionByTeam['my-team']).toEqual({
      mode: 'manual',
      signature: null,
    });
  });

  it('stores non-default graph layout mode without mutating radial slot assignments', () => {
    const store = createSliceStore();
    store
      .getState()
      .commitTeamGraphOwnerSlotDrop('my-team', 'agent-alice', { ringIndex: 0, sectorIndex: 2 });

    store.getState().setTeamGraphLayoutMode('my-team', 'radial');

    expect(store.getState().graphLayoutModeByTeam['my-team']).toBe('radial');
    expect(store.getState().slotAssignmentsByTeam['my-team']).toEqual({
      'agent-alice': { ringIndex: 0, sectorIndex: 2 },
    });

    store.getState().setTeamGraphLayoutMode('my-team', 'grid-under-lead');

    expect(store.getState().graphLayoutModeByTeam['my-team']).toBe('grid-under-lead');
    expect(store.getState().slotAssignmentsByTeam['my-team']).toEqual({
      'agent-alice': { ringIndex: 0, sectorIndex: 2 },
    });
  });

  it('swaps grid owners from canonical visible order without mutating radial slots', () => {
    const store = createSliceStore();
    store.setState({
      teamDataCacheByName: {
        'my-team': createTeamSnapshot({
          config: {
            name: 'My Team',
            members: [
              { name: 'team-lead', agentId: 'lead-agent' },
              { name: 'alice', agentId: 'agent-alice' },
              { name: 'bob', agentId: 'agent-bob' },
              { name: 'tom', agentId: 'agent-tom' },
            ],
          },
          members: [
            { name: 'team-lead', agentId: 'lead-agent', agentType: 'team-lead' },
            { name: 'alice', agentId: 'agent-alice' },
            { name: 'bob', agentId: 'agent-bob' },
            { name: 'tom', agentId: 'agent-tom' },
          ],
        }),
      },
      slotAssignmentsByTeam: {
        'my-team': {
          'agent-alice': { ringIndex: 0, sectorIndex: 2 },
        },
      },
    });

    store.getState().swapTeamGraphGridOwners('my-team', 'agent-alice', 'agent-tom');

    expect(store.getState().gridOwnerOrderByTeam['my-team']).toEqual([
      'agent-tom',
      'agent-bob',
      'agent-alice',
    ]);
    expect(store.getState().slotAssignmentsByTeam['my-team']).toEqual({
      'agent-alice': { ringIndex: 0, sectorIndex: 2 },
    });
  });

  it('keeps grid owner order unchanged when radial slots are committed', () => {
    const store = createSliceStore();
    store.setState({
      gridOwnerOrderByTeam: {
        'my-team': ['agent-bob', 'agent-alice'],
      },
    });

    store
      .getState()
      .commitTeamGraphOwnerSlotDrop('my-team', 'agent-alice', { ringIndex: 0, sectorIndex: 2 });

    expect(store.getState().gridOwnerOrderByTeam['my-team']).toEqual(['agent-bob', 'agent-alice']);
  });

  it('replaces persisted slot assignments with defaults while persistence is disabled', () => {
    const store = createSliceStore();
    store.setState({
      slotLayoutVersion: 'stable-slots-v1',
      slotAssignmentsByTeam: {
        'my-team': {
          alice: { ringIndex: 0, sectorIndex: 3 },
        },
      },
    });

    store.getState().ensureTeamGraphSlotAssignments('my-team', [
      { name: 'alice', agentId: 'agent-alice' },
      { name: 'bob', agentId: 'agent-bob' },
    ]);

    expect(store.getState().slotAssignmentsByTeam['my-team']).toEqual({
      'agent-alice': { ringIndex: 0, sectorIndex: 0 },
      'agent-bob': { ringIndex: 0, sectorIndex: 1 },
    });
  });

  it('seeds first-open cardinal slot defaults for small visible teams with no saved placements', () => {
    const store = createSliceStore();

    store.getState().ensureTeamGraphSlotAssignments('my-team', [
      { name: 'alice', agentId: 'agent-alice' },
      { name: 'bob', agentId: 'agent-bob' },
      { name: 'tom', agentId: 'agent-tom' },
      { name: 'jack', agentId: 'agent-jack' },
    ]);

    expect(store.getState().slotAssignmentsByTeam['my-team']).toEqual({
      'agent-alice': { ringIndex: 0, sectorIndex: 0 },
      'agent-bob': { ringIndex: 0, sectorIndex: 1 },
      'agent-jack': { ringIndex: 0, sectorIndex: 2 },
      'agent-tom': { ringIndex: 0, sectorIndex: 3 },
    });
  });

  it('uses config member order instead of transient visible member array order for defaults', () => {
    const store = createSliceStore();

    store.getState().ensureTeamGraphSlotAssignments(
      'my-team',
      [
        { name: 'jack', agentId: 'agent-jack' },
        { name: 'tom', agentId: 'agent-tom' },
        { name: 'alice', agentId: 'agent-alice' },
        { name: 'bob', agentId: 'agent-bob' },
      ],
      [
        { name: 'alice', agentId: 'agent-alice' },
        { name: 'bob', agentId: 'agent-bob' },
        { name: 'tom', agentId: 'agent-tom' },
        { name: 'jack', agentId: 'agent-jack' },
      ]
    );

    expect(store.getState().slotAssignmentsByTeam['my-team']).toEqual({
      'agent-alice': { ringIndex: 0, sectorIndex: 0 },
      'agent-bob': { ringIndex: 0, sectorIndex: 1 },
      'agent-tom': { ringIndex: 0, sectorIndex: 2 },
      'agent-jack': { ringIndex: 0, sectorIndex: 3 },
    });
  });

  it('ignores the lead member when deriving small-team cardinal defaults', () => {
    const store = createSliceStore();

    store.getState().ensureTeamGraphSlotAssignments('my-team', [
      { name: 'team-lead', agentId: 'lead-id' },
      { name: 'alice', agentId: 'agent-alice' },
      { name: 'bob', agentId: 'agent-bob' },
      { name: 'tom', agentId: 'agent-tom' },
      { name: 'jack', agentId: 'agent-jack' },
    ]);

    expect(store.getState().slotAssignmentsByTeam['my-team']).toEqual({
      'agent-alice': { ringIndex: 0, sectorIndex: 0 },
      'agent-bob': { ringIndex: 0, sectorIndex: 1 },
      'agent-jack': { ringIndex: 0, sectorIndex: 2 },
      'agent-tom': { ringIndex: 0, sectorIndex: 3 },
    });
  });

  it('drops hidden persisted slot assignments and reseeds visible members while persistence is disabled', () => {
    const store = createSliceStore();
    store.setState({
      slotLayoutVersion: 'stable-slots-v1',
      slotAssignmentsByTeam: {
        'my-team': {
          'agent-hidden': { ringIndex: 2, sectorIndex: 4 },
        },
      },
    });

    store.getState().ensureTeamGraphSlotAssignments('my-team', [
      { name: 'hidden', agentId: 'agent-hidden', removedAt: '2026-04-16T08:00:00.000Z' },
      { name: 'alice', agentId: 'agent-alice' },
      { name: 'bob', agentId: 'agent-bob' },
    ]);

    expect(store.getState().slotAssignmentsByTeam['my-team']).toEqual({
      'agent-alice': { ringIndex: 0, sectorIndex: 0 },
      'agent-bob': { ringIndex: 0, sectorIndex: 1 },
    });
  });

  it('resets stale slot assignments when slot layout version mismatches', () => {
    const store = createSliceStore();
    store.setState({
      slotLayoutVersion: 'legacy-layout-version',
      slotAssignmentsByTeam: {
        'other-team': {
          'agent-old': { ringIndex: 9, sectorIndex: 9 },
        },
        'my-team': {
          alice: { ringIndex: 0, sectorIndex: 1 },
        },
      },
    });

    store
      .getState()
      .ensureTeamGraphSlotAssignments('my-team', [{ name: 'alice', agentId: 'agent-alice' }]);

    expect(store.getState().slotLayoutVersion).toBe('stable-slots-v1');
    expect(store.getState().slotAssignmentsByTeam).toEqual({
      'my-team': {
        'agent-alice': { ringIndex: 0, sectorIndex: 0 },
      },
    });
  });

  it('ignores hidden-member persisted slot assignments while persistence is disabled', () => {
    const store = createSliceStore();
    store.setState({
      slotLayoutVersion: 'stable-slots-v1',
      slotAssignmentsByTeam: {
        'my-team': {
          'agent-hidden': { ringIndex: 1, sectorIndex: 5 },
          'agent-visible': { ringIndex: 0, sectorIndex: 2 },
        },
      },
    });

    store
      .getState()
      .ensureTeamGraphSlotAssignments('my-team', [{ name: 'visible', agentId: 'agent-visible' }]);

    expect(store.getState().slotAssignmentsByTeam['my-team']).toEqual({
      'agent-visible': { ringIndex: 0, sectorIndex: 0 },
    });
  });

  it('reseeds defaults again while the team remains in default mode and visible owners change', () => {
    const store = createSliceStore();

    store.getState().ensureTeamGraphSlotAssignments('my-team', [
      { name: 'alice', agentId: 'agent-alice' },
      { name: 'bob', agentId: 'agent-bob' },
    ]);

    store.getState().ensureTeamGraphSlotAssignments('my-team', [
      { name: 'alice', agentId: 'agent-alice' },
      { name: 'bob', agentId: 'agent-bob' },
      { name: 'tom', agentId: 'agent-tom' },
      { name: 'jack', agentId: 'agent-jack' },
    ]);

    expect(store.getState().slotAssignmentsByTeam['my-team']).toEqual({
      'agent-alice': { ringIndex: 0, sectorIndex: 0 },
      'agent-bob': { ringIndex: 0, sectorIndex: 1 },
      'agent-jack': { ringIndex: 0, sectorIndex: 2 },
      'agent-tom': { ringIndex: 0, sectorIndex: 3 },
    });
    expect(store.getState().graphLayoutSessionByTeam['my-team']).toEqual({
      mode: 'default',
      signature: 'agent-alice|agent-bob|agent-jack|agent-tom',
    });
  });

  it('does not reshuffle existing owners after the team enters manual mode', () => {
    const store = createSliceStore();

    store.getState().ensureTeamGraphSlotAssignments('my-team', [
      { name: 'alice', agentId: 'agent-alice' },
      { name: 'bob', agentId: 'agent-bob' },
    ]);

    store.getState().setTeamGraphOwnerSlotAssignment('my-team', 'agent-alice', {
      ringIndex: 1,
      sectorIndex: 4,
    });

    store.getState().ensureTeamGraphSlotAssignments('my-team', [
      { name: 'alice', agentId: 'agent-alice' },
      { name: 'bob', agentId: 'agent-bob' },
      { name: 'tom', agentId: 'agent-tom' },
      { name: 'jack', agentId: 'agent-jack' },
    ]);

    expect(store.getState().slotAssignmentsByTeam['my-team']).toEqual({
      'agent-alice': { ringIndex: 1, sectorIndex: 4 },
      'agent-bob': { ringIndex: 0, sectorIndex: 1 },
    });
    expect(store.getState().graphLayoutSessionByTeam['my-team']).toEqual({
      mode: 'manual',
      signature: 'agent-alice|agent-bob',
    });
  });

  it('normalizes legacy six-owner row-orbit slots before preserving manual layout', () => {
    const store = createSliceStore();
    const members = [
      { name: 'alice', agentId: 'agent-alice' },
      { name: 'bob', agentId: 'agent-bob' },
      { name: 'tom', agentId: 'agent-tom' },
      { name: 'jack', agentId: 'agent-jack' },
      { name: 'nova', agentId: 'agent-nova' },
      { name: 'atlas', agentId: 'agent-atlas' },
    ];
    store.setState({
      slotAssignmentsByTeam: {
        'my-team': {
          'agent-alice': { ringIndex: 0, sectorIndex: 0 },
          'agent-atlas': { ringIndex: 0, sectorIndex: 1 },
          'agent-bob': { ringIndex: 0, sectorIndex: 2 },
          'agent-jack': { ringIndex: 1, sectorIndex: 0 },
          'agent-nova': { ringIndex: 1, sectorIndex: 1 },
          'agent-tom': { ringIndex: 1, sectorIndex: 2 },
        },
      },
      graphLayoutSessionByTeam: {
        'my-team': {
          mode: 'manual',
          signature: null,
        },
      },
    });

    store.getState().ensureTeamGraphSlotAssignments('my-team', members);

    expect(store.getState().slotAssignmentsByTeam['my-team']).toEqual({
      'agent-alice': { ringIndex: 0, sectorIndex: 0 },
      'agent-atlas': { ringIndex: 0, sectorIndex: 1 },
      'agent-bob': { ringIndex: 0, sectorIndex: 2 },
      'agent-jack': { ringIndex: 2, sectorIndex: 0 },
      'agent-nova': { ringIndex: 2, sectorIndex: 1 },
      'agent-tom': { ringIndex: 2, sectorIndex: 2 },
    });
    expect(store.getState().graphLayoutSessionByTeam['my-team']).toEqual({
      mode: 'manual',
      signature: null,
    });
  });

  it('resets graph slot assignments back to defaults when reopening the graph surface', () => {
    const store = createSliceStore();
    store.setState({
      teamDataCacheByName: {
        'my-team': {
          teamName: 'my-team',
          config: { name: 'My Team' },
          tasks: [],
          members: [
            { name: 'alice', agentId: 'agent-alice' },
            { name: 'bob', agentId: 'agent-bob' },
            { name: 'tom', agentId: 'agent-tom' },
            { name: 'jack', agentId: 'agent-jack' },
          ],
          messages: [],
          kanbanState: { teamName: 'my-team', reviewers: [], tasks: {} },
          processes: [],
        },
      },
    });

    store.getState().ensureTeamGraphSlotAssignments('my-team', [
      { name: 'alice', agentId: 'agent-alice' },
      { name: 'bob', agentId: 'agent-bob' },
      { name: 'tom', agentId: 'agent-tom' },
      { name: 'jack', agentId: 'agent-jack' },
    ]);

    store
      .getState()
      .commitTeamGraphOwnerSlotDrop(
        'my-team',
        'agent-alice',
        { ringIndex: 0, sectorIndex: 2 },
        'agent-jack',
        { ringIndex: 0, sectorIndex: 0 }
      );

    store.getState().resetTeamGraphSlotAssignmentsToDefaults('my-team');

    expect(store.getState().slotAssignmentsByTeam['my-team']).toEqual({
      'agent-alice': { ringIndex: 0, sectorIndex: 0 },
      'agent-bob': { ringIndex: 0, sectorIndex: 1 },
      'agent-jack': { ringIndex: 0, sectorIndex: 2 },
      'agent-tom': { ringIndex: 0, sectorIndex: 3 },
    });
    expect(store.getState().graphLayoutSessionByTeam['my-team']).toEqual({
      mode: 'default',
      signature: 'agent-alice|agent-bob|agent-jack|agent-tom',
    });
  });

  it('syncs both team and graph tab labels when the team display name changes', async () => {
    const store = createSliceStore();
    const getAllPaneTabs = vi.fn(() => [
      { id: 'team-tab', type: 'team', teamName: 'my-team', label: 'my-team' },
      { id: 'graph-tab', type: 'graph', teamName: 'my-team', label: 'my-team Graph' },
    ]);
    const updateTabLabel = vi.fn();

    store.setState({
      getAllPaneTabs,
      updateTabLabel,
    });

    hoisted.getData.mockResolvedValue({
      teamName: 'my-team',
      config: { name: 'Northstar', members: [], projectPath: '/repo' },
      tasks: [],
      members: [],
      messages: [],
      kanbanState: { teamName: 'my-team', reviewers: [], tasks: {} },
      processes: [],
    });

    await store.getState().selectTeam('my-team');

    expect(updateTabLabel).toHaveBeenCalledWith('team-tab', 'Northstar');
    expect(updateTabLabel).toHaveBeenCalledWith('graph-tab', 'Northstar Graph');
  });

  it('clears stale selectedTeamData immediately when selecting an uncached team', async () => {
    const store = createSliceStore();
    const nextTeamData = createDeferredPromise<ReturnType<typeof createTeamSnapshot>>();

    store.setState({
      selectedTeamName: 'alpha-team',
      selectedTeamData: createTeamSnapshot({
        teamName: 'alpha-team',
        config: { name: 'Alpha Team' },
      }),
    });

    hoisted.getData.mockImplementationOnce(async () => nextTeamData.promise);

    const selectPromise = store.getState().selectTeam('beta-team');

    expect(store.getState().selectedTeamName).toBe('beta-team');
    expect(store.getState().selectedTeamLoading).toBe(true);
    expect(store.getState().selectedTeamData).toBeNull();

    nextTeamData.resolve(
      createTeamSnapshot({
        teamName: 'beta-team',
        config: { name: 'Beta Team' },
      })
    );
    await selectPromise;

    expect(store.getState().selectedTeamData?.teamName).toBe('beta-team');
  });

  it('repoints selectedTeamData to the cached snapshot immediately on team switch', async () => {
    const store = createSliceStore();
    const nextTeamData = createDeferredPromise<ReturnType<typeof createTeamSnapshot>>();
    const cachedBeta = createTeamSnapshot({
      teamName: 'beta-team',
      config: { name: 'Beta Team' },
    });

    store.setState({
      selectedTeamName: 'alpha-team',
      selectedTeamData: createTeamSnapshot({
        teamName: 'alpha-team',
        config: { name: 'Alpha Team' },
      }),
      teamDataCacheByName: {
        'beta-team': cachedBeta,
      },
    });

    hoisted.getData.mockImplementationOnce(async () => nextTeamData.promise);

    const selectPromise = store.getState().selectTeam('beta-team');

    expect(store.getState().selectedTeamName).toBe('beta-team');
    expect(store.getState().selectedTeamData).toBe(cachedBeta);

    nextTeamData.resolve(cachedBeta);
    await selectPromise;

    expect(store.getState().selectedTeamData).toBe(cachedBeta);
  });

  it('commits selectTeam thin snapshot before post-paint messages and activity meta refreshes', async () => {
    vi.useFakeTimers();
    stubAnimationFrameWithTimer();
    const store = createSliceStore();
    const messagesRequest = createDeferredPromise<{
      messages: Array<{
        from: string;
        text: string;
        timestamp: string;
        messageId: string;
        source: 'inbox';
      }>;
      nextCursor: null;
      hasMore: false;
      feedRevision: string;
    }>();
    const metaRequest = createDeferredPromise<{
      teamName: string;
      computedAt: string;
      feedRevision: string;
      members: Record<string, never>;
    }>();
    const thinSnapshot = createTeamSnapshot({
      config: { name: 'Thin Team' },
      members: [{ name: 'alice', role: 'developer', currentTaskId: null }],
    });

    hoisted.getData.mockResolvedValueOnce(thinSnapshot);
    hoisted.getMessagesPage.mockImplementationOnce(() => messagesRequest.promise);
    hoisted.getMemberActivityMeta.mockImplementationOnce(() => metaRequest.promise);

    await store.getState().selectTeam('my-team');

    expect(hoisted.getData).toHaveBeenCalledWith('my-team', {
      includeMemberBranches: false,
    });
    expect(store.getState().selectedTeamLoading).toBe(false);
    expect(store.getState().selectedTeamData).toEqual(thinSnapshot);
    expect(hoisted.getMessagesPage).not.toHaveBeenCalled();
    expect(hoisted.getMemberActivityMeta).not.toHaveBeenCalled();

    await flushPostPaintTeamEnrichments();

    expect(hoisted.getMessagesPage).toHaveBeenCalledWith('my-team', { limit: 50 });
    expect(hoisted.getMemberActivityMeta).not.toHaveBeenCalled();

    messagesRequest.resolve({
      messages: [],
      nextCursor: null,
      hasMore: false,
      feedRevision: 'rev-thin',
    });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(hoisted.getMemberActivityMeta).toHaveBeenCalledWith('my-team');

    metaRequest.resolve({
      teamName: 'my-team',
      computedAt: '2026-03-12T10:00:00.000Z',
      feedRevision: 'rev-thin',
      members: {},
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(store.getState().selectedTeamData).toEqual(thinSnapshot);
    expect(store.getState().selectedTeamError).toBeNull();
  });

  it('keeps selected team data visible when post-paint message refresh fails', async () => {
    vi.useFakeTimers();
    stubAnimationFrameWithTimer();
    const store = createSliceStore();
    const thinSnapshot = createTeamSnapshot({
      config: { name: 'Thin Team' },
      members: [{ name: 'alice', role: 'developer', currentTaskId: null }],
    });

    hoisted.getData.mockResolvedValueOnce(thinSnapshot);
    hoisted.getMessagesPage.mockRejectedValueOnce(new Error('message feed unavailable'));

    await store.getState().selectTeam('my-team');
    await flushPostPaintTeamEnrichments();
    await Promise.resolve();
    await Promise.resolve();

    expect(hoisted.getMessagesPage).toHaveBeenCalledTimes(1);
    expect(store.getState().selectedTeamData).toEqual(thinSnapshot);
    expect(store.getState().selectedTeamError).toBeNull();
    expect(store.getState().teamMessagesByName['my-team']?.loadingHead).toBe(false);
  });

  it('queues a full team refresh behind an in-flight thin selectTeam snapshot', async () => {
    vi.useFakeTimers();
    stubAnimationFrameWithTimer();
    const store = createSliceStore();
    const thinRequest = createDeferredPromise<ReturnType<typeof createTeamSnapshot>>();
    const thinSnapshot = createTeamSnapshot({
      config: { name: 'Thin Team' },
    });
    const fullSnapshot = createTeamSnapshot({
      config: { name: 'Full Team' },
      members: [{ name: 'alice', role: 'developer', currentTaskId: null, gitBranch: 'feature/a' }],
    });

    hoisted.getData
      .mockImplementationOnce(() => thinRequest.promise)
      .mockResolvedValueOnce(fullSnapshot);

    const selectPromise = store.getState().selectTeam('my-team');
    await Promise.resolve();

    await store.getState().refreshTeamData('my-team', { withDedup: true });

    expect(hoisted.getData).toHaveBeenCalledTimes(1);
    expect(__getTeamScopedTransientStateForTests('my-team')).toMatchObject({
      hasQueuedFullTeamDataRefreshAfterThin: true,
    });

    thinRequest.resolve(thinSnapshot);
    await selectPromise;

    expect(store.getState().selectedTeamData).toEqual(thinSnapshot);
    expect(hoisted.getData).toHaveBeenCalledTimes(1);

    await flushPostPaintTeamEnrichments();
    await Promise.resolve();
    await Promise.resolve();

    expect(hoisted.getData).toHaveBeenCalledTimes(2);
    expect(hoisted.getData.mock.calls[1]).toEqual(['my-team']);
    expect(store.getState().selectedTeamData).toEqual(fullSnapshot);
    expect(__getTeamScopedTransientStateForTests('my-team')).toMatchObject({
      hasQueuedFullTeamDataRefreshAfterThin: false,
    });
  });

  it('drains queued full team refresh through the post-paint fallback when rAF never fires', async () => {
    vi.useFakeTimers();
    stubAnimationFrameNeverFires();
    const store = createSliceStore();
    const thinRequest = createDeferredPromise<ReturnType<typeof createTeamSnapshot>>();

    hoisted.getData
      .mockImplementationOnce(() => thinRequest.promise)
      .mockResolvedValueOnce(
        createTeamSnapshot({
          config: { name: 'Full Team After Fallback' },
        })
      );

    const selectPromise = store.getState().selectTeam('my-team');
    await Promise.resolve();
    await store.getState().refreshTeamData('my-team', { withDedup: true });

    thinRequest.resolve(createTeamSnapshot({ config: { name: 'Thin Team' } }));
    await selectPromise;

    await vi.advanceTimersByTimeAsync(499);
    expect(hoisted.getData).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    await Promise.resolve();
    await Promise.resolve();

    expect(hoisted.getData).toHaveBeenCalledTimes(2);
    expect(store.getState().selectedTeamData?.config.name).toBe('Full Team After Fallback');
    expect(__getTeamScopedTransientStateForTests('my-team')).toMatchObject({
      hasQueuedFullTeamDataRefreshAfterThin: false,
      hasPostPaintTeamEnrichmentTimer: false,
    });
  });

  it('keeps selected team data visible when post-paint activity meta refresh fails', async () => {
    vi.useFakeTimers();
    stubAnimationFrameWithTimer();
    const store = createSliceStore();
    const thinSnapshot = createTeamSnapshot({
      config: { name: 'Thin Team' },
      members: [{ name: 'alice', role: 'developer', currentTaskId: null }],
    });

    hoisted.getData.mockResolvedValueOnce(thinSnapshot);
    hoisted.getMessagesPage.mockResolvedValueOnce({
      messages: [
        {
          from: 'alice',
          text: 'Fresh message',
          timestamp: '2026-03-12T10:00:00.000Z',
          messageId: 'msg-fresh',
          source: 'inbox',
        },
      ],
      nextCursor: null,
      hasMore: false,
      feedRevision: 'rev-meta-fail',
    });
    hoisted.getMemberActivityMeta.mockRejectedValueOnce(new Error('meta unavailable'));

    await store.getState().selectTeam('my-team');
    await flushPostPaintTeamEnrichments();
    await flushMicrotasks();

    expect(hoisted.getMemberActivityMeta).toHaveBeenCalledWith('my-team');
    expect(store.getState().selectedTeamData).toEqual(thinSnapshot);
    expect(store.getState().selectedTeamError).toBeNull();
  });

  it('does not share a forced full refresh request with an in-flight thin selectTeam request', async () => {
    const store = createSliceStore();
    const thinRequest = createDeferredPromise<ReturnType<typeof createTeamSnapshot>>();
    const fullRequest = createDeferredPromise<ReturnType<typeof createTeamSnapshot>>();
    const thinSnapshot = createTeamSnapshot({ config: { name: 'Thin Team' } });
    const fullSnapshot = createTeamSnapshot({
      config: { name: 'Full Team' },
      members: [{ name: 'alice', role: 'developer', currentTaskId: null, gitBranch: 'feature/a' }],
    });

    hoisted.getData
      .mockImplementationOnce(() => thinRequest.promise)
      .mockImplementationOnce(() => fullRequest.promise);

    const selectPromise = store.getState().selectTeam('my-team');
    await flushMicrotasks();

    const fullPromise = store.getState().refreshTeamData('my-team', { withDedup: false });

    expect(hoisted.getData).toHaveBeenCalledTimes(2);
    expect(hoisted.getData.mock.calls[0]).toEqual(['my-team', { includeMemberBranches: false }]);
    expect(hoisted.getData.mock.calls[1]).toEqual(['my-team']);

    thinRequest.resolve(thinSnapshot);
    await selectPromise;
    fullRequest.resolve(fullSnapshot);
    await fullPromise;

    expect(store.getState().selectedTeamData).toEqual(fullSnapshot);
  });

  it('does not let a late thin selectTeam snapshot clear members loaded by an earlier full refresh', async () => {
    const store = createSliceStore();
    const thinRequest = createDeferredPromise<ReturnType<typeof createTeamSnapshot>>();
    const fullRequest = createDeferredPromise<ReturnType<typeof createTeamSnapshot>>();
    const thinSnapshot = createTeamSnapshot({
      config: { name: 'Thin Team' },
      members: [],
    });
    const fullSnapshot = createTeamSnapshot({
      config: { name: 'Full Team' },
      members: [{ name: 'alice', role: 'developer', currentTaskId: null, gitBranch: 'feature/a' }],
    });

    store.setState({
      teamByName: {
        'my-team': {
          teamName: 'my-team',
          displayName: 'My Team',
          description: '',
          memberCount: 1,
          members: [{ name: 'alice', role: 'developer' }],
          taskCount: 0,
          lastActivity: null,
        },
      },
    });
    hoisted.getData
      .mockImplementationOnce(() => thinRequest.promise)
      .mockImplementationOnce(() => fullRequest.promise);

    const selectPromise = store.getState().selectTeam('my-team');
    await flushMicrotasks();
    const fullPromise = store.getState().refreshTeamData('my-team', { withDedup: false });

    fullRequest.resolve(fullSnapshot);
    await fullPromise;
    expect(store.getState().selectedTeamData).toEqual(fullSnapshot);

    thinRequest.resolve(thinSnapshot);
    await selectPromise;

    expect(store.getState().selectedTeamData).toEqual(fullSnapshot);
    expect(store.getState().teamDataCacheByName['my-team']).toEqual(fullSnapshot);
    expect(selectResolvedMembersForTeamName(store.getState(), 'my-team')).toHaveLength(1);
  });

  it('does not let a late failed selectTeam request clear members loaded by a full refresh', async () => {
    const store = createSliceStore();
    const thinRequest = createDeferredPromise<ReturnType<typeof createTeamSnapshot>>();
    const fullRequest = createDeferredPromise<ReturnType<typeof createTeamSnapshot>>();
    const fullSnapshot = createTeamSnapshot({
      config: { name: 'Full Team' },
      members: [{ name: 'alice', role: 'developer', currentTaskId: null, gitBranch: 'feature/a' }],
    });

    store.setState({
      teamByName: {
        'my-team': {
          teamName: 'my-team',
          displayName: 'My Team',
          description: '',
          memberCount: 1,
          members: [{ name: 'alice', role: 'developer' }],
          taskCount: 0,
          lastActivity: null,
        },
      },
    });
    hoisted.getData
      .mockImplementationOnce(() => thinRequest.promise)
      .mockImplementationOnce(() => fullRequest.promise);

    const selectPromise = store.getState().selectTeam('my-team');
    await flushMicrotasks();
    const fullPromise = store.getState().refreshTeamData('my-team', { withDedup: false });

    fullRequest.resolve(fullSnapshot);
    await fullPromise;
    expect(store.getState().selectedTeamData).toEqual(fullSnapshot);
    expect(store.getState().selectedTeamLoading).toBe(true);

    thinRequest.reject(new Error('Timeout after 30000ms: team:getData(my-team,mode=thin)'));
    await selectPromise;

    expect(store.getState().selectedTeamData).toEqual(fullSnapshot);
    expect(store.getState().teamDataCacheByName['my-team']).toEqual(fullSnapshot);
    expect(store.getState().selectedTeamLoading).toBe(false);
    expect(store.getState().selectedTeamError).toBeNull();
  });

  it('preserves an earlier full refresh even when the cached baseline had the same member names', async () => {
    const store = createSliceStore();
    const thinRequest = createDeferredPromise<ReturnType<typeof createTeamSnapshot>>();
    const fullRequest = createDeferredPromise<ReturnType<typeof createTeamSnapshot>>();
    const cachedSnapshot = createTeamSnapshot({
      config: { name: 'Cached Team' },
      members: [{ name: 'alice', role: 'developer', currentTaskId: null }],
    });
    const thinSnapshot = createTeamSnapshot({
      config: { name: 'Thin Team' },
      members: [],
    });
    const fullSnapshot = createTeamSnapshot({
      config: { name: 'Full Team' },
      members: [{ name: 'alice', role: 'developer', currentTaskId: null, gitBranch: 'feature/a' }],
    });

    store.setState({
      teamByName: {
        'my-team': {
          teamName: 'my-team',
          displayName: 'My Team',
          description: '',
          memberCount: 1,
          members: [{ name: 'alice', role: 'developer' }],
          taskCount: 0,
          lastActivity: null,
        },
      },
      teamDataCacheByName: {
        'my-team': cachedSnapshot,
      },
    });
    hoisted.getData
      .mockImplementationOnce(() => thinRequest.promise)
      .mockImplementationOnce(() => fullRequest.promise);

    const selectPromise = store.getState().selectTeam('my-team');
    await flushMicrotasks();
    const fullPromise = store.getState().refreshTeamData('my-team', { withDedup: false });

    fullRequest.resolve(fullSnapshot);
    await fullPromise;
    expect(store.getState().selectedTeamData).toEqual(fullSnapshot);

    thinRequest.resolve(thinSnapshot);
    await selectPromise;

    expect(store.getState().selectedTeamData).toEqual(fullSnapshot);
    expect(store.getState().teamDataCacheByName['my-team']).toEqual(fullSnapshot);
  });

  it('does not let an empty selectTeam snapshot clear an already cached member roster', async () => {
    const store = createSliceStore();
    const cachedSnapshot = createTeamSnapshot({
      config: { name: 'Cached Team' },
      members: [{ name: 'alice', role: 'developer', currentTaskId: null, gitBranch: 'feature/a' }],
    });
    const thinSnapshot = createTeamSnapshot({
      config: { name: 'Thin Team' },
      members: [],
    });

    store.setState({
      teamByName: {
        'my-team': {
          teamName: 'my-team',
          displayName: 'My Team',
          description: '',
          memberCount: 1,
          members: [{ name: 'alice', role: 'developer' }],
          taskCount: 0,
          lastActivity: null,
        },
      },
      teamDataCacheByName: {
        'my-team': cachedSnapshot,
      },
    });
    hoisted.getData.mockResolvedValueOnce(thinSnapshot);

    await store.getState().selectTeam('my-team');

    expect(store.getState().selectedTeamData).toEqual(cachedSnapshot);
    expect(store.getState().teamDataCacheByName['my-team']).toEqual(cachedSnapshot);
    expect(selectResolvedMembersForTeamName(store.getState(), 'my-team')).toHaveLength(1);
  });

  it('does not treat a lead-only selectTeam snapshot as a confirmed teammate roster', async () => {
    const store = createSliceStore();
    const cachedSnapshot = createTeamSnapshot({
      config: { name: 'Cached Team' },
      members: [
        { name: 'team-lead', agentType: 'team-lead', currentTaskId: null },
        { name: 'alice', role: 'developer', currentTaskId: null },
      ],
    });
    const leadOnlySnapshot = createTeamSnapshot({
      config: { name: 'Lead Only Thin Team' },
      members: [{ name: 'team-lead', agentType: 'team-lead', currentTaskId: null }],
    });

    store.setState({
      teamByName: {
        'my-team': {
          teamName: 'my-team',
          displayName: 'My Team',
          description: '',
          memberCount: 1,
          members: [{ name: 'alice', role: 'developer' }],
          taskCount: 0,
          lastActivity: null,
        },
      },
      teamDataCacheByName: {
        'my-team': cachedSnapshot,
      },
    });
    hoisted.getData.mockResolvedValueOnce(leadOnlySnapshot);

    await store.getState().selectTeam('my-team');

    expect(store.getState().selectedTeamData).toEqual(cachedSnapshot);
    expect(
      selectResolvedMembersForTeamName(store.getState(), 'my-team').map((m) => m.name)
    ).toEqual(['team-lead', 'alice']);
  });

  it('uses summary fallback instead of a stale cached roster when names no longer match', async () => {
    const store = createSliceStore();
    const cachedSnapshot = createTeamSnapshot({
      config: { name: 'Cached Team' },
      members: [{ name: 'alice', role: 'developer', currentTaskId: null }],
    });
    const emptySnapshot = createTeamSnapshot({
      config: { name: 'Thin Team' },
      members: [],
    });

    store.setState({
      teamByName: {
        'my-team': {
          teamName: 'my-team',
          displayName: 'My Team',
          description: '',
          memberCount: 1,
          members: [{ name: 'bob', role: 'reviewer' }],
          taskCount: 0,
          lastActivity: null,
        },
      },
      teamDataCacheByName: {
        'my-team': cachedSnapshot,
      },
    });
    hoisted.getData.mockResolvedValueOnce(emptySnapshot);

    await store.getState().selectTeam('my-team');

    expect(store.getState().selectedTeamData).toEqual(emptySnapshot);
    expect(selectResolvedMembersForTeamName(store.getState(), 'my-team')).toMatchObject([
      { name: 'bob', role: 'reviewer' },
    ]);
  });

  it('commits an empty selectTeam snapshot when the team summary is already solo', async () => {
    const store = createSliceStore();
    const cachedSnapshot = createTeamSnapshot({
      config: { name: 'Cached Team' },
      members: [{ name: 'alice', role: 'developer', currentTaskId: null }],
    });
    const soloSnapshot = createTeamSnapshot({
      config: { name: 'Solo Team' },
      members: [],
    });

    store.setState({
      teamByName: {
        'my-team': {
          teamName: 'my-team',
          displayName: 'Solo Team',
          description: '',
          memberCount: 0,
          taskCount: 0,
          lastActivity: null,
        },
      },
      teamDataCacheByName: {
        'my-team': cachedSnapshot,
      },
    });
    hoisted.getData.mockResolvedValueOnce(soloSnapshot);

    await store.getState().selectTeam('my-team');

    expect(store.getState().selectedTeamData).toEqual(soloSnapshot);
    expect(store.getState().teamDataCacheByName['my-team']).toEqual(soloSnapshot);
    expect(selectResolvedMembersForTeamName(store.getState(), 'my-team')).toHaveLength(0);
  });

  it('commits an empty cached-team selectTeam snapshot when no summary confirms teammates', async () => {
    const store = createSliceStore();
    const cachedSnapshot = createTeamSnapshot({
      config: { name: 'Cached Team' },
      members: [{ name: 'alice', role: 'developer', currentTaskId: null }],
    });
    const emptySnapshot = createTeamSnapshot({
      config: { name: 'Empty Team' },
      members: [],
    });

    store.setState({
      teamDataCacheByName: {
        'my-team': cachedSnapshot,
      },
      teamByName: {},
    });
    hoisted.getData.mockResolvedValueOnce(emptySnapshot);

    await store.getState().selectTeam('my-team');

    expect(store.getState().selectedTeamData).toEqual(emptySnapshot);
    expect(store.getState().teamDataCacheByName['my-team']).toEqual(emptySnapshot);
  });

  it('does not preserve a cached roster from a summary count without member names', async () => {
    const store = createSliceStore();
    const cachedSnapshot = createTeamSnapshot({
      config: { name: 'Cached Team' },
      members: [{ name: 'alice', role: 'developer', currentTaskId: null }],
    });
    const emptySnapshot = createTeamSnapshot({
      config: { name: 'Empty Team' },
      members: [],
    });

    store.setState({
      teamDataCacheByName: {
        'my-team': cachedSnapshot,
      },
      teamByName: {
        'my-team': {
          teamName: 'my-team',
          displayName: 'My Team',
          description: '',
          memberCount: 1,
          taskCount: 0,
          lastActivity: null,
        },
      },
    });
    hoisted.getData.mockResolvedValueOnce(emptySnapshot);

    await store.getState().selectTeam('my-team');

    expect(store.getState().selectedTeamData).toEqual(emptySnapshot);
    expect(selectResolvedMembersForTeamName(store.getState(), 'my-team')).toHaveLength(0);
  });

  it('preserves a cached roster when full launch failure metadata confirms the member names', async () => {
    const store = createSliceStore();
    const cachedSnapshot = createTeamSnapshot({
      config: { name: 'Cached Team' },
      members: [
        { name: 'alice', role: 'developer', currentTaskId: null },
        { name: 'bob', role: 'reviewer', currentTaskId: null },
      ],
    });
    const leadOnlySnapshot = createTeamSnapshot({
      config: { name: 'Lead Only Team' },
      members: [{ name: 'team-lead', agentType: 'team-lead', currentTaskId: null }],
    });

    store.setState({
      teamDataCacheByName: {
        'my-team': cachedSnapshot,
      },
      teamByName: {
        'my-team': {
          teamName: 'my-team',
          displayName: 'My Team',
          description: '',
          memberCount: 0,
          expectedMemberCount: 2,
          partialLaunchFailure: true,
          missingMembers: ['alice', 'bob'],
          taskCount: 0,
          lastActivity: null,
        },
      },
    });
    hoisted.getData.mockResolvedValueOnce(leadOnlySnapshot);

    await store.getState().selectTeam('my-team');

    expect(store.getState().selectedTeamData).toEqual(cachedSnapshot);
    expect(
      selectResolvedMembersForTeamName(store.getState(), 'my-team').map((member) => member.name)
    ).toEqual(['alice', 'bob']);
  });

  it('does not preserve a cached roster when launch failure metadata only names part of the team', async () => {
    const store = createSliceStore();
    const cachedSnapshot = createTeamSnapshot({
      config: { name: 'Cached Team' },
      members: [
        { name: 'alice', role: 'developer', currentTaskId: null },
        { name: 'bob', role: 'reviewer', currentTaskId: null },
      ],
    });
    const leadOnlySnapshot = createTeamSnapshot({
      config: { name: 'Lead Only Team' },
      members: [{ name: 'team-lead', agentType: 'team-lead', currentTaskId: null }],
    });

    store.setState({
      teamDataCacheByName: {
        'my-team': cachedSnapshot,
      },
      teamByName: {
        'my-team': {
          teamName: 'my-team',
          displayName: 'My Team',
          description: '',
          memberCount: 0,
          expectedMemberCount: 2,
          partialLaunchFailure: true,
          missingMembers: ['bob'],
          taskCount: 0,
          lastActivity: null,
        },
      },
    });
    hoisted.getData.mockResolvedValueOnce(leadOnlySnapshot);

    await store.getState().selectTeam('my-team');

    expect(store.getState().selectedTeamData).toEqual(leadOnlySnapshot);
    expect(
      selectResolvedMembersForTeamName(store.getState(), 'my-team').map((member) => member.name)
    ).toEqual(['team-lead']);
  });

  it('commits a late selectTeam snapshot that explicitly marks members as removed', async () => {
    const store = createSliceStore();
    const selectRequest = createDeferredPromise<ReturnType<typeof createTeamSnapshot>>();
    const activeSnapshot = createTeamSnapshot({
      members: [{ name: 'alice', role: 'developer', currentTaskId: null }],
    });
    const removedSnapshot = createTeamSnapshot({
      members: [
        { name: 'alice', role: 'developer', currentTaskId: null, removedAt: 1710000000000 },
      ],
    });

    hoisted.getData.mockImplementationOnce(() => selectRequest.promise);

    const selectPromise = store.getState().selectTeam('my-team');
    await flushMicrotasks();

    store.setState({
      selectedTeamName: 'my-team',
      selectedTeamData: activeSnapshot,
      teamDataCacheByName: {
        'my-team': activeSnapshot,
      },
    });

    selectRequest.resolve(removedSnapshot);
    await selectPromise;

    expect(store.getState().selectedTeamData).toEqual(removedSnapshot);
    expect(store.getState().teamDataCacheByName['my-team']).toEqual(removedSnapshot);
  });

  it('still commits a late selectTeam snapshot when concurrent local state only changed tasks', async () => {
    const store = createSliceStore();
    const selectRequest = createDeferredPromise<ReturnType<typeof createTeamSnapshot>>();
    const previousSnapshot = createTeamSnapshot({
      members: [{ name: 'alice', role: 'developer', currentTaskId: null }],
      tasks: [{ id: 'task-1', subject: 'Old task', status: 'pending', owner: 'alice' }],
    });
    const locallyPatchedSnapshot = createTeamSnapshot({
      members: [{ name: 'alice', role: 'developer', currentTaskId: null }],
      tasks: [{ id: 'task-1', subject: 'Old task', status: 'pending', owner: 'alice' }],
    });
    const incomingSnapshot = createTeamSnapshot({
      config: { name: 'Server Team' },
      members: [
        { name: 'alice', role: 'developer', currentTaskId: null },
        { name: 'bob', role: 'reviewer', currentTaskId: null },
      ],
      tasks: [{ id: 'task-2', subject: 'Server task', status: 'pending', owner: 'bob' }],
    });

    store.setState({
      selectedTeamName: 'my-team',
      selectedTeamData: previousSnapshot,
      teamDataCacheByName: {
        'my-team': previousSnapshot,
      },
    });
    hoisted.getData.mockImplementationOnce(() => selectRequest.promise);

    const selectPromise = store.getState().selectTeam('my-team');
    await flushMicrotasks();

    store.setState({
      selectedTeamData: locallyPatchedSnapshot,
      teamDataCacheByName: {
        'my-team': locallyPatchedSnapshot,
      },
    });

    selectRequest.resolve(incomingSnapshot);
    await selectPromise;

    expect(store.getState().selectedTeamData).toMatchObject({
      config: { name: 'Server Team' },
      members: [{ name: 'alice' }, { name: 'bob' }],
    });
  });

  it('does not preserve a stale roster when concurrent local state only changed tasks', async () => {
    const store = createSliceStore();
    const selectRequest = createDeferredPromise<ReturnType<typeof createTeamSnapshot>>();
    const previousSnapshot = createTeamSnapshot({
      members: [{ name: 'alice', role: 'developer', currentTaskId: null }],
      tasks: [{ id: 'task-1', subject: 'Old task', status: 'pending', owner: 'alice' }],
    });
    const locallyPatchedSnapshot = createTeamSnapshot({
      members: [{ name: 'alice', role: 'developer', currentTaskId: null }],
      tasks: [{ id: 'task-1', subject: 'Locally changed task', status: 'pending', owner: 'alice' }],
    });
    const leadOnlySnapshot = createTeamSnapshot({
      config: { name: 'Solo Team' },
      members: [{ name: 'team-lead', agentType: 'team-lead', currentTaskId: null }],
      tasks: [],
    });

    store.setState({
      selectedTeamName: 'my-team',
      selectedTeamData: previousSnapshot,
      teamDataCacheByName: {
        'my-team': previousSnapshot,
      },
      teamByName: {
        'my-team': {
          teamName: 'my-team',
          displayName: 'Solo Team',
          description: '',
          memberCount: 0,
          taskCount: 0,
          lastActivity: null,
        },
      },
    });
    hoisted.getData.mockImplementationOnce(() => selectRequest.promise);

    const selectPromise = store.getState().selectTeam('my-team');
    await flushMicrotasks();

    store.setState({
      selectedTeamData: locallyPatchedSnapshot,
      teamDataCacheByName: {
        'my-team': locallyPatchedSnapshot,
      },
    });

    selectRequest.resolve(leadOnlySnapshot);
    await selectPromise;

    expect(store.getState().selectedTeamData).toEqual(leadOnlySnapshot);
    expect(
      selectResolvedMembersForTeamName(store.getState(), 'my-team').map((m) => m.name)
    ).toEqual(['team-lead']);
  });

  it('keeps one queued full refresh for repeated fanout while thin selectTeam is pending', async () => {
    vi.useFakeTimers();
    stubAnimationFrameWithTimer();
    const store = createSliceStore();
    const thinRequest = createDeferredPromise<ReturnType<typeof createTeamSnapshot>>();
    const fullSnapshot = createTeamSnapshot({
      config: { name: 'Full Team Once' },
    });

    hoisted.getData
      .mockImplementationOnce(() => thinRequest.promise)
      .mockResolvedValueOnce(fullSnapshot);

    const selectPromise = store.getState().selectTeam('my-team');
    await flushMicrotasks();

    await Promise.all([
      store.getState().refreshTeamData('my-team', { withDedup: true }),
      store.getState().refreshTeamData('my-team', { withDedup: true }),
    ]);

    expect(hoisted.getData).toHaveBeenCalledTimes(1);
    expect(__getTeamScopedTransientStateForTests('my-team')).toMatchObject({
      hasQueuedFullTeamDataRefreshAfterThin: true,
    });

    thinRequest.resolve(createTeamSnapshot({ config: { name: 'Thin Team' } }));
    await selectPromise;
    await flushPostPaintTeamEnrichments();
    await flushMicrotasks();

    expect(hoisted.getData).toHaveBeenCalledTimes(2);
    expect(store.getState().selectedTeamData).toEqual(fullSnapshot);
    expect(__getTeamScopedTransientStateForTests('my-team')).toMatchObject({
      hasQueuedFullTeamDataRefreshAfterThin: false,
    });
  });

  it('drains queued full refresh when thin selectTeam becomes stale after switching teams', async () => {
    const store = createSliceStore();
    const alphaThin = createDeferredPromise<ReturnType<typeof createTeamSnapshot>>();
    const alphaFull = createTeamSnapshot({
      teamName: 'alpha-team',
      config: { name: 'Alpha Full' },
    });

    hoisted.getData
      .mockImplementationOnce(() => alphaThin.promise)
      .mockResolvedValueOnce(
        createTeamSnapshot({ teamName: 'beta-team', config: { name: 'Beta' } })
      )
      .mockResolvedValueOnce(alphaFull);

    const alphaSelect = store.getState().selectTeam('alpha-team');
    await flushMicrotasks();
    await store.getState().refreshTeamData('alpha-team', { withDedup: true });

    expect(__getTeamScopedTransientStateForTests('alpha-team')).toMatchObject({
      hasQueuedFullTeamDataRefreshAfterThin: true,
    });

    await store.getState().selectTeam('beta-team');

    alphaThin.resolve(
      createTeamSnapshot({ teamName: 'alpha-team', config: { name: 'Alpha Thin' } })
    );
    await alphaSelect;
    await flushAsyncWork();

    expect(hoisted.getData).toHaveBeenCalledTimes(3);
    expect(hoisted.getData.mock.calls[2]).toEqual(['alpha-team']);
    expect(store.getState().selectedTeamName).toBe('beta-team');
    expect(store.getState().teamDataCacheByName['alpha-team']).toEqual(alphaFull);
    expect(__getTeamScopedTransientStateForTests('alpha-team')).toMatchObject({
      hasQueuedFullTeamDataRefreshAfterThin: false,
    });
  });

  it('clears queued full refresh when thin selectTeam fails structurally', async () => {
    const store = createSliceStore();
    const thinRequest = createDeferredPromise<ReturnType<typeof createTeamSnapshot>>();

    hoisted.getData.mockImplementationOnce(() => thinRequest.promise);

    const selectPromise = store.getState().selectTeam('my-team');
    await flushMicrotasks();
    await store.getState().refreshTeamData('my-team', { withDedup: true });

    expect(__getTeamScopedTransientStateForTests('my-team')).toMatchObject({
      hasQueuedFullTeamDataRefreshAfterThin: true,
    });

    thinRequest.reject(new Error('TEAM_DRAFT'));
    await selectPromise;

    expect(store.getState().selectedTeamError).toBe('TEAM_DRAFT');
    expect(__getTeamScopedTransientStateForTests('my-team')).toMatchObject({
      hasQueuedFullTeamDataRefreshAfterThin: false,
    });
  });

  it('lets the newer same-team selectTeam drain queued full refresh after its own paint', async () => {
    vi.useFakeTimers();
    stubAnimationFrameWithTimer();
    const store = createSliceStore();
    const thinRequest = createDeferredPromise<ReturnType<typeof createTeamSnapshot>>();
    const fullSnapshot = createTeamSnapshot({
      config: { name: 'Full After Newer Paint' },
    });

    hoisted.getData
      .mockImplementationOnce(() => thinRequest.promise)
      .mockResolvedValueOnce(fullSnapshot);

    const firstSelect = store.getState().selectTeam('my-team');
    await flushMicrotasks();
    await store.getState().refreshTeamData('my-team', { withDedup: true });
    const secondSelect = store
      .getState()
      .selectTeam('my-team', { allowReloadWhileProvisioning: true });

    thinRequest.resolve(createTeamSnapshot({ config: { name: 'Thin Team' } }));
    await Promise.all([firstSelect, secondSelect]);

    expect(hoisted.getData).toHaveBeenCalledTimes(1);
    expect(__getTeamScopedTransientStateForTests('my-team')).toMatchObject({
      hasQueuedFullTeamDataRefreshAfterThin: true,
      hasPostPaintTeamEnrichmentTimer: true,
    });

    await flushPostPaintTeamEnrichments();
    await flushMicrotasks();

    expect(hoisted.getData).toHaveBeenCalledTimes(2);
    expect(hoisted.getData.mock.calls[1]).toEqual(['my-team']);
    expect(store.getState().selectedTeamData).toEqual(fullSnapshot);
    expect(__getTeamScopedTransientStateForTests('my-team')).toMatchObject({
      hasQueuedFullTeamDataRefreshAfterThin: false,
    });
  });

  it('does not run stale post-paint messages for a team after switching away', async () => {
    vi.useFakeTimers();
    stubAnimationFrameWithTimer();
    const store = createSliceStore();

    hoisted.getData
      .mockResolvedValueOnce(
        createTeamSnapshot({ teamName: 'alpha-team', config: { name: 'Alpha' } })
      )
      .mockResolvedValueOnce(
        createTeamSnapshot({ teamName: 'beta-team', config: { name: 'Beta' } })
      );

    await store.getState().selectTeam('alpha-team');
    expect(__getTeamScopedTransientStateForTests('alpha-team')).toMatchObject({
      hasPostPaintTeamEnrichmentTimer: true,
    });

    await store.getState().selectTeam('beta-team');
    await flushPostPaintTeamEnrichments();
    await flushMicrotasks();

    expect(hoisted.getMessagesPage).toHaveBeenCalledTimes(1);
    expect(hoisted.getMessagesPage).toHaveBeenCalledWith('beta-team', { limit: 50 });
    expect(hoisted.getMessagesPage).not.toHaveBeenCalledWith('alpha-team', { limit: 50 });
  });

  it('clears queued full refresh and post-paint timer when deleting a loaded team', async () => {
    vi.useFakeTimers();
    stubAnimationFrameWithTimer();
    const store = createSliceStore();
    const thinRequest = createDeferredPromise<ReturnType<typeof createTeamSnapshot>>();

    hoisted.getData.mockImplementationOnce(() => thinRequest.promise);

    const selectPromise = store.getState().selectTeam('my-team');
    await flushMicrotasks();
    await store.getState().refreshTeamData('my-team', { withDedup: true });

    thinRequest.resolve(createTeamSnapshot({ config: { name: 'Thin Team' } }));
    await selectPromise;

    expect(__getTeamScopedTransientStateForTests('my-team')).toMatchObject({
      hasQueuedFullTeamDataRefreshAfterThin: true,
      hasPostPaintTeamEnrichmentTimer: true,
    });

    await store.getState().deleteTeam('my-team');

    expect(__getTeamScopedTransientStateForTests('my-team')).toMatchObject({
      hasQueuedFullTeamDataRefreshAfterThin: false,
      hasPostPaintTeamEnrichmentTimer: false,
    });

    await flushPostPaintTeamEnrichments();

    expect(hoisted.getMessagesPage).not.toHaveBeenCalled();
    expect(hoisted.getData).toHaveBeenCalledTimes(1);
  });

  it('keeps selected team data visible when post-structural sync work throws', async () => {
    const store = createSliceStore();
    const thinSnapshot = createTeamSnapshot({
      config: { name: 'Renamed Team' },
    });
    const updateTabLabel = vi.fn(() => {
      throw new Error('tab label failed');
    });

    store.setState({
      getAllPaneTabs: vi.fn(() => [
        { id: 'tab-1', type: 'team', teamName: 'my-team', label: 'Old Team' },
      ]),
      updateTabLabel,
    });
    hoisted.getData.mockResolvedValueOnce(thinSnapshot);

    await store.getState().selectTeam('my-team');

    expect(updateTabLabel).toHaveBeenCalledWith('tab-1', 'Renamed Team');
    expect(store.getState().selectedTeamData).toEqual(thinSnapshot);
    expect(store.getState().selectedTeamError).toBeNull();
  });

  it('distinguishes historical feed changes from visible head changes in refreshTeamMessagesHead', async () => {
    const store = createSliceStore();
    const existingMessages = [
      {
        from: 'team-lead',
        text: 'Stable head',
        timestamp: '2026-03-20T08:00:00.000Z',
        read: true,
        source: 'lead_session',
        messageId: 'msg-1',
      },
    ];

    store.setState({
      teamMessagesByName: {
        'my-team': {
          canonicalMessages: existingMessages,
          optimisticMessages: [],
          feedRevision: 'rev-1',
          nextCursor: 'cursor-1',
          hasMore: true,
          lastFetchedAt: 123,
          loadingHead: false,
          loadingOlder: false,
          headHydrated: true,
        },
      },
    });

    hoisted.getMessagesPage.mockResolvedValueOnce({
      messages: existingMessages.map((message) => ({ ...message })),
      nextCursor: 'cursor-1',
      hasMore: true,
      feedRevision: 'rev-2',
    });

    const result = await store.getState().refreshTeamMessagesHead('my-team');
    const nextEntry = store.getState().teamMessagesByName['my-team'];

    expect(result).toEqual({
      feedChanged: true,
      headChanged: false,
      feedRevision: 'rev-2',
    });
    expect(nextEntry?.canonicalMessages).toBe(existingMessages);
    expect(nextEntry?.feedRevision).toBe('rev-2');
    expect(nextEntry?.nextCursor).toBe('cursor-1');
    expect(nextEntry?.hasMore).toBe(true);
  });

  it('keeps loaded older tail when head refresh updates only the visible top slice', async () => {
    const store = createSliceStore();
    const existingMessages = [
      {
        from: 'team-lead',
        text: 'Head 2',
        timestamp: '2026-03-20T08:00:03.000Z',
        read: true,
        source: 'lead_session',
        messageId: 'msg-4',
      },
      {
        from: 'alice',
        text: 'Head 1',
        timestamp: '2026-03-20T08:00:02.000Z',
        read: true,
        source: 'inbox',
        messageId: 'msg-3',
      },
      {
        from: 'bob',
        text: 'Older 1',
        timestamp: '2026-03-20T08:00:01.000Z',
        read: true,
        source: 'inbox',
        messageId: 'msg-2',
      },
      {
        from: 'carol',
        text: 'Older 2',
        timestamp: '2026-03-20T08:00:00.000Z',
        read: true,
        source: 'inbox',
        messageId: 'msg-1',
      },
    ];

    store.setState({
      teamMessagesByName: {
        'my-team': {
          canonicalMessages: existingMessages,
          optimisticMessages: [],
          feedRevision: 'rev-1',
          nextCursor: 'cursor-tail',
          hasMore: true,
          lastFetchedAt: 123,
          loadingHead: false,
          loadingOlder: false,
          headHydrated: true,
        },
      },
    });

    hoisted.getMessagesPage.mockResolvedValueOnce({
      messages: [
        {
          from: 'team-lead',
          text: 'Fresh head',
          timestamp: '2026-03-20T08:00:04.000Z',
          read: true,
          source: 'lead_session',
          messageId: 'msg-5',
        },
        existingMessages[0],
        existingMessages[1],
      ],
      nextCursor: 'cursor-head',
      hasMore: true,
      feedRevision: 'rev-2',
    });

    const result = await store.getState().refreshTeamMessagesHead('my-team');
    const nextEntry = store.getState().teamMessagesByName['my-team'];

    expect(result).toEqual({
      feedChanged: true,
      headChanged: true,
      feedRevision: 'rev-2',
    });
    expect(
      nextEntry?.canonicalMessages.map((message: { messageId?: string }) => message.messageId)
    ).toEqual(['msg-5', 'msg-4', 'msg-3', 'msg-2', 'msg-1']);
    expect(nextEntry?.nextCursor).toBe('cursor-tail');
    expect(nextEntry?.hasMore).toBe(true);
  });

  it('single-flights concurrent head refreshes and runs one fresh follow-up pass', async () => {
    const store = createSliceStore();
    const firstRequest = createDeferredPromise<{
      messages: Array<{
        from: string;
        text: string;
        timestamp: string;
        read: boolean;
        source: string;
        messageId: string;
      }>;
      nextCursor: string | null;
      hasMore: boolean;
      feedRevision: string;
    }>();

    store.setState({
      teamMessagesByName: {
        'my-team': {
          canonicalMessages: [],
          optimisticMessages: [],
          feedRevision: null,
          nextCursor: null,
          hasMore: false,
          lastFetchedAt: 0,
          loadingHead: false,
          loadingOlder: false,
          headHydrated: false,
        },
      },
    });

    hoisted.getMessagesPage
      .mockImplementationOnce(() => firstRequest.promise)
      .mockResolvedValueOnce({
        messages: [
          {
            from: 'team-lead',
            text: 'Newest head',
            timestamp: '2026-03-20T08:00:01.000Z',
            read: true,
            source: 'lead_session',
            messageId: 'msg-2',
          },
        ],
        nextCursor: 'cursor-2',
        hasMore: true,
        feedRevision: 'rev-2',
      });

    const p1 = store.getState().refreshTeamMessagesHead('my-team');
    const p2 = store.getState().refreshTeamMessagesHead('my-team');

    expect(hoisted.getMessagesPage).toHaveBeenCalledTimes(1);

    firstRequest.resolve({
      messages: [
        {
          from: 'team-lead',
          text: 'Old head',
          timestamp: '2026-03-20T08:00:00.000Z',
          read: true,
          source: 'lead_session',
          messageId: 'msg-1',
        },
      ],
      nextCursor: 'cursor-1',
      hasMore: true,
      feedRevision: 'rev-1',
    });

    await p1;
    await p2;
    await Promise.resolve();
    await Promise.resolve();

    expect(hoisted.getMessagesPage).toHaveBeenCalledTimes(2);
    expect(store.getState().teamMessagesByName['my-team']).toMatchObject({
      feedRevision: 'rev-2',
      nextCursor: 'cursor-2',
      hasMore: true,
      loadingHead: false,
      headHydrated: true,
    });
    expect(store.getState().teamMessagesByName['my-team']?.canonicalMessages[0]?.messageId).toBe(
      'msg-2'
    );
  });

  it('serializes head refresh behind an in-flight older-page load', async () => {
    const store = createSliceStore();
    const olderRequest = createDeferredPromise<{
      messages: Array<{
        from: string;
        text: string;
        timestamp: string;
        read: boolean;
        source: string;
        messageId: string;
      }>;
      nextCursor: string | null;
      hasMore: boolean;
      feedRevision: string;
    }>();

    store.setState({
      teamMessagesByName: {
        'my-team': {
          canonicalMessages: [
            {
              from: 'team-lead',
              text: 'Head 1',
              timestamp: '2026-03-20T08:00:02.000Z',
              read: true,
              source: 'lead_session',
              messageId: 'msg-3',
            },
            {
              from: 'alice',
              text: 'Head 0',
              timestamp: '2026-03-20T08:00:01.000Z',
              read: true,
              source: 'inbox',
              messageId: 'msg-2',
            },
          ],
          optimisticMessages: [],
          feedRevision: 'rev-1',
          nextCursor: 'cursor-older',
          hasMore: true,
          lastFetchedAt: 123,
          loadingHead: false,
          loadingOlder: false,
          headHydrated: true,
        },
      },
    });

    hoisted.getMessagesPage
      .mockImplementationOnce(() => olderRequest.promise)
      .mockResolvedValueOnce({
        messages: [
          {
            from: 'team-lead',
            text: 'Fresh head',
            timestamp: '2026-03-20T08:00:03.000Z',
            read: true,
            source: 'lead_session',
            messageId: 'msg-4',
          },
          {
            from: 'team-lead',
            text: 'Head 1',
            timestamp: '2026-03-20T08:00:02.000Z',
            read: true,
            source: 'lead_session',
            messageId: 'msg-3',
          },
        ],
        nextCursor: 'cursor-head',
        hasMore: true,
        feedRevision: 'rev-2',
      });

    const olderPromise = store.getState().loadOlderTeamMessages('my-team');
    const headPromise = store.getState().refreshTeamMessagesHead('my-team');

    expect(hoisted.getMessagesPage).toHaveBeenCalledTimes(1);
    expect(hoisted.getMessagesPage.mock.calls[0]).toEqual([
      'my-team',
      { cursor: 'cursor-older', limit: 50 },
    ]);

    olderRequest.resolve({
      messages: [
        {
          from: 'bob',
          text: 'Older tail',
          timestamp: '2026-03-20T08:00:00.000Z',
          read: true,
          source: 'inbox',
          messageId: 'msg-1',
        },
      ],
      nextCursor: null,
      hasMore: false,
      feedRevision: 'rev-1',
    });

    await olderPromise;
    await headPromise;

    expect(hoisted.getMessagesPage).toHaveBeenCalledTimes(2);
    expect(hoisted.getMessagesPage.mock.calls[1]).toEqual(['my-team', { limit: 50 }]);
    expect(
      store
        .getState()
        .teamMessagesByName[
          'my-team'
        ]?.canonicalMessages.map((message: { messageId?: string }) => message.messageId)
    ).toEqual(['msg-4', 'msg-3', 'msg-2', 'msg-1']);
  });

  it('drops a queued head refresh behind an older-page load when launch invalidates the team epoch', async () => {
    const store = createSliceStore();
    const olderRequest = createDeferredPromise<{
      messages: Array<{
        from: string;
        text: string;
        timestamp: string;
        read: boolean;
        source: string;
        messageId: string;
      }>;
      nextCursor: string | null;
      hasMore: boolean;
      feedRevision: string;
    }>();

    store.setState({
      teamMessagesByName: {
        'my-team': {
          canonicalMessages: [
            {
              from: 'team-lead',
              text: 'Head 1',
              timestamp: '2026-03-20T08:00:02.000Z',
              read: true,
              source: 'lead_session',
              messageId: 'msg-3',
            },
            {
              from: 'alice',
              text: 'Head 0',
              timestamp: '2026-03-20T08:00:01.000Z',
              read: true,
              source: 'inbox',
              messageId: 'msg-2',
            },
          ],
          optimisticMessages: [],
          feedRevision: 'rev-1',
          nextCursor: 'cursor-older',
          hasMore: true,
          lastFetchedAt: 123,
          loadingHead: false,
          loadingOlder: false,
          headHydrated: true,
        },
      },
    });

    hoisted.getMessagesPage.mockImplementationOnce(() => olderRequest.promise);

    const olderPromise = store.getState().loadOlderTeamMessages('my-team');
    const queuedHeadPromise = store.getState().refreshTeamMessagesHead('my-team');

    await Promise.resolve();
    await store.getState().launchTeam({
      teamName: 'my-team',
      cwd: '/tmp/project',
    });

    olderRequest.resolve({
      messages: [
        {
          from: 'bob',
          text: 'Older tail',
          timestamp: '2026-03-20T08:00:00.000Z',
          read: true,
          source: 'inbox',
          messageId: 'msg-1',
        },
      ],
      nextCursor: null,
      hasMore: false,
      feedRevision: 'rev-1',
    });

    await olderPromise;
    await expect(queuedHeadPromise).resolves.toEqual({
      feedChanged: false,
      headChanged: false,
      feedRevision: null,
    });

    expect(hoisted.getMessagesPage).toHaveBeenCalledTimes(1);
    expect(store.getState().teamMessagesByName['my-team']?.feedRevision).toBe('rev-1');
  });

  it('does not continue an older-page fetch with a stale cursor after launch invalidates while waiting for head refresh', async () => {
    const store = createSliceStore();
    const headRequest = createDeferredPromise<{
      messages: Array<{
        from: string;
        text: string;
        timestamp: string;
        read: boolean;
        source: string;
        messageId: string;
      }>;
      nextCursor: string | null;
      hasMore: boolean;
      feedRevision: string;
    }>();

    store.setState({
      teamMessagesByName: {
        'my-team': {
          canonicalMessages: [
            {
              from: 'team-lead',
              text: 'Head 1',
              timestamp: '2026-03-20T08:00:02.000Z',
              read: true,
              source: 'lead_session',
              messageId: 'msg-3',
            },
          ],
          optimisticMessages: [],
          feedRevision: 'rev-1',
          nextCursor: 'cursor-older',
          hasMore: true,
          lastFetchedAt: 123,
          loadingHead: false,
          loadingOlder: false,
          headHydrated: true,
        },
      },
    });

    hoisted.getMessagesPage.mockImplementationOnce(() => headRequest.promise);

    const headPromise = store.getState().refreshTeamMessagesHead('my-team');
    const olderPromise = store.getState().loadOlderTeamMessages('my-team');

    await Promise.resolve();
    await store.getState().launchTeam({
      teamName: 'my-team',
      cwd: '/tmp/project',
    });

    headRequest.resolve({
      messages: [
        {
          from: 'team-lead',
          text: 'Fresh head',
          timestamp: '2026-03-20T08:00:03.000Z',
          read: true,
          source: 'lead_session',
          messageId: 'msg-4',
        },
      ],
      nextCursor: 'cursor-head',
      hasMore: true,
      feedRevision: 'rev-2',
    });

    await headPromise;
    await olderPromise;

    expect(hoisted.getMessagesPage).toHaveBeenCalledTimes(1);
    expect(store.getState().teamMessagesByName['my-team']?.feedRevision).toBe('rev-1');
    expect(store.getState().teamMessagesByName['my-team']?.loadingOlder).toBe(false);
  });

  it('schedules pending-reply refresh through store-owned timers', async () => {
    vi.useFakeTimers();
    try {
      const store = createSliceStore();
      const refreshTeamMessagesHeadSpy = vi
        .spyOn(store.getState(), 'refreshTeamMessagesHead')
        .mockResolvedValue({
          feedChanged: true,
          headChanged: true,
          feedRevision: 'rev-2',
        });
      const refreshMemberActivityMetaSpy = vi
        .spyOn(store.getState(), 'refreshMemberActivityMeta')
        .mockResolvedValue(undefined);

      store.getState().syncTeamPendingReplyRefresh('my-team', 'tab-a', true, 1_000);

      await vi.advanceTimersByTimeAsync(999);
      expect(refreshTeamMessagesHeadSpy).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(refreshTeamMessagesHeadSpy).toHaveBeenCalledTimes(1);
      expect(refreshMemberActivityMetaSpy).toHaveBeenCalledTimes(1);

      store.getState().syncTeamPendingReplyRefresh('my-team', 'tab-a', true, 1_000);
      store.getState().syncTeamPendingReplyRefresh('my-team', 'tab-a', false);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(refreshTeamMessagesHeadSpy).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps pending-reply refresh ownership active while another source still waits for the same team', () => {
    const store = createSliceStore();

    store.getState().syncTeamPendingReplyRefresh('my-team', 'tab-a', true, 1_000);
    store.getState().syncTeamPendingReplyRefresh('my-team', 'tab-b', true, 1_000);
    store.getState().syncTeamPendingReplyRefresh('my-team', 'tab-b', false);

    expect(hasActiveTeamPendingReplyWait('my-team')).toBe(true);
    expect(getActiveTeamPendingReplyWaits()).toEqual(new Set(['my-team']));

    store.getState().syncTeamPendingReplyRefresh('my-team', 'tab-a', false);

    expect(hasActiveTeamPendingReplyWait('my-team')).toBe(false);
    expect(getActiveTeamPendingReplyWaits().size).toBe(0);
  });

  it('single-flights concurrent member activity refreshes and re-fetches after feed revision changes', async () => {
    const store = createSliceStore();
    const firstRequest = createDeferredPromise<{
      teamName: string;
      computedAt: string;
      members: Record<string, unknown>;
      feedRevision: string;
    }>();

    store.setState({
      teamMessagesByName: {
        'my-team': {
          canonicalMessages: [],
          optimisticMessages: [],
          feedRevision: 'rev-1',
          nextCursor: null,
          hasMore: false,
          lastFetchedAt: 0,
          loadingHead: false,
          loadingOlder: false,
          headHydrated: true,
        },
      },
      memberActivityMetaByTeam: {},
    });

    hoisted.getMemberActivityMeta
      .mockImplementationOnce(() => firstRequest.promise)
      .mockResolvedValueOnce({
        teamName: 'my-team',
        computedAt: '2026-03-12T10:00:01.000Z',
        members: {
          alice: {
            memberName: 'alice',
            lastAuthoredMessageAt: '2026-03-12T10:00:01.000Z',
            messageCountExact: 3,
            latestAuthoredMessageSignalsTermination: false,
          },
        },
        feedRevision: 'rev-2',
      });

    const p1 = store.getState().refreshMemberActivityMeta('my-team');

    store.setState((state: any) => ({
      teamMessagesByName: {
        ...state.teamMessagesByName,
        'my-team': {
          ...state.teamMessagesByName['my-team'],
          feedRevision: 'rev-2',
        },
      },
    }));

    const p2 = store.getState().refreshMemberActivityMeta('my-team');

    expect(hoisted.getMemberActivityMeta).toHaveBeenCalledTimes(1);

    firstRequest.resolve({
      teamName: 'my-team',
      computedAt: '2026-03-12T10:00:00.000Z',
      members: {
        alice: {
          memberName: 'alice',
          lastAuthoredMessageAt: '2026-03-12T10:00:00.000Z',
          messageCountExact: 2,
          latestAuthoredMessageSignalsTermination: false,
        },
      },
      feedRevision: 'rev-1',
    });

    await p1;
    await p2;
    await Promise.resolve();
    await Promise.resolve();

    expect(hoisted.getMemberActivityMeta).toHaveBeenCalledTimes(2);
    expect(store.getState().memberActivityMetaByTeam['my-team']).toMatchObject({
      feedRevision: 'rev-2',
      members: {
        alice: {
          messageCountExact: 3,
        },
      },
    });
  });

  it('reuses member activity facts and resolved member refs when only meta wrapper fields change', async () => {
    const store = createSliceStore();
    const initialMetaMembers = {
      alice: {
        memberName: 'alice',
        lastAuthoredMessageAt: '2026-03-12T10:00:00.000Z',
        messageCountExact: 2,
        latestAuthoredMessageSignalsTermination: false,
      },
    };

    store.setState({
      selectedTeamName: 'my-team',
      selectedTeamData: createTeamSnapshot({
        members: [
          {
            name: 'alice',
            currentTaskId: null,
            taskCount: 0,
          },
        ],
      }),
      teamDataCacheByName: {
        'my-team': createTeamSnapshot({
          members: [
            {
              name: 'alice',
              currentTaskId: null,
              taskCount: 0,
            },
          ],
        }),
      },
      teamMessagesByName: {
        'my-team': {
          canonicalMessages: [],
          optimisticMessages: [],
          feedRevision: 'rev-2',
          nextCursor: null,
          hasMore: false,
          lastFetchedAt: 0,
          loadingHead: false,
          loadingOlder: false,
          headHydrated: true,
        },
      },
      memberActivityMetaByTeam: {
        'my-team': {
          teamName: 'my-team',
          computedAt: '2026-03-12T10:00:00.000Z',
          members: initialMetaMembers,
          feedRevision: 'rev-1',
        },
      },
      leadActivityByTeam: {
        'my-team': 'active',
      },
      leadContextByTeam: {
        'my-team': {
          currentTokens: 12,
          contextWindow: 100,
          percent: 12,
          updatedAt: '2026-03-12T10:00:00.000Z',
        },
      },
      memberSpawnStatusesByTeam: {
        'my-team': {
          alice: createMemberSpawnStatus(),
        },
      },
      memberSpawnSnapshotsByTeam: {
        'my-team': createMemberSpawnSnapshot(),
      },
    });

    const initialResolvedMembers = selectResolvedMembersForTeamName(store.getState(), 'my-team');

    hoisted.getMemberActivityMeta.mockResolvedValueOnce({
      teamName: 'my-team',
      computedAt: '2026-03-12T10:00:05.000Z',
      members: {
        alice: {
          memberName: 'alice',
          lastAuthoredMessageAt: '2026-03-12T10:00:00.000Z',
          messageCountExact: 2,
          latestAuthoredMessageSignalsTermination: false,
        },
      },
      feedRevision: 'rev-2',
    });

    await store.getState().refreshMemberActivityMeta('my-team');

    const nextMeta = store.getState().memberActivityMetaByTeam['my-team'];
    const nextResolvedMembers = selectResolvedMembersForTeamName(store.getState(), 'my-team');

    expect(nextMeta?.feedRevision).toBe('rev-2');
    expect(nextMeta?.members).toBe(initialMetaMembers);
    expect(nextResolvedMembers).toBe(initialResolvedMembers);
  });

  it('prefers selected team data over stale cached data for the active team', () => {
    const store = createSliceStore();
    const staleCachedData = createTeamSnapshot({
      members: [],
    });
    const freshSelectedData = createTeamSnapshot({
      members: [
        {
          name: 'alice',
          currentTaskId: null,
          taskCount: 0,
          color: 'blue',
        },
      ],
    });

    store.setState({
      selectedTeamName: 'my-team',
      selectedTeamData: freshSelectedData,
      teamDataCacheByName: {
        'my-team': staleCachedData,
      },
      memberActivityMetaByTeam: {},
    });

    expect(selectTeamDataForName(store.getState(), 'my-team')).toBe(freshSelectedData);
    expect(selectResolvedMembersForTeamName(store.getState(), 'my-team')).toHaveLength(1);
  });

  it('falls back to config roster when snapshot members are temporarily empty', () => {
    const store = createSliceStore();
    const partialSnapshot = createTeamSnapshot({
      config: {
        name: 'My Team',
        members: [
          { name: 'team-lead', agentType: 'team-lead', providerId: 'codex' },
          { name: 'alice', role: 'reviewer', providerId: 'anthropic', color: 'blue' },
          { name: 'bob', role: 'developer', providerId: 'opencode' },
        ],
      },
      members: [],
      tasks: [
        {
          id: 'task-1',
          subject: 'Review current diff',
          status: 'in_progress',
          owner: 'alice',
        },
      ],
    });

    store.setState({
      selectedTeamName: 'my-team',
      selectedTeamData: partialSnapshot,
      teamDataCacheByName: {
        'my-team': partialSnapshot,
      },
      memberActivityMetaByTeam: {},
    });

    const members = selectResolvedMembersForTeamName(store.getState(), 'my-team');

    expect(members.map((member) => member.name)).toEqual(['team-lead', 'alice', 'bob']);
    expect(members.find((member) => member.name === 'alice')).toMatchObject({
      role: 'reviewer',
      currentTaskId: 'task-1',
      taskCount: 1,
    });
    expect(selectResolvedMemberForTeamName(store.getState(), 'my-team', 'bob')).toMatchObject({
      name: 'bob',
      role: 'developer',
    });
  });

  it('falls back to team summary roster when detail snapshot temporarily has no members', () => {
    const store = createSliceStore();
    const partialSnapshot = createTeamSnapshot({
      config: {
        name: 'My Team',
        projectPath: '/repo',
      },
      members: [],
      tasks: [
        {
          id: 'task-1',
          subject: 'Build',
          status: 'in_progress',
          owner: 'alice',
        },
      ],
    });

    store.setState({
      selectedTeamName: 'my-team',
      selectedTeamData: partialSnapshot,
      teamDataCacheByName: {
        'my-team': partialSnapshot,
      },
      teamByName: {
        'my-team': {
          teamName: 'my-team',
          displayName: 'My Team',
          description: '',
          memberCount: 2,
          taskCount: 1,
          lastActivity: null,
          leadName: 'team-lead',
          leadColor: 'purple',
          members: [
            { name: 'alice', role: 'developer', color: 'blue' },
            { name: 'bob', role: 'reviewer', color: 'green' },
          ],
        },
      },
      memberActivityMetaByTeam: {},
    });

    const members = selectResolvedMembersForTeamName(store.getState(), 'my-team');

    expect(members.map((member) => member.name)).toEqual(['team-lead', 'alice', 'bob']);
    expect(members.find((member) => member.name === 'alice')).toMatchObject({
      role: 'developer',
      currentTaskId: 'task-1',
      taskCount: 1,
    });
    expect(selectResolvedMemberForTeamName(store.getState(), 'my-team', 'bob')).toMatchObject({
      name: 'bob',
      role: 'reviewer',
    });
  });

  it('falls back to team summary roster when detail snapshot only has the synthetic lead', () => {
    const store = createSliceStore();
    const leadOnlySnapshot = createTeamSnapshot({
      config: {
        name: 'My Team',
        projectPath: '/repo',
      },
      members: [
        {
          name: 'team-lead',
          agentType: 'team-lead',
          currentTaskId: null,
          role: 'Lead from detail',
          color: 'purple',
        },
      ],
      tasks: [],
    });

    store.setState({
      selectedTeamName: 'my-team',
      selectedTeamData: leadOnlySnapshot,
      teamDataCacheByName: {
        'my-team': leadOnlySnapshot,
      },
      teamByName: {
        'my-team': {
          teamName: 'my-team',
          displayName: 'My Team',
          description: '',
          memberCount: 1,
          taskCount: 0,
          lastActivity: null,
          members: [{ name: 'alice', role: 'developer', color: 'blue' }],
        },
      },
      memberActivityMetaByTeam: {},
    });

    const members = selectResolvedMembersForTeamName(store.getState(), 'my-team');

    expect(members.map((m) => m.name)).toEqual(['team-lead', 'alice']);
    expect(members[0]).toMatchObject({
      name: 'team-lead',
      role: 'Lead from detail',
      color: 'purple',
    });
  });

  it('does not synthesize member cards from launch failure names when summary roster is missing', () => {
    const store = createSliceStore();
    const leadOnlySnapshot = createTeamSnapshot({
      config: {
        name: 'My Team',
        projectPath: '/repo',
      },
      members: [
        {
          name: 'team-lead',
          agentType: 'team-lead',
          currentTaskId: null,
          role: 'Lead from detail',
          color: 'purple',
        },
      ],
      tasks: [
        {
          id: 'task-1',
          subject: 'Build',
          status: 'in_progress',
          owner: 'Alice',
        },
      ],
    });

    store.setState({
      selectedTeamName: 'my-team',
      selectedTeamData: leadOnlySnapshot,
      teamDataCacheByName: {
        'my-team': leadOnlySnapshot,
      },
      teamByName: {
        'my-team': {
          teamName: 'my-team',
          displayName: 'My Team',
          description: '',
          memberCount: 0,
          expectedMemberCount: 2,
          leadName: 'Lead',
          partialLaunchFailure: true,
          missingMembers: ['Lead', 'Alice', 'bob'],
          taskCount: 1,
          lastActivity: null,
        },
      },
      memberActivityMetaByTeam: {},
    });

    const members = selectResolvedMembersForTeamName(store.getState(), 'my-team');

    expect(members.map((m) => m.name)).toEqual(['team-lead']);
    expect(selectResolvedMemberForTeamName(store.getState(), 'my-team', 'Alice')).toBeNull();
  });

  it('memoizes team-scoped member messages selectors over the merged message feed', () => {
    const store = createSliceStore();
    store.setState({
      teamMessagesByName: {
        'my-team': {
          canonicalMessages: [
            {
              from: 'team-lead',
              to: 'alice',
              text: 'Ping Alice',
              summary: 'Ping Alice',
              timestamp: '2026-03-12T10:00:00.000Z',
              read: false,
              messageId: 'msg-1',
            },
            {
              from: 'team-lead',
              to: 'bob',
              text: 'Ping Bob',
              summary: 'Ping Bob',
              timestamp: '2026-03-12T10:00:01.000Z',
              read: false,
              messageId: 'msg-2',
            },
          ],
          optimisticMessages: [],
          feedRevision: 'rev-1',
          nextCursor: null,
          hasMore: false,
          lastFetchedAt: 0,
          loadingHead: false,
          loadingOlder: false,
          headHydrated: true,
        },
      },
    });

    const first = selectMemberMessagesForTeamMember(store.getState(), 'my-team', 'alice');
    const second = selectMemberMessagesForTeamMember(store.getState(), 'my-team', 'alice');

    expect(first).toBe(second);
    expect(first.map((message) => message.messageId)).toEqual(['msg-1']);

    store.setState({
      teamMessagesByName: {
        'my-team': {
          canonicalMessages: [
            {
              from: 'team-lead',
              to: 'alice',
              text: 'Ping Alice',
              summary: 'Ping Alice',
              timestamp: '2026-03-12T10:00:00.000Z',
              read: false,
              messageId: 'msg-1',
            },
            {
              from: 'alice',
              to: 'team-lead',
              text: 'Reply from Alice',
              summary: 'Reply from Alice',
              timestamp: '2026-03-12T10:00:02.000Z',
              read: false,
              messageId: 'msg-3',
            },
          ],
          optimisticMessages: [],
          feedRevision: 'rev-2',
          nextCursor: null,
          hasMore: false,
          lastFetchedAt: 1,
          loadingHead: false,
          loadingOlder: false,
          headHydrated: true,
        },
      },
    });

    const third = selectMemberMessagesForTeamMember(store.getState(), 'my-team', 'alice');
    expect(third).not.toBe(first);
    expect(third.map((message) => message.messageId)).toEqual(['msg-3', 'msg-1']);
  });

  it('removes non-selected team cache entries on permanent delete', async () => {
    const store = createSliceStore();
    store.setState({
      selectedTeamName: 'other-team',
      selectedTeamData: {
        teamName: 'other-team',
        config: { name: 'Other Team' },
        tasks: [],
        members: [],
        kanbanState: { teamName: 'other-team', reviewers: [], tasks: {} },
        processes: [],
      },
      teamDataCacheByName: {
        'my-team': {
          teamName: 'my-team',
          config: { name: 'My Team' },
          tasks: [],
          members: [],
          kanbanState: { teamName: 'my-team', reviewers: [], tasks: {} },
          processes: [],
        },
        'other-team': {
          teamName: 'other-team',
          config: { name: 'Other Team' },
          tasks: [],
          members: [],
          kanbanState: { teamName: 'other-team', reviewers: [], tasks: {} },
          processes: [],
        },
      },
    });

    await store.getState().permanentlyDeleteTeam('my-team');

    expect(hoisted.permanentlyDeleteTeam).toHaveBeenCalledWith('my-team');
    expect(store.getState().teamDataCacheByName['my-team']).toBeUndefined();
    expect(store.getState().teamDataCacheByName['other-team']).toBeDefined();
  });

  it('clears selected team state and cache on soft delete', async () => {
    const store = createSliceStore();
    store.setState({
      selectedTeamName: 'my-team',
      selectedTeamData: {
        teamName: 'my-team',
        config: { name: 'My Team' },
        tasks: [],
        members: [],
        kanbanState: { teamName: 'my-team', reviewers: [], tasks: {} },
        processes: [],
      },
      teamDataCacheByName: {
        'my-team': {
          teamName: 'my-team',
          config: { name: 'My Team' },
          tasks: [],
          members: [],
          kanbanState: { teamName: 'my-team', reviewers: [], tasks: {} },
          processes: [],
        },
      },
    });

    await store.getState().deleteTeam('my-team');

    expect(hoisted.deleteTeam).toHaveBeenCalledWith('my-team');
    expect(store.getState().selectedTeamName).toBeNull();
    expect(store.getState().selectedTeamData).toBeNull();
    expect(store.getState().teamDataCacheByName['my-team']).toBeUndefined();
  });

  it('drops stale cache on restore so the next open refetches fresh data', async () => {
    const store = createSliceStore();
    store.setState({
      teamDataCacheByName: {
        'my-team': {
          teamName: 'my-team',
          config: { name: 'My Team' },
          tasks: [],
          members: [],
          kanbanState: { teamName: 'my-team', reviewers: [], tasks: {} },
          processes: [],
        },
      },
    });

    await store.getState().restoreTeam('my-team');

    expect(hoisted.restoreTeam).toHaveBeenCalledWith('my-team');
    expect(store.getState().teamDataCacheByName['my-team']).toBeUndefined();
  });

  it('clears team-scoped selector and transient caches on delete and restore flows', async () => {
    const store = createSliceStore();
    const message = {
      from: 'alice',
      to: 'team-lead',
      text: 'hello',
      timestamp: '2026-03-12T10:00:00.000Z',
      messageId: 'm-1',
      source: 'inbox' as const,
    };

    store.setState({
      selectedTeamName: 'my-team',
      selectedTeamData: createTeamSnapshot({
        members: [
          {
            name: 'alice',
            role: 'developer',
            currentTaskId: null,
          },
        ],
      }),
      teamDataCacheByName: {
        'my-team': createTeamSnapshot({
          members: [
            {
              name: 'alice',
              role: 'developer',
              currentTaskId: null,
            },
          ],
        }),
      },
      teamMessagesByName: {
        'my-team': {
          canonicalMessages: [message],
          optimisticMessages: [],
          nextCursor: null,
          hasMore: false,
          feedRevision: 'rev-1',
          lastFetchedAt: Date.now(),
          loadingHead: false,
          loadingOlder: false,
          headHydrated: true,
        },
      },
      memberActivityMetaByTeam: {
        'my-team': {
          teamName: 'my-team',
          computedAt: '2026-03-12T10:00:00.000Z',
          feedRevision: 'rev-1',
          members: {
            alice: {
              memberName: 'alice',
              lastAuthoredMessageAt: '2026-03-12T10:00:00.000Z',
              messageCountExact: 1,
              latestAuthoredMessageSignalsTermination: false,
            },
          },
        },
      },
    });

    selectResolvedMembersForTeamName(store.getState(), 'my-team');
    selectResolvedMemberForTeamName(store.getState(), 'my-team', 'alice');
    selectMemberMessagesForTeamMember(store.getState(), 'my-team', 'alice');

    await store.getState().refreshTeamData('my-team', { withDedup: false });
    store.getState().syncTeamPendingReplyRefresh('my-team', 'test-source', true);

    expect(__getTeamScopedTransientStateForTests('my-team')).toMatchObject({
      hasResolvedMembersSelector: true,
      resolvedMemberSelectorCount: 1,
      hasMergedMessagesSelector: true,
      memberMessagesSelectorCount: 1,
      hasLastResolvedTeamDataRefresh: true,
    });

    await store.getState().deleteTeam('my-team');

    expect(__getTeamScopedTransientStateForTests('my-team')).toEqual({
      hasResolvedMembersSelector: false,
      resolvedMemberSelectorCount: 0,
      hasMergedMessagesSelector: false,
      memberMessagesSelectorCount: 0,
      hasPendingFreshTeamDataRefresh: false,
      hasQueuedFullTeamDataRefreshAfterThin: false,
      hasPostPaintTeamEnrichmentTimer: false,
      hasQueuedHeadRefreshAfterOlder: false,
      hasPendingFreshMessagesHeadRefresh: false,
      hasPendingFreshMemberActivityMetaRefresh: false,
      hasLastResolvedTeamDataRefresh: false,
      hasCurrentLocalStateEpoch: true,
      hasMemberSpawnStatusesIpcBackoff: false,
      hasTeamRefreshBurstDiagnostics: false,
      hasMemberSpawnUiEqualLastWarn: false,
    });
    expect(store.getState().leadActivityByTeam['my-team']).toBeUndefined();
    expect(store.getState().leadContextByTeam['my-team']).toBeUndefined();
    expect(store.getState().memberSpawnStatusesByTeam['my-team']).toBeUndefined();
    expect(store.getState().memberSpawnSnapshotsByTeam['my-team']).toBeUndefined();

    store.setState({
      teamDataCacheByName: {
        'my-team': createTeamSnapshot({
          members: [
            {
              name: 'alice',
              role: 'developer',
              currentTaskId: null,
            },
          ],
        }),
      },
      teamMessagesByName: {
        'my-team': {
          canonicalMessages: [message],
          optimisticMessages: [],
          nextCursor: null,
          hasMore: false,
          feedRevision: 'rev-1',
          lastFetchedAt: Date.now(),
          loadingHead: false,
          loadingOlder: false,
          headHydrated: true,
        },
      },
      memberActivityMetaByTeam: {
        'my-team': {
          teamName: 'my-team',
          computedAt: '2026-03-12T10:00:00.000Z',
          feedRevision: 'rev-1',
          members: {
            alice: {
              memberName: 'alice',
              lastAuthoredMessageAt: '2026-03-12T10:00:00.000Z',
              messageCountExact: 1,
              latestAuthoredMessageSignalsTermination: false,
            },
          },
        },
      },
      leadActivityByTeam: {
        'my-team': 'active',
      },
      leadContextByTeam: {
        'my-team': {
          currentTokens: 12,
          contextWindow: 100,
          percent: 12,
          updatedAt: '2026-03-12T10:00:00.000Z',
        },
      },
      memberSpawnStatusesByTeam: {
        'my-team': {
          alice: createMemberSpawnStatus(),
        },
      },
      memberSpawnSnapshotsByTeam: {
        'my-team': createMemberSpawnSnapshot(),
      },
    });
    selectResolvedMembersForTeamName(store.getState(), 'my-team');
    selectResolvedMemberForTeamName(store.getState(), 'my-team', 'alice');
    selectMemberMessagesForTeamMember(store.getState(), 'my-team', 'alice');

    expect(__getTeamScopedTransientStateForTests('my-team')).toMatchObject({
      hasResolvedMembersSelector: true,
      resolvedMemberSelectorCount: 1,
      hasMergedMessagesSelector: true,
      memberMessagesSelectorCount: 1,
    });

    await store.getState().restoreTeam('my-team');

    expect(__getTeamScopedTransientStateForTests('my-team')).toEqual({
      hasResolvedMembersSelector: false,
      resolvedMemberSelectorCount: 0,
      hasMergedMessagesSelector: false,
      memberMessagesSelectorCount: 0,
      hasPendingFreshTeamDataRefresh: false,
      hasQueuedFullTeamDataRefreshAfterThin: false,
      hasPostPaintTeamEnrichmentTimer: false,
      hasQueuedHeadRefreshAfterOlder: false,
      hasPendingFreshMessagesHeadRefresh: false,
      hasPendingFreshMemberActivityMetaRefresh: false,
      hasLastResolvedTeamDataRefresh: false,
      hasCurrentLocalStateEpoch: true,
      hasMemberSpawnStatusesIpcBackoff: false,
      hasTeamRefreshBurstDiagnostics: false,
      hasMemberSpawnUiEqualLastWarn: false,
    });
    expect(store.getState().leadActivityByTeam['my-team']).toBeUndefined();
    expect(store.getState().leadContextByTeam['my-team']).toBeUndefined();
    expect(store.getState().memberSpawnStatusesByTeam['my-team']).toBeUndefined();
    expect(store.getState().memberSpawnSnapshotsByTeam['my-team']).toBeUndefined();
  });

  it('ignores stale async team snapshot and message refreshes after delete invalidates the team', async () => {
    const store = createSliceStore();
    const deferredData = createDeferredPromise<ReturnType<typeof createTeamSnapshot>>();
    const deferredMessages = createDeferredPromise<{
      messages: Array<{
        from: string;
        text: string;
        timestamp: string;
        messageId: string;
        source: 'inbox';
      }>;
      nextCursor: null;
      hasMore: false;
      feedRevision: string;
    }>();
    const deferredMeta = createDeferredPromise<{
      teamName: string;
      computedAt: string;
      feedRevision: string;
      members: Record<
        string,
        {
          memberName: string;
          lastAuthoredMessageAt: string | null;
          messageCountExact: number;
          latestAuthoredMessageSignalsTermination: boolean;
        }
      >;
    }>();

    hoisted.getData.mockImplementation(() => deferredData.promise);
    hoisted.getMessagesPage.mockImplementation(() => deferredMessages.promise);
    hoisted.getMemberActivityMeta.mockImplementation(() => deferredMeta.promise);

    store.setState({
      teamMessagesByName: {
        'my-team': {
          canonicalMessages: [],
          optimisticMessages: [],
          nextCursor: null,
          hasMore: false,
          feedRevision: 'rev-0',
          lastFetchedAt: Date.now(),
          loadingHead: false,
          loadingOlder: false,
          headHydrated: true,
        },
      },
    });

    const refreshDataPromise = store.getState().refreshTeamData('my-team', { withDedup: false });
    const refreshMessagesPromise = store.getState().refreshTeamMessagesHead('my-team');
    const refreshMetaPromise = store.getState().refreshMemberActivityMeta('my-team');

    await Promise.resolve();
    await store.getState().deleteTeam('my-team');

    deferredData.resolve(
      createTeamSnapshot({
        members: [{ name: 'alice', role: 'developer', currentTaskId: null }],
      })
    );
    deferredMessages.resolve({
      messages: [
        {
          from: 'alice',
          text: 'late-message',
          timestamp: '2026-03-12T10:00:00.000Z',
          messageId: 'late-1',
          source: 'inbox',
        },
      ],
      nextCursor: null,
      hasMore: false,
      feedRevision: 'rev-late',
    });
    deferredMeta.resolve({
      teamName: 'my-team',
      computedAt: '2026-03-12T10:00:00.000Z',
      feedRevision: 'rev-late',
      members: {
        alice: {
          memberName: 'alice',
          lastAuthoredMessageAt: '2026-03-12T10:00:00.000Z',
          messageCountExact: 1,
          latestAuthoredMessageSignalsTermination: false,
        },
      },
    });

    await Promise.all([refreshDataPromise, refreshMessagesPromise, refreshMetaPromise]);

    expect(store.getState().teamDataCacheByName['my-team']).toBeUndefined();
    expect(store.getState().teamMessagesByName['my-team']).toBeUndefined();
    expect(store.getState().memberActivityMetaByTeam['my-team']).toBeUndefined();
  });

  it('ignores stale async team refreshes after launch starts a new local epoch for the same team', async () => {
    const store = createSliceStore();
    const existingData = createTeamSnapshot({
      config: { name: 'My Team Before Launch' },
      members: [{ name: 'lead', role: 'lead', currentTaskId: null }],
    });
    const existingMeta: {
      teamName: string;
      computedAt: string;
      feedRevision: string;
      members: Record<
        string,
        {
          memberName: string;
          lastAuthoredMessageAt: string | null;
          messageCountExact: number;
          latestAuthoredMessageSignalsTermination: boolean;
        }
      >;
    } = {
      teamName: 'my-team',
      computedAt: '2026-03-12T09:59:00.000Z',
      feedRevision: 'rev-0',
      members: {
        lead: {
          memberName: 'lead',
          lastAuthoredMessageAt: '2026-03-12T09:59:00.000Z',
          messageCountExact: 1,
          latestAuthoredMessageSignalsTermination: false,
        },
      },
    };
    const deferredData = createDeferredPromise<ReturnType<typeof createTeamSnapshot>>();
    const deferredMessages = createDeferredPromise<{
      messages: Array<{
        from: string;
        text: string;
        timestamp: string;
        messageId: string;
        source: 'inbox';
      }>;
      nextCursor: null;
      hasMore: false;
      feedRevision: string;
    }>();
    const deferredMeta = createDeferredPromise<typeof existingMeta>();

    hoisted.getData.mockImplementation(() => deferredData.promise);
    hoisted.getMessagesPage.mockImplementation(() => deferredMessages.promise);
    hoisted.getMemberActivityMeta.mockImplementation(() => deferredMeta.promise);

    store.setState({
      selectedTeamName: 'my-team',
      selectedTeamData: existingData,
      teamDataCacheByName: {
        'my-team': existingData,
      },
      teamMessagesByName: {
        'my-team': {
          canonicalMessages: [],
          optimisticMessages: [],
          nextCursor: null,
          hasMore: false,
          feedRevision: 'rev-0',
          lastFetchedAt: Date.now(),
          loadingHead: false,
          loadingOlder: false,
          headHydrated: true,
        },
      },
      memberActivityMetaByTeam: {
        'my-team': existingMeta,
      },
    });

    const refreshDataPromise = store.getState().refreshTeamData('my-team', { withDedup: false });
    const refreshMessagesPromise = store.getState().refreshTeamMessagesHead('my-team');
    const refreshMetaPromise = store.getState().refreshMemberActivityMeta('my-team');

    await Promise.resolve();
    await store.getState().launchTeam({
      teamName: 'my-team',
      cwd: '/tmp/project',
    });

    expect(store.getState().teamMessagesByName['my-team']?.loadingHead).toBe(false);

    deferredData.resolve(
      createTeamSnapshot({
        config: { name: 'My Team Stale After Launch' },
        members: [{ name: 'alice', role: 'reviewer', currentTaskId: null }],
      })
    );
    deferredMessages.resolve({
      messages: [
        {
          from: 'alice',
          text: 'stale-after-launch',
          timestamp: '2026-03-12T10:00:00.000Z',
          messageId: 'stale-after-launch-1',
          source: 'inbox',
        },
      ],
      nextCursor: null,
      hasMore: false,
      feedRevision: 'rev-stale-after-launch',
    });
    deferredMeta.resolve({
      teamName: 'my-team',
      computedAt: '2026-03-12T10:00:00.000Z',
      feedRevision: 'rev-stale-after-launch',
      members: {
        alice: {
          memberName: 'alice',
          lastAuthoredMessageAt: '2026-03-12T10:00:00.000Z',
          messageCountExact: 3,
          latestAuthoredMessageSignalsTermination: false,
        },
      },
    });

    await Promise.all([refreshDataPromise, refreshMessagesPromise, refreshMetaPromise]);

    expect(store.getState().selectedTeamData).toBe(existingData);
    expect(store.getState().teamDataCacheByName['my-team']).toBe(existingData);
    expect(store.getState().teamMessagesByName['my-team']?.feedRevision).toBe('rev-0');
    expect(store.getState().memberActivityMetaByTeam['my-team']).toEqual(existingMeta);
  });

  it('clears stale selectedTeamLoading when launch invalidates an in-flight selectTeam request', async () => {
    const store = createSliceStore();
    const existingData = createTeamSnapshot({
      config: { name: 'My Team Cached' },
      members: [{ name: 'lead', role: 'lead', currentTaskId: null }],
    });
    const deferredData = createDeferredPromise<ReturnType<typeof createTeamSnapshot>>();

    hoisted.getData.mockImplementationOnce(() => deferredData.promise);

    store.setState({
      teamDataCacheByName: {
        'my-team': existingData,
      },
    });

    const selectPromise = store.getState().selectTeam('my-team');
    await Promise.resolve();

    expect(store.getState().selectedTeamLoading).toBe(true);
    expect(store.getState().selectedTeamData).toEqual(existingData);

    await store.getState().launchTeam({
      teamName: 'my-team',
      cwd: '/tmp/project',
    });

    expect(store.getState().selectedTeamLoading).toBe(false);
    expect(store.getState().selectedTeamError).toBeNull();
    expect(store.getState().selectedTeamData).toEqual(existingData);

    deferredData.resolve(
      createTeamSnapshot({
        config: { name: 'My Team Stale Select' },
        members: [{ name: 'alice', role: 'reviewer', currentTaskId: null }],
      })
    );
    await selectPromise;

    expect(store.getState().selectedTeamLoading).toBe(false);
    expect(store.getState().selectedTeamData).toEqual(existingData);
  });

  it('clears stale loadingOlder when launch invalidates an in-flight older messages request', async () => {
    const store = createSliceStore();
    const olderRequest = createDeferredPromise<{
      messages: Array<{
        from: string;
        text: string;
        timestamp: string;
        read: boolean;
        source: string;
        messageId: string;
      }>;
      nextCursor: string | null;
      hasMore: boolean;
      feedRevision: string;
    }>();

    store.setState({
      teamMessagesByName: {
        'my-team': {
          canonicalMessages: [],
          optimisticMessages: [],
          feedRevision: 'rev-1',
          nextCursor: 'cursor-older',
          hasMore: true,
          lastFetchedAt: 123,
          loadingHead: false,
          loadingOlder: false,
          headHydrated: true,
        },
      },
    });

    hoisted.getMessagesPage.mockImplementationOnce(() => olderRequest.promise);

    const olderPromise = store.getState().loadOlderTeamMessages('my-team');
    await Promise.resolve();
    expect(store.getState().teamMessagesByName['my-team']?.loadingOlder).toBe(true);

    await store.getState().launchTeam({
      teamName: 'my-team',
      cwd: '/tmp/project',
    });

    expect(store.getState().teamMessagesByName['my-team']?.loadingOlder).toBe(false);

    olderRequest.resolve({
      messages: [
        {
          from: 'bob',
          text: 'Older tail',
          timestamp: '2026-03-20T08:00:00.000Z',
          read: true,
          source: 'inbox',
          messageId: 'msg-1',
        },
      ],
      nextCursor: null,
      hasMore: false,
      feedRevision: 'rev-1',
    });

    await olderPromise;
    expect(store.getState().teamMessagesByName['my-team']?.loadingOlder).toBe(false);
  });

  it('ignores stale refreshTeamData failures after launch starts a new local epoch', async () => {
    const store = createSliceStore();
    const existingData = createTeamSnapshot({
      config: { name: 'My Team Stable' },
      members: [{ name: 'lead', role: 'lead', currentTaskId: null }],
    });
    const deferredData = createDeferredPromise<ReturnType<typeof createTeamSnapshot>>();

    hoisted.getData.mockImplementation(() => deferredData.promise);

    store.setState({
      selectedTeamName: 'my-team',
      selectedTeamData: existingData,
      teamDataCacheByName: {
        'my-team': existingData,
      },
      selectedTeamError: null,
    });

    const refreshPromise = store.getState().refreshTeamData('my-team', { withDedup: false });
    await Promise.resolve();
    await store.getState().launchTeam({
      teamName: 'my-team',
      cwd: '/tmp/project',
    });

    deferredData.reject(new Error('TEAM_DRAFT'));
    await refreshPromise;

    expect(store.getState().selectedTeamData).toBe(existingData);
    expect(store.getState().teamDataCacheByName['my-team']).toBe(existingData);
    expect(store.getState().selectedTeamError).toBeNull();
  });

  it('keeps the newer messages-head request pinned when a stale pre-launch request settles', async () => {
    const store = createSliceStore();
    const deferredOld = createDeferredPromise<{
      messages: Array<{
        from: string;
        text: string;
        timestamp: string;
        messageId: string;
        source: 'inbox';
      }>;
      nextCursor: null;
      hasMore: false;
      feedRevision: string;
    }>();
    const deferredNew = createDeferredPromise<{
      messages: Array<{
        from: string;
        text: string;
        timestamp: string;
        messageId: string;
        source: 'inbox';
      }>;
      nextCursor: null;
      hasMore: false;
      feedRevision: string;
    }>();

    hoisted.getMessagesPage
      .mockImplementationOnce(() => deferredOld.promise)
      .mockImplementationOnce(() => deferredNew.promise);

    const firstPromise = store.getState().refreshTeamMessagesHead('my-team');
    await Promise.resolve();
    await store.getState().launchTeam({
      teamName: 'my-team',
      cwd: '/tmp/project',
    });

    const secondPromise = store.getState().refreshTeamMessagesHead('my-team');
    await Promise.resolve();

    deferredOld.reject(new Error('stale head failed'));
    await expect(firstPromise).resolves.toEqual({
      feedChanged: false,
      headChanged: false,
      feedRevision: null,
    });

    expect(hoisted.getMessagesPage).toHaveBeenCalledTimes(2);

    deferredNew.resolve({
      messages: [
        {
          from: 'bob',
          text: 'fresh-after-launch',
          timestamp: '2026-03-12T10:00:01.000Z',
          messageId: 'fresh-after-launch-1',
          source: 'inbox',
        },
      ],
      nextCursor: null,
      hasMore: false,
      feedRevision: 'rev-fresh-after-launch',
    });

    await secondPromise;

    expect(store.getState().teamMessagesByName['my-team']?.feedRevision).toBe(
      'rev-fresh-after-launch'
    );
  });

  it('does not reuse a pre-delete in-flight team snapshot request after the same team is reselected', async () => {
    const store = createSliceStore();
    const deferredOld = createDeferredPromise<ReturnType<typeof createTeamSnapshot>>();
    const freshSnapshot = createTeamSnapshot({
      config: { name: 'My Team Reloaded' },
      members: [{ name: 'bob', role: 'developer', currentTaskId: null }],
    });

    hoisted.getData
      .mockImplementationOnce(() => deferredOld.promise)
      .mockResolvedValueOnce(freshSnapshot);

    const firstSelectPromise = store.getState().selectTeam('my-team');
    await Promise.resolve();
    await store.getState().deleteTeam('my-team');

    const secondSelectPromise = store.getState().selectTeam('my-team');
    await secondSelectPromise;

    expect(hoisted.getData).toHaveBeenCalledTimes(2);
    expect(store.getState().selectedTeamData).toEqual(freshSnapshot);

    deferredOld.resolve(
      createTeamSnapshot({
        config: { name: 'My Team Stale' },
        members: [{ name: 'alice', role: 'reviewer', currentTaskId: null }],
      })
    );
    await firstSelectPromise;

    expect(store.getState().selectedTeamData).toEqual(freshSnapshot);
  });

  it('does not reuse a pre-delete in-flight messages head request after the same team is reselected', async () => {
    const store = createSliceStore();
    const deferredOld = createDeferredPromise<{
      messages: Array<{
        from: string;
        text: string;
        timestamp: string;
        messageId: string;
        source: 'inbox';
      }>;
      nextCursor: null;
      hasMore: false;
      feedRevision: string;
    }>();

    hoisted.getMessagesPage
      .mockImplementationOnce(() => deferredOld.promise)
      .mockResolvedValueOnce({
        messages: [
          {
            from: 'bob',
            text: 'fresh-message',
            timestamp: '2026-03-12T10:00:01.000Z',
            messageId: 'fresh-1',
            source: 'inbox',
          },
        ],
        nextCursor: null,
        hasMore: false,
        feedRevision: 'rev-fresh',
      });

    const firstHeadPromise = store.getState().refreshTeamMessagesHead('my-team');
    await Promise.resolve();
    await store.getState().deleteTeam('my-team');

    const secondHeadPromise = store.getState().refreshTeamMessagesHead('my-team');
    await secondHeadPromise;

    expect(hoisted.getMessagesPage).toHaveBeenCalledTimes(2);
    expect(store.getState().teamMessagesByName['my-team']?.feedRevision).toBe('rev-fresh');
    expect(store.getState().teamMessagesByName['my-team']?.canonicalMessages).toEqual([
      {
        from: 'bob',
        text: 'fresh-message',
        timestamp: '2026-03-12T10:00:01.000Z',
        messageId: 'fresh-1',
        source: 'inbox',
      },
    ]);

    deferredOld.resolve({
      messages: [
        {
          from: 'alice',
          text: 'stale-message',
          timestamp: '2026-03-12T10:00:00.000Z',
          messageId: 'stale-1',
          source: 'inbox',
        },
      ],
      nextCursor: null,
      hasMore: false,
      feedRevision: 'rev-stale',
    });
    await firstHeadPromise;

    expect(store.getState().teamMessagesByName['my-team']?.feedRevision).toBe('rev-fresh');
  });

  it('tombstones current progress runs when delete clears a team so late progress cannot resurrect it', async () => {
    const store = createSliceStore();
    store.setState({
      provisioningRuns: {
        'run-live': {
          runId: 'run-live',
          teamName: 'my-team',
          state: 'assembling',
          message: 'Live run',
          startedAt: '2026-03-12T10:00:00.000Z',
          updatedAt: '2026-03-12T10:00:00.000Z',
        },
      },
      currentProvisioningRunIdByTeam: {
        'my-team': 'run-live',
      },
      currentRuntimeRunIdByTeam: {
        'my-team': 'run-live',
      },
      provisioningStartedAtFloorByTeam: {
        'my-team': '2026-03-12T10:00:00.000Z',
      },
    });

    await store.getState().deleteTeam('my-team');

    expect(store.getState().ignoredProvisioningRunIds['run-live']).toBe('my-team');
    expect(store.getState().ignoredRuntimeRunIds['run-live']).toBe('my-team');
    expect(store.getState().provisioningStartedAtFloorByTeam['my-team']).toBeTruthy();

    store.getState().onProvisioningProgress({
      runId: 'run-live',
      teamName: 'my-team',
      state: 'ready',
      message: 'Late zombie progress',
      startedAt: '2026-03-12T10:00:00.000Z',
      updatedAt: '2026-03-12T10:00:05.000Z',
    });

    expect(store.getState().provisioningRuns['run-live']).toBeUndefined();
    expect(store.getState().currentProvisioningRunIdByTeam['my-team']).toBeUndefined();
    expect(store.getState().currentRuntimeRunIdByTeam['my-team']).toBeUndefined();
  });

  it('stores runtime snapshots and suppresses semantic no-op refreshes', async () => {
    const store = createSliceStore();
    const snapshot = createRuntimeSnapshot();
    hoisted.getTeamAgentRuntime.mockResolvedValue(snapshot);

    await store.getState().fetchTeamAgentRuntime('my-team');
    const firstSnapshot = store.getState().teamAgentRuntimeByTeam['my-team'];

    expect(firstSnapshot).toEqual(snapshot);

    hoisted.getTeamAgentRuntime.mockResolvedValue({
      ...snapshot,
      updatedAt: '2026-03-12T10:00:05.000Z',
      members: {
        alice: {
          ...snapshot.members.alice,
          updatedAt: '2026-03-12T10:00:05.000Z',
        },
      },
    });

    await store.getState().fetchTeamAgentRuntime('my-team');

    expect(store.getState().teamAgentRuntimeByTeam['my-team']).toBe(firstSnapshot);
  });

  it('updates runtime snapshots when liveness diagnostics change', async () => {
    const store = createSliceStore();
    const snapshot = createRuntimeSnapshot();
    hoisted.getTeamAgentRuntime.mockResolvedValue(snapshot);

    await store.getState().fetchTeamAgentRuntime('my-team');
    const firstSnapshot = store.getState().teamAgentRuntimeByTeam['my-team'];

    const nextSnapshot = createRuntimeSnapshot({
      members: {
        alice: {
          ...snapshot.members.alice,
          alive: false,
          livenessKind: 'shell_only',
          pidSource: 'tmux_pane',
          runtimeDiagnostic: 'tmux pane foreground command is zsh',
          runtimeDiagnosticSeverity: 'warning',
        },
      },
    });
    hoisted.getTeamAgentRuntime.mockResolvedValue(nextSnapshot);

    await store.getState().fetchTeamAgentRuntime('my-team');

    expect(store.getState().teamAgentRuntimeByTeam['my-team']).not.toBe(firstSnapshot);
    expect(store.getState().teamAgentRuntimeByTeam['my-team']).toEqual(nextSnapshot);
  });

  it('updates runtime snapshots when copy-diagnostics details change', async () => {
    const store = createSliceStore();
    const snapshot = createRuntimeSnapshot({
      members: {
        alice: {
          memberName: 'alice',
          alive: false,
          restartable: true,
          backendType: 'tmux',
          pid: 42,
          livenessKind: 'shell_only',
          pidSource: 'tmux_pane',
          paneId: '%42',
          panePid: 42,
          paneCurrentCommand: 'zsh',
          runtimeDiagnostic: 'tmux pane foreground command is zsh',
          diagnostics: ['tmux pane foreground command is zsh'],
          updatedAt: '2026-03-12T10:00:00.000Z',
        },
      },
    });
    hoisted.getTeamAgentRuntime.mockResolvedValue(snapshot);

    await store.getState().fetchTeamAgentRuntime('my-team');
    const firstSnapshot = store.getState().teamAgentRuntimeByTeam['my-team'];

    const nextSnapshot = createRuntimeSnapshot({
      members: {
        alice: {
          ...snapshot.members.alice,
          processCommand: 'node runtime --token [redacted]',
          runtimeSessionId: 'session-alice',
          diagnostics: [
            'tmux pane foreground command is zsh',
            'no verified runtime descendant process was found',
          ],
        },
      },
    });
    hoisted.getTeamAgentRuntime.mockResolvedValue(nextSnapshot);

    await store.getState().fetchTeamAgentRuntime('my-team');

    expect(store.getState().teamAgentRuntimeByTeam['my-team']).not.toBe(firstSnapshot);
    expect(store.getState().teamAgentRuntimeByTeam['my-team']).toEqual(nextSnapshot);
  });

  it('updates runtime snapshots when historical bootstrap state changes', async () => {
    const store = createSliceStore();
    const snapshot = createRuntimeSnapshot();
    hoisted.getTeamAgentRuntime.mockResolvedValue(snapshot);

    await store.getState().fetchTeamAgentRuntime('my-team');
    const firstSnapshot = store.getState().teamAgentRuntimeByTeam['my-team'];

    const nextSnapshot = createRuntimeSnapshot({
      members: {
        alice: {
          ...snapshot.members.alice,
          alive: false,
          historicalBootstrapConfirmed: true,
        },
      },
    });
    hoisted.getTeamAgentRuntime.mockResolvedValue(nextSnapshot);

    await store.getState().fetchTeamAgentRuntime('my-team');

    expect(store.getState().teamAgentRuntimeByTeam['my-team']).not.toBe(firstSnapshot);
    expect(store.getState().teamAgentRuntimeByTeam['my-team']).toEqual(nextSnapshot);
  });

  it('restartMember refreshes spawn statuses and runtime snapshot', async () => {
    const store = createSliceStore();
    hoisted.getMemberSpawnStatuses.mockResolvedValue({
      statuses: {
        alice: createMemberSpawnStatus({ status: 'spawning', launchState: 'starting' }),
      },
      runId: 'runtime-run',
    });
    hoisted.getTeamAgentRuntime.mockResolvedValue(createRuntimeSnapshot());

    await store.getState().restartMember('my-team', 'alice');

    expect(hoisted.restartMember).toHaveBeenCalledWith('my-team', 'alice');
    expect(store.getState().memberSpawnStatusesByTeam['my-team']).toEqual({
      alice: expect.objectContaining({ status: 'spawning', launchState: 'starting' }),
    });
    expect(store.getState().teamAgentRuntimeByTeam['my-team']).toEqual(createRuntimeSnapshot());
  });

  it('retryFailedOpenCodeSecondaryLanes refreshes only spawn statuses and runtime snapshot', async () => {
    const store = createSliceStore();
    const refreshSpawnStatuses = vi.fn(async (_teamName: string) => undefined);
    const refreshRuntimeSnapshot = vi.fn(async (_teamName: string) => undefined);
    const refreshTeamData = vi.fn(async (_teamName: string) => undefined);
    const fetchTeams = vi.fn(async () => undefined);
    store.setState({
      fetchMemberSpawnStatuses: refreshSpawnStatuses,
      fetchTeamAgentRuntime: refreshRuntimeSnapshot,
      refreshTeamData,
      fetchTeams,
    });
    hoisted.retryFailedOpenCodeSecondaryLanes.mockResolvedValueOnce({
      attempted: ['alice'],
      confirmed: [],
      pending: [],
      failed: [{ memberName: 'alice', error: 'OpenRouter credits exhausted' }],
      skipped: [],
    });

    const result = await store.getState().retryFailedOpenCodeSecondaryLanes('my-team');

    expect(result.failed).toEqual([{ memberName: 'alice', error: 'OpenRouter credits exhausted' }]);
    expect(hoisted.retryFailedOpenCodeSecondaryLanes).toHaveBeenCalledWith('my-team');
    expect(refreshSpawnStatuses).toHaveBeenCalledWith('my-team');
    expect(refreshRuntimeSnapshot).toHaveBeenCalledWith('my-team');
    expect(refreshTeamData).not.toHaveBeenCalled();
    expect(fetchTeams).not.toHaveBeenCalled();
  });

  it('restartMember refreshes spawn statuses and runtime snapshot even when restart fails', async () => {
    const store = createSliceStore();
    const refreshSpawnStatuses = vi.fn(async (_teamName: string) => undefined);
    const refreshRuntimeSnapshot = vi.fn(async (_teamName: string) => undefined);
    store.setState({
      fetchMemberSpawnStatuses: refreshSpawnStatuses,
      fetchTeamAgentRuntime: refreshRuntimeSnapshot,
    });
    hoisted.restartMember.mockRejectedValueOnce(new Error('restart failed'));

    await expect(store.getState().restartMember('my-team', 'alice')).rejects.toThrow(
      'restart failed'
    );

    expect(refreshSpawnStatuses).toHaveBeenCalledWith('my-team');
    expect(refreshRuntimeSnapshot).toHaveBeenCalledWith('my-team');
  });

  it('skipMemberForLaunch refreshes spawn statuses, runtime snapshot, and team list', async () => {
    const store = createSliceStore();
    const refreshTeams = vi.fn(async () => undefined);
    store.setState({ fetchTeams: refreshTeams });
    hoisted.getMemberSpawnStatuses.mockResolvedValue({
      statuses: {
        alice: createMemberSpawnStatus({
          status: 'skipped',
          launchState: 'skipped_for_launch',
          skippedForLaunch: true,
        }),
      },
      runId: 'runtime-run',
    });
    hoisted.getTeamAgentRuntime.mockResolvedValue(createRuntimeSnapshot());

    await store.getState().skipMemberForLaunch('my-team', 'alice');

    expect(hoisted.skipMemberForLaunch).toHaveBeenCalledWith('my-team', 'alice');
    expect(store.getState().memberSpawnStatusesByTeam['my-team']).toEqual({
      alice: expect.objectContaining({
        status: 'skipped',
        launchState: 'skipped_for_launch',
        skippedForLaunch: true,
      }),
    });
    expect(store.getState().teamAgentRuntimeByTeam['my-team']).toEqual(createRuntimeSnapshot());
    expect(refreshTeams).toHaveBeenCalled();
  });

  it('skipMemberForLaunch refreshes launch data even when skip fails', async () => {
    const store = createSliceStore();
    const refreshSpawnStatuses = vi.fn(async (_teamName: string) => undefined);
    const refreshRuntimeSnapshot = vi.fn(async (_teamName: string) => undefined);
    const refreshTeams = vi.fn(async () => undefined);
    store.setState({
      fetchMemberSpawnStatuses: refreshSpawnStatuses,
      fetchTeamAgentRuntime: refreshRuntimeSnapshot,
      fetchTeams: refreshTeams,
    });
    hoisted.skipMemberForLaunch.mockRejectedValueOnce(new Error('skip failed'));

    await expect(store.getState().skipMemberForLaunch('my-team', 'alice')).rejects.toThrow(
      'skip failed'
    );

    expect(refreshSpawnStatuses).toHaveBeenCalledWith('my-team');
    expect(refreshRuntimeSnapshot).toHaveBeenCalledWith('my-team');
    expect(refreshTeams).toHaveBeenCalled();
  });

  it('clears stale runtime snapshots on delete', async () => {
    const store = createSliceStore();
    store.setState({
      teamAgentRuntimeByTeam: {
        'my-team': createRuntimeSnapshot(),
      },
    });

    await store.getState().deleteTeam('my-team');

    expect(store.getState().teamAgentRuntimeByTeam['my-team']).toBeUndefined();
  });

  describe('refreshTeamData provisioning safety', () => {
    it('does not set fatal error on TEAM_PROVISIONING', async () => {
      const store = createSliceStore();
      // First, select a team so selectedTeamName is set
      store.setState({
        selectedTeamName: 'my-team',
        selectedTeamData: {
          teamName: 'my-team',
          config: { name: 'My Team' },
          tasks: [],
          members: [],
          kanbanState: { teamName: 'my-team', reviewers: [], tasks: {} },
        },
        selectedTeamError: null,
      });

      hoisted.getData.mockRejectedValue(new Error('TEAM_PROVISIONING'));

      await store.getState().refreshTeamData('my-team');

      // Should NOT set error — team is still provisioning
      expect(store.getState().selectedTeamError).toBeNull();
      // Should preserve existing data
      expect(store.getState().selectedTeamData).not.toBeNull();
      expect(store.getState().selectedTeamData?.teamName).toBe('my-team');
    });

    it('preserves existing data on transient refresh error', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const store = createSliceStore();
      const existingData = {
        teamName: 'my-team',
        config: { name: 'My Team' },
        tasks: [],
        members: [],
        kanbanState: { teamName: 'my-team', reviewers: [], tasks: {} },
      };
      store.setState({
        selectedTeamName: 'my-team',
        selectedTeamData: existingData,
        selectedTeamError: null,
      });

      hoisted.getData.mockRejectedValue(new Error('Network timeout'));

      await store.getState().refreshTeamData('my-team');

      // Should NOT replace data with error — preserve existing data
      expect(store.getState().selectedTeamError).toBeNull();
      expect(store.getState().selectedTeamData).toEqual(existingData);
    });

    it('reuses the existing selectedTeamData ref on a semantic no-op refresh', async () => {
      const store = createSliceStore();
      const existingData = createTeamSnapshot({
        tasks: [
          {
            id: 'task-1',
            subject: 'Stable task',
            status: 'pending',
            createdAt: '2026-03-20T08:00:00.000Z',
            updatedAt: '2026-03-20T08:00:00.000Z',
          },
        ],
        members: [
          {
            name: 'alice',
            currentTaskId: 'task-1',
            taskCount: 1,
          },
        ],
      });

      store.setState({
        selectedTeamName: 'my-team',
        selectedTeamData: existingData,
        teamDataCacheByName: {
          'my-team': existingData,
        },
        selectedTeamError: 'stale error',
      });

      hoisted.getData.mockResolvedValue({
        ...existingData,
        tasks: existingData.tasks.map((task: any) => ({ ...task })),
        members: existingData.members.map((member: any) => ({ ...member })),
        kanbanState: {
          ...existingData.kanbanState,
          reviewers: [...existingData.kanbanState.reviewers],
          tasks: { ...existingData.kanbanState.tasks },
        },
        processes: [...existingData.processes],
      });

      await store.getState().refreshTeamData('my-team');

      expect(store.getState().selectedTeamData).toBe(existingData);
      expect(store.getState().teamDataCacheByName['my-team']).toBe(existingData);
      expect(store.getState().selectedTeamError).toBeNull();
    });

    it('memoizes focused resolved member selection against unrelated member activity churn', () => {
      const aliceSnapshot = {
        name: 'alice',
        currentTaskId: null,
        taskCount: 0,
        role: 'Reviewer',
      };
      const bobSnapshot = {
        name: 'bob',
        currentTaskId: null,
        taskCount: 0,
        role: 'Builder',
      };
      const baseState = {
        selectedTeamName: 'my-team',
        selectedTeamData: null,
        teamDataCacheByName: {
          'my-team': createTeamSnapshot({
            members: [aliceSnapshot, bobSnapshot],
          }),
        },
        memberActivityMetaByTeam: {
          'my-team': {
            teamName: 'my-team',
            computedAt: '2026-03-12T10:00:00.000Z',
            feedRevision: 'rev-1',
            members: {
              alice: {
                memberName: 'alice',
                lastAuthoredMessageAt: '2026-03-12T10:00:00.000Z',
                messageCountExact: 3,
                latestAuthoredMessageSignalsTermination: false,
              },
              bob: {
                memberName: 'bob',
                lastAuthoredMessageAt: '2026-03-12T10:01:00.000Z',
                messageCountExact: 1,
                latestAuthoredMessageSignalsTermination: false,
              },
            },
          },
        },
      };

      const firstAlice = selectResolvedMemberForTeamName(baseState as never, 'my-team', 'alice');
      const nextState = {
        ...baseState,
        memberActivityMetaByTeam: {
          'my-team': {
            ...baseState.memberActivityMetaByTeam['my-team'],
            computedAt: '2026-03-12T10:02:00.000Z',
            feedRevision: 'rev-2',
            members: {
              ...baseState.memberActivityMetaByTeam['my-team'].members,
              bob: {
                ...baseState.memberActivityMetaByTeam['my-team'].members.bob,
                messageCountExact: 2,
              },
            },
          },
        },
      };

      const secondAlice = selectResolvedMemberForTeamName(nextState as never, 'my-team', 'alice');

      expect(firstAlice).not.toBeNull();
      expect(secondAlice).toBe(firstAlice);
    });

    it('re-canonicalizes selectedTeamData into the cache on a no-op refresh', async () => {
      const store = createSliceStore();
      const existingData = createTeamSnapshot({
        tasks: [
          {
            id: 'task-1',
            subject: 'Stable task',
            status: 'pending',
            createdAt: '2026-03-20T08:00:00.000Z',
            updatedAt: '2026-03-20T08:00:00.000Z',
          },
        ],
      });

      store.setState({
        selectedTeamName: 'my-team',
        selectedTeamData: existingData,
        teamDataCacheByName: {},
      });

      hoisted.getData.mockResolvedValue({
        ...existingData,
        tasks: existingData.tasks.map((task: any) => ({ ...task })),
        members: existingData.members.map((member: any) => ({ ...member })),
        kanbanState: {
          ...existingData.kanbanState,
          reviewers: [...existingData.kanbanState.reviewers],
          tasks: { ...existingData.kanbanState.tasks },
        },
        processes: [...existingData.processes],
      });

      await store.getState().refreshTeamData('my-team');

      expect(store.getState().teamDataCacheByName['my-team']).toBe(existingData);
      expect(store.getState().selectedTeamData).toBe(existingData);
    });

    it('clears non-selected cache on TEAM_DRAFT refresh failure', async () => {
      const store = createSliceStore();
      store.setState({
        selectedTeamName: 'other-team',
        selectedTeamData: {
          teamName: 'other-team',
          config: { name: 'Other Team' },
          tasks: [],
          members: [],
          kanbanState: { teamName: 'other-team', reviewers: [], tasks: {} },
          processes: [],
        },
        teamDataCacheByName: {
          'my-team': {
            teamName: 'my-team',
            config: { name: 'My Team' },
            tasks: [],
            members: [],
            kanbanState: { teamName: 'my-team', reviewers: [], tasks: {} },
            processes: [],
          },
        },
      });

      hoisted.getData.mockRejectedValue(new Error('TEAM_DRAFT'));

      await store.getState().refreshTeamData('my-team');

      expect(store.getState().teamDataCacheByName['my-team']).toBeUndefined();
      expect(store.getState().selectedTeamData?.teamName).toBe('other-team');
    });

    it('clears non-selected cache when the team no longer exists', async () => {
      const store = createSliceStore();
      store.setState({
        selectedTeamName: 'other-team',
        selectedTeamData: {
          teamName: 'other-team',
          config: { name: 'Other Team' },
          tasks: [],
          members: [],
          kanbanState: { teamName: 'other-team', reviewers: [], tasks: {} },
          processes: [],
        },
        teamDataCacheByName: {
          'my-team': {
            teamName: 'my-team',
            config: { name: 'My Team' },
            tasks: [],
            members: [],
            kanbanState: { teamName: 'my-team', reviewers: [], tasks: {} },
            processes: [],
          },
        },
      });

      hoisted.getData.mockRejectedValue(new Error('Team not found: my-team'));

      await store.getState().refreshTeamData('my-team');

      expect(store.getState().teamDataCacheByName['my-team']).toBeUndefined();
      expect(store.getState().selectedTeamData?.teamName).toBe('other-team');
    });

    it('clears stale selectedTeamError when TEAM_PROVISIONING with existing data', async () => {
      const store = createSliceStore();
      store.setState({
        selectedTeamName: 'my-team',
        selectedTeamData: {
          teamName: 'my-team',
          config: { name: 'My Team' },
          tasks: [],
          members: [],
          kanbanState: { teamName: 'my-team', reviewers: [], tasks: {} },
        },
        selectedTeamError: 'Previous failure',
      });

      hoisted.getData.mockRejectedValue(new Error('TEAM_PROVISIONING'));

      await store.getState().refreshTeamData('my-team');

      // Stale error should be cleared even though provisioning prevents new data
      expect(store.getState().selectedTeamError).toBeNull();
      expect(store.getState().selectedTeamData).not.toBeNull();
    });

    it('clears stale selectedTeamError on transient error when data exists', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const store = createSliceStore();
      const existingData = {
        teamName: 'my-team',
        config: { name: 'My Team' },
        tasks: [],
        members: [],
        kanbanState: { teamName: 'my-team', reviewers: [], tasks: {} },
      };
      store.setState({
        selectedTeamName: 'my-team',
        selectedTeamData: existingData,
        selectedTeamError: 'Old stale error',
      });

      hoisted.getData.mockRejectedValue(new Error('Network timeout'));

      await store.getState().refreshTeamData('my-team');

      // Stale error should be cleared because we still have usable data
      expect(store.getState().selectedTeamError).toBeNull();
      expect(store.getState().selectedTeamData).toEqual(existingData);
    });

    it('sets error when no previous data exists', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const store = createSliceStore();
      store.setState({
        selectedTeamName: 'my-team',
        selectedTeamData: null,
        selectedTeamError: null,
      });

      hoisted.getData.mockRejectedValue(new Error('Team not found'));

      await store.getState().refreshTeamData('my-team');

      // No previous data — error should be shown
      expect(store.getState().selectedTeamError).toBe('Team not found');
    });

    it('invalidates changed task summaries without warming task availability on refresh', async () => {
      const store = createSliceStore();
      const invalidateTaskChangePresence = vi.fn();
      const warmTaskChangeSummaries = vi.fn(async () => undefined);
      store.setState({
        selectedTeamName: 'my-team',
        invalidateTaskChangePresence,
        warmTaskChangeSummaries,
        selectedTeamData: {
          teamName: 'my-team',
          config: { name: 'My Team' },
          tasks: [
            {
              id: 'task-1',
              subject: 'Old completed',
              status: 'completed',
              owner: 'alice',
              createdAt: '2026-03-01T10:00:00.000Z',
              updatedAt: '2026-03-01T10:00:00.000Z',
              workIntervals: [{ startedAt: '2026-03-01T10:05:00.000Z' }],
              historyEvents: [],
              comments: [],
              attachments: [],
            },
            {
              id: 'task-2',
              subject: 'Still approved',
              status: 'completed',
              owner: 'bob',
              createdAt: '2026-03-01T10:00:00.000Z',
              updatedAt: '2026-03-01T10:00:00.000Z',
              workIntervals: [{ startedAt: '2026-03-01T10:05:00.000Z' }],
              historyEvents: [
                {
                  id: 'evt-approved',
                  type: 'review_approved',
                  to: 'approved',
                  timestamp: '2026-03-01T10:10:00.000Z',
                },
              ],
              comments: [],
              attachments: [],
            },
          ],
          members: [],
          kanbanState: { teamName: 'my-team', reviewers: [], tasks: {} },
          processes: [],
        },
      });

      hoisted.getData.mockResolvedValue({
        teamName: 'my-team',
        config: { name: 'My Team' },
        tasks: [
          {
            id: 'task-1',
            subject: 'Moved to review',
            status: 'completed',
            owner: 'alice',
            createdAt: '2026-03-01T10:00:00.000Z',
            updatedAt: '2026-03-01T11:00:00.000Z',
            workIntervals: [{ startedAt: '2026-03-01T10:05:00.000Z' }],
            historyEvents: [
              {
                id: 'evt-review',
                type: 'review_requested',
                to: 'review',
                timestamp: '2026-03-01T11:00:00.000Z',
              },
            ],
            comments: [],
            attachments: [],
          },
          {
            id: 'task-2',
            subject: 'Still approved',
            status: 'completed',
            owner: 'bob',
            createdAt: '2026-03-01T10:00:00.000Z',
            updatedAt: '2026-03-01T10:00:00.000Z',
            workIntervals: [{ startedAt: '2026-03-01T10:05:00.000Z' }],
            historyEvents: [
              {
                id: 'evt-approved',
                type: 'review_approved',
                to: 'approved',
                timestamp: '2026-03-01T10:10:00.000Z',
              },
            ],
            comments: [],
            attachments: [],
          },
        ],
        members: [],
        kanbanState: { teamName: 'my-team', reviewers: [], tasks: {} },
        processes: [],
      });

      await store.getState().refreshTeamData('my-team');

      expect(hoisted.invalidateTaskChangeSummaries).toHaveBeenCalledWith('my-team', ['task-1']);
      expect(invalidateTaskChangePresence).toHaveBeenCalledTimes(1);
      expect(warmTaskChangeSummaries).not.toHaveBeenCalled();
    });

    it('preserves known task changePresence across refresh when task change signature is unchanged', async () => {
      const store = createSliceStore();
      store.setState({
        selectedTeamName: 'my-team',
        selectedTeamData: {
          teamName: 'my-team',
          config: { name: 'My Team' },
          tasks: [
            {
              id: 'task-1',
              subject: 'Known changes',
              status: 'in_progress',
              owner: 'alice',
              createdAt: '2026-03-01T10:00:00.000Z',
              updatedAt: '2026-03-01T10:00:00.000Z',
              workIntervals: [{ startedAt: '2026-03-01T10:05:00.000Z' }],
              historyEvents: [],
              comments: [],
              attachments: [],
              changePresence: 'has_changes',
            },
          ],
          members: [],
          kanbanState: { teamName: 'my-team', reviewers: [], tasks: {} },
          processes: [],
        },
      });

      hoisted.getData.mockResolvedValue({
        teamName: 'my-team',
        config: { name: 'My Team' },
        tasks: [
          {
            id: 'task-1',
            subject: 'Known changes',
            status: 'in_progress',
            owner: 'alice',
            createdAt: '2026-03-01T10:00:00.000Z',
            updatedAt: '2026-03-01T10:00:00.000Z',
            workIntervals: [{ startedAt: '2026-03-01T10:05:00.000Z' }],
            historyEvents: [],
            comments: [],
            attachments: [],
            changePresence: 'unknown',
          },
        ],
        members: [],
        kanbanState: { teamName: 'my-team', reviewers: [], tasks: {} },
        processes: [],
      });

      await store.getState().refreshTeamData('my-team');

      expect(store.getState().selectedTeamData?.tasks[0]?.changePresence).toBe('has_changes');
    });
  });

  describe('provisioning run scoping', () => {
    it('persists providerBackendId into createTeam launch params', async () => {
      const store = createSliceStore();

      await store.getState().createTeam({
        teamName: 'my-team',
        cwd: '/tmp/project',
        members: [],
        providerId: 'codex',
        providerBackendId: 'codex-native',
        model: 'gpt-5.4',
        effort: 'medium',
      });

      expect(store.getState().launchParamsByTeam['my-team']).toEqual({
        providerId: 'codex',
        providerBackendId: 'codex-native',
        model: 'gpt-5.4',
        effort: 'medium',
        limitContext: false,
      });
    });

    it('persists providerBackendId into launchTeam launch params', async () => {
      const store = createSliceStore();

      await store.getState().launchTeam({
        teamName: 'my-team',
        cwd: '/tmp/project',
        providerId: 'codex',
        providerBackendId: 'codex-native',
        model: 'gpt-5.4',
        effort: 'medium',
      });

      expect(store.getState().launchParamsByTeam['my-team']).toEqual({
        providerId: 'codex',
        providerBackendId: 'codex-native',
        model: 'gpt-5.4',
        effort: 'medium',
        limitContext: false,
      });
    });

    it('rolls back optimistic pending run on early createTeam failure', async () => {
      const store = createSliceStore();
      hoisted.createTeam.mockRejectedValue(new Error('create failed'));

      await expect(
        store.getState().createTeam({
          teamName: 'my-team',
          cwd: '/tmp/project',
          members: [],
        })
      ).rejects.toThrow('create failed');

      expect(store.getState().currentProvisioningRunIdByTeam['my-team']).toBeUndefined();
      expect(Object.values(store.getState().provisioningRuns)).toHaveLength(0);
      expect(store.getState().provisioningErrorByTeam['my-team']).toBe('create failed');
    });

    it('hydrates visible non-selected graph tabs when config becomes ready', () => {
      const store = createSliceStore();
      store.setState({
        selectedTeamName: 'other-team',
        selectedTeamData: {
          teamName: 'other-team',
          config: { name: 'Other Team' },
          tasks: [],
          members: [],
          kanbanState: { teamName: 'other-team', reviewers: [], tasks: {} },
          processes: [],
        },
        paneLayout: {
          focusedPaneId: 'pane-default',
          panes: [
            {
              id: 'pane-default',
              widthFraction: 1,
              tabs: [{ id: 'graph-1', type: 'graph', teamName: 'my-team', label: 'My Team' }],
              activeTabId: 'graph-1',
            },
          ],
        },
        currentProvisioningRunIdByTeam: {
          'my-team': 'run-current',
        },
      });

      const refreshTeamDataSpy = vi.spyOn(store.getState(), 'refreshTeamData');
      const selectTeamSpy = vi.spyOn(store.getState(), 'selectTeam');

      store.getState().onProvisioningProgress({
        runId: 'run-current',
        teamName: 'my-team',
        state: 'assembling',
        configReady: true,
        message: 'Config written',
        startedAt: '2026-03-12T10:00:00.000Z',
        updatedAt: '2026-03-12T10:00:01.000Z',
      });

      expect(refreshTeamDataSpy).toHaveBeenCalledWith('my-team', { withDedup: true });
      expect(selectTeamSpy).not.toHaveBeenCalled();
    });

    it('refreshes visible non-selected graph tabs when the canonical run reaches ready', () => {
      const store = createSliceStore();
      store.setState({
        selectedTeamName: 'other-team',
        selectedTeamData: {
          teamName: 'other-team',
          config: { name: 'Other Team' },
          tasks: [],
          members: [],
          kanbanState: { teamName: 'other-team', reviewers: [], tasks: {} },
          processes: [],
        },
        paneLayout: {
          focusedPaneId: 'pane-default',
          panes: [
            {
              id: 'pane-default',
              widthFraction: 1,
              tabs: [{ id: 'graph-1', type: 'graph', teamName: 'my-team', label: 'My Team' }],
              activeTabId: 'graph-1',
            },
          ],
        },
        currentProvisioningRunIdByTeam: {
          'my-team': 'run-current',
        },
      });

      const refreshTeamDataSpy = vi.spyOn(store.getState(), 'refreshTeamData');
      const selectTeamSpy = vi.spyOn(store.getState(), 'selectTeam');

      store.getState().onProvisioningProgress({
        runId: 'run-current',
        teamName: 'my-team',
        state: 'ready',
        message: 'Ready',
        startedAt: '2026-03-12T10:00:00.000Z',
        updatedAt: '2026-03-12T10:00:02.000Z',
      });

      expect(refreshTeamDataSpy).toHaveBeenCalledWith('my-team', { withDedup: true });
      expect(selectTeamSpy).not.toHaveBeenCalled();
    });

    it('keeps the current run pinned when stale progress from another run arrives', () => {
      const store = createSliceStore();
      const startedAt = '2026-03-12T10:00:00.000Z';

      store.getState().onProvisioningProgress({
        runId: 'run-current',
        teamName: 'my-team',
        state: 'spawning',
        message: 'Current run',
        startedAt,
        updatedAt: startedAt,
      });

      store.getState().onProvisioningProgress({
        runId: 'run-stale',
        teamName: 'my-team',
        state: 'failed',
        message: 'Stale failure',
        error: 'stale',
        startedAt: '2026-03-12T10:00:01.000Z',
        updatedAt: '2026-03-12T10:00:01.000Z',
      });

      expect(store.getState().currentProvisioningRunIdByTeam['my-team']).toBe('run-current');
      expect(store.getState().currentRuntimeRunIdByTeam['my-team']).toBe('run-current');
      expect(store.getState().provisioningErrorByTeam['my-team']).toBeUndefined();
      expect(store.getState().provisioningRuns['run-stale']).toBeUndefined();
    });

    it('promotes a pending run to a real run without throwing', () => {
      const store = createSliceStore();
      store.setState({
        provisioningRuns: {
          'pending:my-team:1': {
            runId: 'pending:my-team:1',
            teamName: 'my-team',
            state: 'spawning',
            message: 'Launching',
            startedAt: '2026-03-12T10:00:00.000Z',
            updatedAt: '2026-03-12T10:00:00.000Z',
          },
        },
        currentProvisioningRunIdByTeam: {
          'my-team': 'pending:my-team:1',
        },
      });

      expect(() =>
        store.getState().onProvisioningProgress({
          runId: 'run-real',
          teamName: 'my-team',
          state: 'assembling',
          message: 'Real run',
          startedAt: '2026-03-12T10:00:01.000Z',
          updatedAt: '2026-03-12T10:00:01.000Z',
        })
      ).not.toThrow();

      expect(store.getState().currentProvisioningRunIdByTeam['my-team']).toBe('run-real');
      expect(store.getState().provisioningRuns['pending:my-team:1']).toBeUndefined();
      expect(store.getState().provisioningRuns['run-real']).toEqual(
        expect.objectContaining({
          runId: 'run-real',
          state: 'assembling',
        })
      );
    });

    it('clears orphaned runs when polling reports Unknown runId', () => {
      const store = createSliceStore();
      store.setState({
        provisioningRuns: {
          'pending:my-team:1': {
            runId: 'pending:my-team:1',
            teamName: 'my-team',
            state: 'spawning',
            message: 'Launching',
            startedAt: '2026-03-12T10:00:00.000Z',
            updatedAt: '2026-03-12T10:00:00.000Z',
          },
        },
        currentProvisioningRunIdByTeam: {
          'my-team': 'pending:my-team:1',
        },
        currentRuntimeRunIdByTeam: {
          'my-team': 'pending:my-team:1',
        },
        memberSpawnStatusesByTeam: {
          'my-team': {
            alice: { status: 'spawning', updatedAt: '2026-03-12T10:00:00.000Z' },
          },
        },
      });

      store.getState().clearMissingProvisioningRun('pending:my-team:1');

      expect(store.getState().provisioningRuns['pending:my-team:1']).toBeUndefined();
      expect(store.getState().currentProvisioningRunIdByTeam['my-team']).toBeUndefined();
      expect(store.getState().currentRuntimeRunIdByTeam['my-team']).toBeUndefined();
      expect(store.getState().memberSpawnStatusesByTeam['my-team']).toBeUndefined();
      expect(store.getState().ignoredProvisioningRunIds['pending:my-team:1']).toBe('my-team');
      expect(store.getState().ignoredRuntimeRunIds['pending:my-team:1']).toBe('my-team');
    });

    it('does not resurrect a cleared missing run when late progress arrives', () => {
      const store = createSliceStore();
      store.setState({
        provisioningRuns: {
          'pending:my-team:1': {
            runId: 'pending:my-team:1',
            teamName: 'my-team',
            state: 'spawning',
            message: 'Launching',
            startedAt: '2026-03-12T10:00:00.000Z',
            updatedAt: '2026-03-12T10:00:00.000Z',
          },
        },
        currentProvisioningRunIdByTeam: {
          'my-team': 'pending:my-team:1',
        },
      });

      store.getState().clearMissingProvisioningRun('pending:my-team:1');
      store.getState().onProvisioningProgress({
        runId: 'pending:my-team:1',
        teamName: 'my-team',
        state: 'assembling',
        message: 'Late zombie progress',
        startedAt: '2026-03-12T10:00:00.000Z',
        updatedAt: '2026-03-12T10:00:02.000Z',
      });

      expect(store.getState().provisioningRuns['pending:my-team:1']).toBeUndefined();
      expect(store.getState().currentProvisioningRunIdByTeam['my-team']).toBeUndefined();
    });

    it('keeps runtime run id separate from provisioning run id when fetching spawn statuses', async () => {
      const store = createSliceStore();
      store.setState({
        currentProvisioningRunIdByTeam: {
          'my-team': 'provisioning-run',
        },
      });
      hoisted.getMemberSpawnStatuses.mockResolvedValue({
        runId: 'runtime-run',
        statuses: {
          alice: { status: 'spawning', updatedAt: '2026-03-12T10:00:00.000Z' },
        },
      });

      await store.getState().fetchMemberSpawnStatuses('my-team');

      expect(store.getState().currentProvisioningRunIdByTeam['my-team']).toBe('provisioning-run');
      expect(store.getState().currentRuntimeRunIdByTeam['my-team']).toBe('runtime-run');
      expect(store.getState().memberSpawnStatusesByTeam['my-team']).toEqual({
        alice: { status: 'spawning', updatedAt: '2026-03-12T10:00:00.000Z' },
      });
    });

    it('suppresses renderer rewrites when only lastHeartbeatAt changes', async () => {
      const store = createSliceStore();
      const previousSnapshot = createMemberSpawnSnapshot();
      const previousStatuses = previousSnapshot.statuses;

      store.setState({
        currentRuntimeRunIdByTeam: {
          'my-team': 'runtime-run',
        },
        memberSpawnStatusesByTeam: {
          'my-team': previousStatuses,
        },
        memberSpawnSnapshotsByTeam: {
          'my-team': previousSnapshot,
        },
      });

      hoisted.getMemberSpawnStatuses.mockResolvedValue(
        createMemberSpawnSnapshot({
          statuses: {
            alice: createMemberSpawnStatus({
              lastHeartbeatAt: '2026-03-12T10:00:09.000Z',
            }),
          },
        })
      );

      await store.getState().fetchMemberSpawnStatuses('my-team');

      expect(store.getState().memberSpawnStatusesByTeam['my-team']).toBe(previousStatuses);
      expect(store.getState().memberSpawnSnapshotsByTeam['my-team']).toBe(previousSnapshot);
    });

    it('suppresses renderer rewrites when only firstSpawnAcceptedAt changes', async () => {
      const store = createSliceStore();
      const previousSnapshot = createMemberSpawnSnapshot();
      const previousStatuses = previousSnapshot.statuses;

      store.setState({
        currentRuntimeRunIdByTeam: {
          'my-team': 'runtime-run',
        },
        memberSpawnStatusesByTeam: {
          'my-team': previousStatuses,
        },
        memberSpawnSnapshotsByTeam: {
          'my-team': previousSnapshot,
        },
      });

      hoisted.getMemberSpawnStatuses.mockResolvedValue(
        createMemberSpawnSnapshot({
          statuses: {
            alice: createMemberSpawnStatus({
              firstSpawnAcceptedAt: '2026-03-12T09:59:35.000Z',
            }),
          },
        })
      );

      await store.getState().fetchMemberSpawnStatuses('my-team');

      expect(store.getState().memberSpawnStatusesByTeam['my-team']).toBe(previousStatuses);
      expect(store.getState().memberSpawnSnapshotsByTeam['my-team']).toBe(previousSnapshot);
    });

    it('suppresses renderer rewrites when only updatedAt changes', async () => {
      const store = createSliceStore();
      const previousSnapshot = createMemberSpawnSnapshot();
      const previousStatuses = previousSnapshot.statuses;

      store.setState({
        currentRuntimeRunIdByTeam: {
          'my-team': 'runtime-run',
        },
        memberSpawnStatusesByTeam: {
          'my-team': previousStatuses,
        },
        memberSpawnSnapshotsByTeam: {
          'my-team': previousSnapshot,
        },
      });

      hoisted.getMemberSpawnStatuses.mockResolvedValue(
        createMemberSpawnSnapshot({
          updatedAt: '2026-03-12T10:00:11.000Z',
          statuses: {
            alice: createMemberSpawnStatus({
              updatedAt: '2026-03-12T10:00:11.000Z',
            }),
          },
        })
      );

      await store.getState().fetchMemberSpawnStatuses('my-team');

      expect(store.getState().memberSpawnStatusesByTeam['my-team']).toBe(previousStatuses);
      expect(store.getState().memberSpawnSnapshotsByTeam['my-team']).toBe(previousSnapshot);
    });

    it('rewrites renderer state when runtimeAlive changes', async () => {
      const store = createSliceStore();
      const previousSnapshot = createMemberSpawnSnapshot({
        statuses: {
          alice: createMemberSpawnStatus({
            launchState: 'runtime_pending_bootstrap',
            livenessSource: 'process',
            bootstrapConfirmed: false,
          }),
        },
        teamLaunchState: 'partial_pending',
        summary: {
          confirmedCount: 0,
          pendingCount: 1,
          failedCount: 0,
          runtimeAlivePendingCount: 1,
        },
      });
      const previousStatuses = previousSnapshot.statuses;

      store.setState({
        currentRuntimeRunIdByTeam: {
          'my-team': 'runtime-run',
        },
        memberSpawnStatusesByTeam: {
          'my-team': previousStatuses,
        },
        memberSpawnSnapshotsByTeam: {
          'my-team': previousSnapshot,
        },
      });

      const nextSnapshot = createMemberSpawnSnapshot();
      hoisted.getMemberSpawnStatuses.mockResolvedValue(nextSnapshot);

      await store.getState().fetchMemberSpawnStatuses('my-team');

      expect(store.getState().memberSpawnStatusesByTeam['my-team']).not.toBe(previousStatuses);
      expect(store.getState().memberSpawnStatusesByTeam['my-team']).toEqual(nextSnapshot.statuses);
      expect(store.getState().memberSpawnSnapshotsByTeam['my-team']).toEqual(nextSnapshot);
    });

    it('rewrites renderer state when error semantics change', async () => {
      const store = createSliceStore();
      const previousSnapshot = createMemberSpawnSnapshot({
        statuses: {
          alice: createMemberSpawnStatus({
            status: 'waiting',
            launchState: 'runtime_pending_bootstrap',
            runtimeAlive: false,
            livenessSource: undefined,
            bootstrapConfirmed: false,
          }),
        },
        teamLaunchState: 'partial_pending',
        summary: {
          confirmedCount: 0,
          pendingCount: 1,
          failedCount: 0,
          runtimeAlivePendingCount: 0,
        },
      });
      const previousStatuses = previousSnapshot.statuses;

      store.setState({
        currentRuntimeRunIdByTeam: {
          'my-team': 'runtime-run',
        },
        memberSpawnStatusesByTeam: {
          'my-team': previousStatuses,
        },
        memberSpawnSnapshotsByTeam: {
          'my-team': previousSnapshot,
        },
      });

      const nextSnapshot = createMemberSpawnSnapshot({
        teamLaunchState: 'partial_failure',
        summary: {
          confirmedCount: 0,
          pendingCount: 0,
          failedCount: 1,
          runtimeAlivePendingCount: 0,
        },
        statuses: {
          alice: createMemberSpawnStatus({
            status: 'error',
            launchState: 'failed_to_start',
            error: 'bootstrap failed',
            runtimeAlive: false,
            livenessSource: undefined,
            bootstrapConfirmed: false,
            hardFailure: true,
          }),
        },
      });
      hoisted.getMemberSpawnStatuses.mockResolvedValue(nextSnapshot);

      await store.getState().fetchMemberSpawnStatuses('my-team');

      expect(store.getState().memberSpawnStatusesByTeam['my-team']).not.toBe(previousStatuses);
      expect(store.getState().memberSpawnStatusesByTeam['my-team']).toEqual(nextSnapshot.statuses);
      expect(store.getState().memberSpawnSnapshotsByTeam['my-team']).toEqual(nextSnapshot);
    });

    it('rewrites renderer state when only hard failure reason changes', async () => {
      const store = createSliceStore();
      const previousSnapshot = createMemberSpawnSnapshot({
        teamLaunchState: 'partial_failure',
        summary: {
          confirmedCount: 0,
          pendingCount: 0,
          failedCount: 1,
          runtimeAlivePendingCount: 0,
        },
        statuses: {
          alice: createMemberSpawnStatus({
            status: 'error',
            launchState: 'failed_to_start',
            runtimeAlive: false,
            livenessSource: undefined,
            bootstrapConfirmed: false,
            hardFailure: true,
            hardFailureReason: 'initial failure',
          }),
        },
      });
      const previousStatuses = previousSnapshot.statuses;

      store.setState({
        currentRuntimeRunIdByTeam: {
          'my-team': 'runtime-run',
        },
        memberSpawnStatusesByTeam: {
          'my-team': previousStatuses,
        },
        memberSpawnSnapshotsByTeam: {
          'my-team': previousSnapshot,
        },
      });

      const nextSnapshot = createMemberSpawnSnapshot({
        teamLaunchState: 'partial_failure',
        summary: {
          confirmedCount: 0,
          pendingCount: 0,
          failedCount: 1,
          runtimeAlivePendingCount: 0,
        },
        statuses: {
          alice: createMemberSpawnStatus({
            status: 'error',
            launchState: 'failed_to_start',
            runtimeAlive: false,
            livenessSource: undefined,
            bootstrapConfirmed: false,
            hardFailure: true,
            hardFailureReason: 'resolved runtime reported missing auth',
          }),
        },
      });
      hoisted.getMemberSpawnStatuses.mockResolvedValue(nextSnapshot);

      await store.getState().fetchMemberSpawnStatuses('my-team');

      expect(store.getState().memberSpawnStatusesByTeam['my-team']).not.toBe(previousStatuses);
      expect(store.getState().memberSpawnStatusesByTeam['my-team']).toEqual(nextSnapshot.statuses);
      expect(store.getState().memberSpawnSnapshotsByTeam['my-team']).toEqual(nextSnapshot);
    });

    it('rewrites renderer state when top-level launch summary changes', async () => {
      const store = createSliceStore();
      const previousSnapshot = createMemberSpawnSnapshot({
        teamLaunchState: 'partial_pending',
        summary: {
          confirmedCount: 0,
          pendingCount: 1,
          failedCount: 0,
          runtimeAlivePendingCount: 1,
        },
        statuses: {
          alice: createMemberSpawnStatus({
            launchState: 'runtime_pending_bootstrap',
            livenessSource: 'process',
            bootstrapConfirmed: false,
          }),
        },
      });
      const previousStatuses = previousSnapshot.statuses;

      store.setState({
        currentRuntimeRunIdByTeam: {
          'my-team': 'runtime-run',
        },
        memberSpawnStatusesByTeam: {
          'my-team': previousStatuses,
        },
        memberSpawnSnapshotsByTeam: {
          'my-team': previousSnapshot,
        },
      });

      const nextSnapshot = createMemberSpawnSnapshot({
        teamLaunchState: 'clean_success',
        summary: {
          confirmedCount: 1,
          pendingCount: 0,
          failedCount: 0,
          runtimeAlivePendingCount: 0,
        },
      });
      hoisted.getMemberSpawnStatuses.mockResolvedValue(nextSnapshot);

      await store.getState().fetchMemberSpawnStatuses('my-team');

      expect(store.getState().memberSpawnStatusesByTeam['my-team']).not.toBe(previousStatuses);
      expect(store.getState().memberSpawnSnapshotsByTeam['my-team']).toEqual(nextSnapshot);
    });

    it('preserves spawn snapshot references while still updating bookkeeping on suppressed snapshots', async () => {
      const store = createSliceStore();
      const previousSnapshot = createMemberSpawnSnapshot();
      const previousStatuses = previousSnapshot.statuses;

      store.setState({
        ignoredRuntimeRunIds: {
          'runtime-old': 'my-team',
        },
        memberSpawnStatusesByTeam: {
          'my-team': previousStatuses,
        },
        memberSpawnSnapshotsByTeam: {
          'my-team': previousSnapshot,
        },
      });

      hoisted.getMemberSpawnStatuses.mockResolvedValue(
        createMemberSpawnSnapshot({
          statuses: {
            alice: createMemberSpawnStatus({
              lastHeartbeatAt: '2026-03-12T10:00:09.000Z',
            }),
          },
        })
      );

      await store.getState().fetchMemberSpawnStatuses('my-team');

      expect(store.getState().currentRuntimeRunIdByTeam['my-team']).toBe('runtime-run');
      expect(store.getState().ignoredRuntimeRunIds['runtime-old']).toBe('my-team');
      expect(store.getState().memberSpawnStatusesByTeam['my-team']).toBe(previousStatuses);
      expect(store.getState().memberSpawnSnapshotsByTeam['my-team']).toBe(previousSnapshot);
    });

    it('does not suppress spawn snapshots when pending permission request ids change', async () => {
      const store = createSliceStore();
      const previousSnapshot = createMemberSpawnSnapshot({
        teamLaunchState: 'partial_pending',
        launchPhase: 'active',
        summary: {
          confirmedCount: 0,
          pendingCount: 1,
          failedCount: 0,
          runtimeAlivePendingCount: 0,
        },
        statuses: {
          alice: createMemberSpawnStatus({
            status: 'waiting',
            launchState: 'runtime_pending_bootstrap',
            runtimeAlive: false,
            livenessSource: undefined,
            bootstrapConfirmed: false,
            firstSpawnAcceptedAt: '2026-03-12T09:59:30.000Z',
            lastHeartbeatAt: undefined,
          }),
        },
      });

      store.setState({
        memberSpawnStatusesByTeam: {
          'my-team': previousSnapshot.statuses,
        },
        memberSpawnSnapshotsByTeam: {
          'my-team': previousSnapshot,
        },
      });

      const nextSnapshot = createMemberSpawnSnapshot({
        teamLaunchState: 'partial_pending',
        launchPhase: 'active',
        summary: {
          confirmedCount: 0,
          pendingCount: 1,
          failedCount: 0,
          runtimeAlivePendingCount: 0,
        },
        statuses: {
          alice: createMemberSpawnStatus({
            status: 'waiting',
            launchState: 'runtime_pending_bootstrap',
            runtimeAlive: false,
            livenessSource: undefined,
            bootstrapConfirmed: false,
            firstSpawnAcceptedAt: '2026-03-12T09:59:30.000Z',
            lastHeartbeatAt: undefined,
            pendingPermissionRequestIds: ['perm-1'],
          }),
        },
      });
      hoisted.getMemberSpawnStatuses.mockResolvedValue(nextSnapshot);

      await store.getState().fetchMemberSpawnStatuses('my-team');

      expect(store.getState().memberSpawnSnapshotsByTeam['my-team']).not.toBe(previousSnapshot);
      expect(store.getState().memberSpawnStatusesByTeam['my-team']).not.toBe(
        previousSnapshot.statuses
      );
      expect(
        store.getState().memberSpawnStatusesByTeam['my-team']?.alice?.pendingPermissionRequestIds
      ).toEqual(['perm-1']);
    });

    it('ignores stale spawn-status fetches after runtime already went offline', async () => {
      const store = createSliceStore();
      store.setState({
        currentProvisioningRunIdByTeam: {
          'my-team': 'provisioning-run',
        },
        leadActivityByTeam: {
          'my-team': 'offline',
        },
      });
      hoisted.getMemberSpawnStatuses.mockResolvedValue({
        runId: 'old-runtime-run',
        statuses: {
          alice: { status: 'spawning', updatedAt: '2026-03-12T10:00:00.000Z' },
        },
      });

      await store.getState().fetchMemberSpawnStatuses('my-team');

      expect(store.getState().currentRuntimeRunIdByTeam['my-team']).toBeUndefined();
      expect(store.getState().memberSpawnStatusesByTeam['my-team']).toBeUndefined();
    });

    it('tombstones the previous runtime run and clears tool layers before creating a new run', async () => {
      const store = createSliceStore();
      store.setState({
        currentRuntimeRunIdByTeam: {
          'my-team': 'runtime-old',
        },
        activeToolsByTeam: {
          'my-team': {
            'team-lead': {
              'tool-a': {
                memberName: 'team-lead',
                toolUseId: 'tool-a',
                toolName: 'Read',
                startedAt: '2026-03-12T10:00:00.000Z',
                state: 'running',
                source: 'runtime',
              },
            },
          },
        },
        finishedVisibleByTeam: {
          'my-team': {
            'team-lead': {
              'tool-b': {
                memberName: 'team-lead',
                toolUseId: 'tool-b',
                toolName: 'Bash',
                startedAt: '2026-03-12T10:00:01.000Z',
                finishedAt: '2026-03-12T10:00:02.000Z',
                state: 'complete',
                source: 'runtime',
              },
            },
          },
        },
        toolHistoryByTeam: {
          'my-team': {
            'team-lead': [
              {
                memberName: 'team-lead',
                toolUseId: 'tool-b',
                toolName: 'Bash',
                startedAt: '2026-03-12T10:00:01.000Z',
                finishedAt: '2026-03-12T10:00:02.000Z',
                state: 'complete',
                source: 'runtime',
              },
            ],
          },
        },
      });

      await store.getState().createTeam({
        teamName: 'my-team',
        cwd: '/tmp/project',
        members: [],
      });

      expect(store.getState().currentRuntimeRunIdByTeam['my-team']).toBe('run-1');
      expect(store.getState().ignoredRuntimeRunIds['runtime-old']).toBe('my-team');
      expect(store.getState().activeToolsByTeam['my-team']).toBeUndefined();
      expect(store.getState().finishedVisibleByTeam['my-team']).toBeUndefined();
      expect(store.getState().toolHistoryByTeam['my-team']).toBeUndefined();
    });

    it('keeps tombstoned runtime ids ignored during createTeam startup before the new run is pinned', async () => {
      const store = createSliceStore();
      const createDeferred = createDeferredPromise<{ runId: string }>();
      hoisted.createTeam.mockImplementation(() => createDeferred.promise);
      store.setState({
        currentRuntimeRunIdByTeam: {
          'my-team': 'runtime-live',
        },
        ignoredRuntimeRunIds: {
          'runtime-old': 'my-team',
        },
      });

      const createPromise = store.getState().createTeam({
        teamName: 'my-team',
        cwd: '/tmp/project',
        members: [],
      });

      await Promise.resolve();

      expect(store.getState().currentRuntimeRunIdByTeam['my-team']).toBeUndefined();
      expect(store.getState().ignoredRuntimeRunIds['runtime-old']).toBe('my-team');
      expect(store.getState().ignoredRuntimeRunIds['runtime-live']).toBe('my-team');

      hoisted.getMemberSpawnStatuses.mockResolvedValue(
        createMemberSpawnSnapshot({
          runId: 'runtime-old',
        })
      );

      await store.getState().fetchMemberSpawnStatuses('my-team');

      expect(store.getState().memberSpawnStatusesByTeam['my-team']).toBeUndefined();
      expect(store.getState().memberSpawnSnapshotsByTeam['my-team']).toBeUndefined();

      createDeferred.resolve({ runId: 'run-1' });
      await createPromise;
    });

    it('keeps older tombstoned runtime ids after canonical provisioning progress arrives', () => {
      const store = createSliceStore();
      store.setState({
        ignoredRuntimeRunIds: {
          'runtime-old': 'my-team',
        },
      });

      store.getState().onProvisioningProgress({
        runId: 'run-current',
        teamName: 'my-team',
        state: 'assembling',
        message: 'Current run',
        startedAt: '2026-03-12T10:00:00.000Z',
        updatedAt: '2026-03-12T10:00:01.000Z',
      });

      expect(store.getState().currentRuntimeRunIdByTeam['my-team']).toBe('run-current');
      expect(store.getState().ignoredRuntimeRunIds['runtime-old']).toBe('my-team');
    });

    it('ignores tombstoned runtime spawn-status snapshots', async () => {
      const store = createSliceStore();
      store.setState({
        ignoredRuntimeRunIds: {
          'runtime-old': 'my-team',
        },
      });
      hoisted.getMemberSpawnStatuses.mockResolvedValue({
        runId: 'runtime-old',
        statuses: {
          alice: { status: 'spawning', updatedAt: '2026-03-12T10:00:00.000Z' },
        },
      });

      await store.getState().fetchMemberSpawnStatuses('my-team');

      expect(store.getState().currentRuntimeRunIdByTeam['my-team']).toBeUndefined();
      expect(store.getState().memberSpawnStatusesByTeam['my-team']).toBeUndefined();
    });

    it('preserves current spawn statuses when clearing a non-canonical missing run', () => {
      const store = createSliceStore();
      store.setState({
        provisioningRuns: {
          'run-current': {
            runId: 'run-current',
            teamName: 'my-team',
            state: 'assembling',
            message: 'Current run',
            startedAt: '2026-03-12T10:00:00.000Z',
            updatedAt: '2026-03-12T10:00:00.000Z',
          },
          'run-stale': {
            runId: 'run-stale',
            teamName: 'my-team',
            state: 'failed',
            message: 'Stale run',
            startedAt: '2026-03-12T10:00:01.000Z',
            updatedAt: '2026-03-12T10:00:01.000Z',
          },
        },
        currentProvisioningRunIdByTeam: {
          'my-team': 'run-current',
        },
        memberSpawnStatusesByTeam: {
          'my-team': {
            alice: { status: 'spawning', updatedAt: '2026-03-12T10:00:00.000Z' },
          },
        },
      });

      store.getState().clearMissingProvisioningRun('run-stale');

      expect(store.getState().currentProvisioningRunIdByTeam['my-team']).toBe('run-current');
      expect(store.getState().memberSpawnStatusesByTeam['my-team']).toEqual({
        alice: { status: 'spawning', updatedAt: '2026-03-12T10:00:00.000Z' },
      });
    });

    it('keeps the terminal canonical run pinned and does not fall back to other team runs', () => {
      const store = createSliceStore();
      const startedAt = '2026-03-12T10:00:00.000Z';

      store.getState().onProvisioningProgress({
        runId: 'run-current',
        teamName: 'my-team',
        state: 'assembling',
        message: 'Current run',
        startedAt,
        updatedAt: startedAt,
      });

      store.getState().onProvisioningProgress({
        runId: 'run-current',
        teamName: 'my-team',
        state: 'disconnected',
        message: 'Disconnected',
        startedAt,
        updatedAt: '2026-03-12T10:00:01.000Z',
      });

      store.setState((state: ReturnType<typeof store.getState>) => ({
        provisioningRuns: {
          ...state.provisioningRuns,
          'run-stale': {
            runId: 'run-stale',
            teamName: 'my-team',
            state: 'failed',
            message: 'Stale run',
            startedAt: '2026-03-12T10:00:02.000Z',
            updatedAt: '2026-03-12T10:00:02.000Z',
          },
        },
      }));

      expect(store.getState().currentProvisioningRunIdByTeam['my-team']).toBe('run-current');
      expect(store.getState().memberSpawnStatusesByTeam['my-team']).toBeUndefined();
      expect(getCurrentProvisioningProgressForTeam(store.getState(), 'my-team')).toEqual(
        expect.objectContaining({
          runId: 'run-current',
          state: 'disconnected',
        })
      );
    });

    it('does not fall back to a team-wide latest run when no current run is pinned', () => {
      expect(
        getCurrentProvisioningProgressForTeam(
          {
            currentProvisioningRunIdByTeam: {},
            provisioningRuns: {
              'run-stale': {
                runId: 'run-stale',
                teamName: 'my-team',
                state: 'failed',
                message: 'Stale run',
                startedAt: '2026-03-12T10:00:00.000Z',
                updatedAt: '2026-03-12T10:00:00.000Z',
              },
            },
          },
          'my-team'
        )
      ).toBeNull();
    });
  });
});
