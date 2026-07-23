import { describe, expect, it, vi } from 'vitest';

import {
  createTeamTaskArtifactsRendererSlice,
  type TeamTaskArtifactsRendererState,
  type TeamTaskArtifactsTransport,
} from '../../../../src/features/team-task-board/renderer';

import type {
  GlobalTask,
  TaskComment,
  TeamTaskWithKanban,
  TeamViewSnapshot,
} from '../../../../src/shared/types';

interface RequestScope {
  epoch: number;
}

type HarnessState = TeamTaskArtifactsRendererState;

function task(id: string, changePresence: TeamTaskWithKanban['changePresence']) {
  return {
    id,
    subject: id,
    status: 'in_progress',
    owner: 'alice',
    createdAt: '2026-07-24T10:00:00.000Z',
    updatedAt: '2026-07-24T10:00:00.000Z',
    comments: [],
    attachments: [],
    historyEvents: [],
    changePresence,
  } satisfies TeamTaskWithKanban;
}

function teamSnapshot(teamName: string, tasks: TeamTaskWithKanban[]): TeamViewSnapshot {
  return {
    teamName,
    config: { name: teamName },
    tasks,
    members: [],
    messages: [],
    processes: [],
    kanbanState: { teamName, reviewers: [], tasks: {} },
  } as TeamViewSnapshot;
}

function globalTask(
  teamName: string,
  id: string,
  changePresence: TeamTaskWithKanban['changePresence']
): GlobalTask {
  return {
    ...task(id, changePresence),
    teamName,
    teamDisplayName: teamName,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, reject, resolve };
}

function createHarness(input?: {
  globalTasks?: GlobalTask[];
  selectedTeamData?: TeamViewSnapshot | null;
  selectedTeamName?: string | null;
}) {
  const selectedTeamName = input?.selectedTeamName ?? 'team-a';
  const selectedTeamData =
    input?.selectedTeamData === undefined
      ? teamSnapshot('team-a', [task('task-1', 'unknown')])
      : input.selectedTeamData;
  let scopeIsCurrent = true;
  const state: HarnessState = {
    addCommentError: null,
    addingComment: false,
    globalTasks: input?.globalTasks ?? [],
    selectedTeamData,
    selectedTeamName,
    teamDataCacheByName:
      selectedTeamName && selectedTeamData ? { [selectedTeamName]: selectedTeamData } : {},
  };
  const transport: TeamTaskArtifactsTransport = {
    addTaskComment: vi.fn(),
    deleteTaskAttachment: vi.fn(),
    getTaskAttachmentData: vi.fn(),
    getTaskChangePresence: vi.fn(),
    saveTaskAttachment: vi.fn(),
  };
  const refreshTeamData = vi.fn(async () => undefined);
  const recordAttachment = vi.fn();
  const classifyError = vi.fn(() => 'transport');
  const slice = createTeamTaskArtifactsRendererSlice<HarnessState, RequestScope>({
    analytics: { classifyError, recordAttachment },
    ids: { randomUUID: () => 'attachment-id' },
    refresh: { refreshTeamData },
    requestScope: {
      capture: () => ({ epoch: 1 }),
      isCurrent: () => scopeIsCurrent,
    },
    state: {
      getState: () => state,
      selectTeamData: (currentState, teamName) =>
        currentState.selectedTeamName === teamName && currentState.selectedTeamData
          ? currentState.selectedTeamData
          : (currentState.teamDataCacheByName[teamName] ?? null),
      setState: (update) => {
        Object.assign(state, typeof update === 'function' ? update(state) : update);
      },
    },
    transport,
  });

  return {
    classifyError,
    recordAttachment,
    refreshTeamData,
    setScopeCurrent: (current: boolean) => {
      scopeIsCurrent = current;
    },
    slice,
    state,
    transport,
  };
}

