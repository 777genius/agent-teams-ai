import type { TeamViewSnapshot } from '@shared/types';

/**
 * A partial IPC snapshot with a failed task/kanban read is not evidence that
 * tasks vanished or that review state was reset. Keep the previous good board
 * until a successful read arrives; unrelated fresh team fields can still update.
 */
export function preserveReliableTaskBoardSnapshot(
  previous: TeamViewSnapshot | null | undefined,
  incoming: TeamViewSnapshot
): TeamViewSnapshot {
  if (!previous || previous.teamName !== incoming.teamName) return incoming;

  const taskReadFailed = incoming.warnings?.includes('Tasks failed to load') ?? false;
  const kanbanReadFailed = incoming.warnings?.includes('Kanban state failed to load') ?? false;
  if (!taskReadFailed && !kanbanReadFailed) return incoming;

  return {
    ...incoming,
    tasks: taskReadFailed ? previous.tasks : incoming.tasks,
    kanbanState: kanbanReadFailed ? previous.kanbanState : incoming.kanbanState,
  };
}
