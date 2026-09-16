import { describe, expect, it, vi } from 'vitest';

import { TeamDataControllerCompatibilityAdapter } from '../../../../src/main/services/team/TeamDataControllerCompatibilityAdapter';
import { TeamDataLegacyTaskBoardAdapter } from '../../../../src/main/services/team/TeamDataLegacyTaskBoardAdapter';
import { TeamDataProcessCompatibilityAdapter } from '../../../../src/main/services/team/TeamDataProcessCompatibilityAdapter';

import type { TeamDataTaskBoardCapability } from '../../../../src/main/services/team/TeamDataControllerCompatibilityAdapter';
import type { TeamProcess, TeamSummary } from '../../../../src/shared/types';

function process(pid: number): TeamProcess {
  return {
    id: String(pid),
    label: `process-${pid}`,
    pid,
    registeredAt: '2026-08-06T00:00:00.000Z',
  };
}

function team(teamName: string): TeamSummary {
  return {
    teamName,
    displayName: teamName,
    description: '',
    memberCount: 0,
    taskCount: 0,
    lastActivity: null,
  };
}

describe('TeamData legacy compatibility adapters', () => {
  it('keeps controller message, process, and artifact conversations behind one outer adapter', () => {
    const listProcesses = vi.fn(() => [process(101)]);
    const stopProcess = vi.fn();
    const sendMessage = vi.fn(() => ({ deliveredToInbox: true, messageId: 'message-1' }));
    const appendSentMessage = vi.fn(() => ({ messageId: 'sent-1' }));
    const reconcileArtifacts = vi.fn(() => ({ staleKanbanEntriesRemoved: 1 }));
    const controller = {
      processes: { listProcesses, stopProcess },
      messages: { sendMessage, appendSentMessage },
      maintenance: { reconcileArtifacts },
    };
    const adapter = new TeamDataControllerCompatibilityAdapter(vi.fn(() => controller as never));

    expect(adapter.processes.listProcesses('alpha')).toEqual([process(101)]);
    adapter.processes.stopProcess('alpha', 101);
    expect(
      adapter.messagePersistence.sendMessage('alpha', { member: 'lead', text: 'hello' })
    ).toEqual({
      deliveredToInbox: true,
      messageId: 'message-1',
    });
    expect(
      adapter.messagePersistence.appendSentMessage('alpha', { to: 'lead', text: 'sent' })
    ).toEqual({
      messageId: 'sent-1',
    });
    expect(
      adapter.artifactMaintenance.reconcileArtifacts('alpha', { reason: 'file-watch' })
    ).toEqual({
      staleKanbanEntriesRemoved: 1,
    });
    expect(stopProcess).toHaveBeenCalledWith({ pid: 101 });
    expect(sendMessage).toHaveBeenCalledWith({ member: 'lead', text: 'hello' });
    expect(appendSentMessage).toHaveBeenCalledWith({ to: 'lead', text: 'sent' });
    expect(reconcileArtifacts).toHaveBeenCalledWith({ reason: 'file-watch' });
  });

  it('normalizes current and split task boards before exposing only a task-board capability', () => {
    const currentTaskBoard = { createTask: vi.fn(), listTasks: vi.fn(() => []) };
    const currentControllers = new TeamDataControllerCompatibilityAdapter(
      vi.fn(() => ({ taskBoard: currentTaskBoard }) as never)
    );
    expect(currentControllers.taskBoard.getTaskBoard('current')).toBe(currentTaskBoard);

    const tasks = { listTasks: vi.fn(() => []), createTask: vi.fn() };
    const kanban = { getKanbanState: vi.fn(() => ({ tasks: {} })) };
    const review = { requestReview: vi.fn() };
    const legacyControllers = new TeamDataControllerCompatibilityAdapter(
      vi.fn(() => ({ tasks, kanban, review }) as never)
    );
    const legacyBoard = legacyControllers.taskBoard.getTaskBoard('legacy');

    expect(legacyBoard?.createTask).toBe(tasks.createTask);
    expect(legacyBoard?.getKanbanState).toBe(kanban.getKanbanState);
    expect(legacyBoard?.requestReview).toBe(review.requestReview);
    expect(
      new TeamDataControllerCompatibilityAdapter(vi.fn(() => ({}) as never)).taskBoard.getTaskBoard(
        'missing'
      )
    ).toBeNull();

    const taskBoardCapability: TeamDataTaskBoardCapability = {
      getTaskBoard: vi.fn(() => currentTaskBoard as never),
    };
    const adapter = new TeamDataLegacyTaskBoardAdapter(taskBoardCapability);

    expect(adapter.getTaskBoard('current')).toBe(currentTaskBoard);
    expect(taskBoardCapability.getTaskBoard).toHaveBeenCalledWith('current');
    expect(() =>
      new TeamDataLegacyTaskBoardAdapter({ getTaskBoard: () => null }).getTaskBoard('missing')
    ).toThrow('Agent teams controller taskBoard API is unavailable');
  });

  it('adapts process reads and stops without retaining process state or lifecycle authority', async () => {
    const listProcesses = vi.fn(() => [process(303)]);
    const stopProcess = vi.fn();
    const controllers = new TeamDataControllerCompatibilityAdapter(
      vi.fn(() => ({ processes: { listProcesses, stopProcess } }) as never)
    );
    const killByPid = vi.fn();
    const adapter = new TeamDataProcessCompatibilityAdapter(
      controllers.processes,
      async () => [team('alpha')],
      killByPid
    );

    await expect(adapter.listTeams()).resolves.toEqual([team('alpha')]);
    expect(adapter.listProcesses('alpha')).toEqual([process(303)]);
    adapter.stopProcess('alpha', 303);
    adapter.killProcessByPid(303);

    expect(stopProcess).toHaveBeenCalledWith({ pid: 303 });
    expect(killByPid).toHaveBeenCalledWith(303);
    expect(Object.keys(adapter)).not.toContain('processHealthTeams');
  });
});