describe('createTeamTaskArtifactsRendererSlice', () => {
  it('projects batch presence updates with structural sharing across team and global views', () => {
    const teamData = teamSnapshot('team-a', [
      task('task-1', 'unknown'),
      task('task-2', 'no_changes'),
    ]);
    const otherGlobalTask = globalTask('team-b', 'task-1', 'unknown');
    const harness = createHarness({
      selectedTeamData: teamData,
      globalTasks: [
        globalTask('team-a', 'task-1', 'unknown'),
        globalTask('team-a', 'task-2', 'no_changes'),
        otherGlobalTask,
      ],
    });
    const unchangedTeamTask = teamData.tasks[1];

    harness.slice.setSelectedTeamTaskChangePresences('team-a', {
      'task-1': 'has_changes',
      'task-2': 'no_changes',
    });

    expect(harness.state.selectedTeamData?.tasks[0]?.changePresence).toBe('has_changes');
    expect(harness.state.selectedTeamData?.tasks[1]).toBe(unchangedTeamTask);
    expect(harness.state.globalTasks[2]).toBe(otherGlobalTask);
    expect(harness.state.teamDataCacheByName['team-a']).toBe(harness.state.selectedTeamData);

    const unchangedSnapshot = harness.state.selectedTeamData;
    const unchangedGlobalTasks = harness.state.globalTasks;
    harness.slice.setSelectedTeamTaskChangePresence('team-a', 'task-1', 'has_changes');
    expect(harness.state.selectedTeamData).toBe(unchangedSnapshot);
    expect(harness.state.globalTasks).toBe(unchangedGlobalTasks);
  });

  it('refreshes known presence without downgrading another known task to unknown', async () => {
    const knownTask = task('task-1', 'needs_attention');
    const harness = createHarness({
      selectedTeamData: teamSnapshot('team-a', [knownTask, task('task-2', 'unknown')]),
    });
    vi.mocked(harness.transport.getTaskChangePresence).mockResolvedValue({
      'task-1': 'unknown',
      'task-2': 'has_changes',
    });

    await harness.slice.refreshTeamChangePresence('team-a');

    expect(harness.state.selectedTeamData?.tasks[0]).toBe(knownTask);
    expect(harness.state.selectedTeamData?.tasks[1]?.changePresence).toBe('has_changes');
  });

  it('ignores a late presence response after its request scope becomes stale', async () => {
    const pendingPresence =
      deferred<Record<string, 'has_changes' | 'needs_attention' | 'no_changes' | 'unknown'>>();
    const harness = createHarness();
    const originalSnapshot = harness.state.selectedTeamData;
    vi.mocked(harness.transport.getTaskChangePresence).mockReturnValue(pendingPresence.promise);

    const refresh = harness.slice.refreshTeamChangePresence('team-a');
    harness.setScopeCurrent(false);
    pendingPresence.resolve({ 'task-1': 'has_changes' });
    await refresh;

    expect(harness.state.selectedTeamData).toBe(originalSnapshot);
    expect(harness.state.teamDataCacheByName['team-a']).toBe(originalSnapshot);
  });

  it('keeps presence refresh best-effort when transport fails', async () => {
    const harness = createHarness();
    const originalSnapshot = harness.state.selectedTeamData;
    vi.mocked(harness.transport.getTaskChangePresence).mockRejectedValue(new Error('offline'));

    await expect(harness.slice.refreshTeamChangePresence('team-a')).resolves.toBeUndefined();
    expect(harness.state.selectedTeamData).toBe(originalSnapshot);
  });

  it('preserves attachment save ordering and records failures without refreshing', async () => {
    const events: string[] = [];
    const harness = createHarness();
    vi.mocked(harness.transport.saveTaskAttachment).mockImplementation(async () => {
      events.push('transport');
    });
    harness.recordAttachment.mockImplementation(() => events.push('analytics'));
    harness.refreshTeamData.mockImplementation(async () => {
      events.push('refresh');
    });
    const file = {
      name: 'evidence.pdf',
      type: 'application/pdf',
      base64: 'aGVsbG8=',
    };

    await harness.slice.saveTaskAttachment('team-a', 'task-1', file);

    expect(events).toEqual(['transport', 'analytics', 'refresh']);
    expect(harness.transport.saveTaskAttachment).toHaveBeenCalledWith(
      'team-a',
      'task-1',
      'attachment-id',
      file.name,
      file.type,
      file.base64
    );

    const failure = new Error('save failed');
    vi.mocked(harness.transport.saveTaskAttachment).mockRejectedValueOnce(failure);
    await expect(harness.slice.saveTaskAttachment('team-a', 'task-1', file)).rejects.toBe(failure);
    expect(harness.classifyError).toHaveBeenCalledWith(failure);
    expect(harness.refreshTeamData).toHaveBeenCalledTimes(1);
  });

  it('settles comment UI state before refresh and preserves attachment analytics', async () => {
    const harness = createHarness();
    const pendingComment = deferred<TaskComment>();
    const comment = {
      id: 'comment-1',
      author: 'user',
      text: 'done',
      createdAt: '2026-07-24T10:01:00.000Z',
      type: 'regular',
    } satisfies TaskComment;
    vi.mocked(harness.transport.addTaskComment).mockReturnValue(pendingComment.promise);
    const request = {
      text: 'done',
      attachments: [
        {
          id: 'attachment-1',
          filename: 'proof.txt',
          mimeType: 'text/plain',
          base64Data: 'cHJvb2Y=',
        },
      ],
    };

    const adding = harness.slice.addTaskComment('team-a', 'task-1', request);
    expect(harness.state).toMatchObject({
      addingComment: true,
      addCommentError: null,
    });
    pendingComment.resolve(comment);
    await expect(adding).resolves.toBe(comment);

    expect(harness.state.addingComment).toBe(false);
    expect(harness.recordAttachment).toHaveBeenCalledWith({
      attachments: request.attachments,
      source: 'comment',
      success: true,
      errorClass: 'none',
    });
    expect(harness.refreshTeamData).toHaveBeenCalledWith('team-a');
  });

  it('surfaces comment errors and leaves attachment reads and deletes transport-shaped', async () => {
    const harness = createHarness();
    const failure = new Error('comment failed');
    vi.mocked(harness.transport.addTaskComment).mockRejectedValue(failure);

    await expect(harness.slice.addTaskComment('team-a', 'task-1', { text: 'retry' })).rejects.toBe(
      failure
    );
    expect(harness.state).toMatchObject({
      addingComment: false,
      addCommentError: 'comment failed',
    });
    expect(harness.refreshTeamData).not.toHaveBeenCalled();

    vi.mocked(harness.transport.getTaskAttachmentData).mockResolvedValue('base64-data');
    await expect(
      harness.slice.getTaskAttachmentData('team-a', 'task-1', 'attachment-1', 'text/plain')
    ).resolves.toBe('base64-data');

    await harness.slice.deleteTaskAttachment('team-a', 'task-1', 'attachment-1', 'text/plain');
    expect(harness.transport.deleteTaskAttachment).toHaveBeenCalledWith(
      'team-a',
      'task-1',
      'attachment-1',
      'text/plain'
    );
    expect(harness.refreshTeamData).toHaveBeenCalledOnce();
  });
});
