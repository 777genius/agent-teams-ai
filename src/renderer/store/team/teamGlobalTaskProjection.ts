import { structurallySharePlainValue } from './teamSnapshotStructuralSharing';

import type { GlobalTask, TaskComment, TeamTaskWithKanban, TeamViewSnapshot } from '@shared/types';

function buildLightweightComments(
  comments: TeamTaskWithKanban['comments'],
  fallback: GlobalTask['comments']
): GlobalTask['comments'] {
  if (!Array.isArray(comments)) {
    return fallback;
  }

  return comments.map((comment: TaskComment) => ({
    id: comment.id,
    author: comment.author,
    text: comment.text.slice(0, 120),
    createdAt: comment.createdAt,
    type: comment.type,
  }));
}

function buildGlobalTaskProjection(
  teamName: string,
  snapshot: TeamViewSnapshot,
  task: TeamTaskWithKanban,
  previous: GlobalTask
): GlobalTask {
  return {
    ...previous,
    ...task,
    subject: task.subject.slice(0, 300),
    projectPath: task.projectPath ?? snapshot.config.projectPath ?? previous.projectPath,
    comments: buildLightweightComments(task.comments, previous.comments),
    teamName,
    teamDisplayName: snapshot.config.name || previous.teamDisplayName || teamName,
    teamDeleted: snapshot.config.deletedAt ? true : undefined,
  };
}

export function projectTeamSnapshotOntoGlobalTasks(
  globalTasks: GlobalTask[],
  teamName: string,
  snapshot: TeamViewSnapshot
): GlobalTask[] {
  if (globalTasks.length === 0) {
    return globalTasks;
  }

  const taskById = new Map(snapshot.tasks.map((task) => [task.id, task]));
  let sawTeamTask = false;
  const projectedTasks: GlobalTask[] = [];

  for (const globalTask of globalTasks) {
    if (globalTask.teamName !== teamName) {
      projectedTasks.push(globalTask);
      continue;
    }

    sawTeamTask = true;
    const freshTask = taskById.get(globalTask.id);
    if (!freshTask) {
      continue;
    }

    projectedTasks.push(buildGlobalTaskProjection(teamName, snapshot, freshTask, globalTask));
  }

  if (!sawTeamTask) {
    return globalTasks;
  }

  return structurallySharePlainValue(globalTasks, projectedTasks);
}
