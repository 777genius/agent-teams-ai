import { BoardTaskActivityRecordBuilder } from './BoardTaskActivityRecordBuilder';

import type { BoardTaskActivityRecord } from './BoardTaskActivityRecord';
import type { RawTaskActivityMessage } from './BoardTaskActivityTranscriptReader';
import type { BoardTaskActivityEntry, TeamTask } from '@shared/types';

function cloneTaskRef(task: BoardTaskActivityRecord['task']): BoardTaskActivityEntry['task'] {
  return {
    locator: { ...task.locator },
    resolution: task.resolution,
    ...(task.taskRef ? { taskRef: { ...task.taskRef } } : {}),
  };
}

function cloneActorContext(
  actorContext: BoardTaskActivityRecord['actorContext']
): BoardTaskActivityEntry['actorContext'] {
  return {
    relation: actorContext.relation,
    ...(actorContext.activeTask ? { activeTask: cloneTaskRef(actorContext.activeTask) } : {}),
    ...(actorContext.activePhase ? { activePhase: actorContext.activePhase } : {}),
    ...(actorContext.activeExecutionSeq
      ? { activeExecutionSeq: actorContext.activeExecutionSeq }
      : {}),
  };
}

function cloneAction(
  action: BoardTaskActivityRecord['action']
): BoardTaskActivityEntry['action'] | undefined {
  if (!action) return undefined;

  return {
    ...(action.canonicalToolName ? { canonicalToolName: action.canonicalToolName } : {}),
    ...(action.toolUseId ? { toolUseId: action.toolUseId } : {}),
    category: action.category,
    ...(action.peerTask ? { peerTask: cloneTaskRef(action.peerTask) } : {}),
    ...(action.relationshipPerspective
      ? { relationshipPerspective: action.relationshipPerspective }
      : {}),
    ...(action.details ? { details: { ...action.details } } : {}),
  };
}

export class BoardTaskActivityEntryBuilder {
  constructor(
    private readonly recordBuilder: BoardTaskActivityRecordBuilder = new BoardTaskActivityRecordBuilder()
  ) {}

  buildForTask(args: {
    teamName: string;
    targetTask: TeamTask;
    tasks: TeamTask[];
    messages: RawTaskActivityMessage[];
  }): BoardTaskActivityEntry[] {
    return this.buildFromRecords(this.recordBuilder.buildForTask(args));
  }

  buildFromRecords(records: BoardTaskActivityRecord[]): BoardTaskActivityEntry[] {
    return records.map((record) => ({
      id: record.id,
      timestamp: record.timestamp,
      task: cloneTaskRef(record.task),
      linkKind: record.linkKind,
      targetRole: record.targetRole,
      actor: {
        ...(record.actor.memberName ? { memberName: record.actor.memberName } : {}),
        role: record.actor.role,
        sessionId: record.actor.sessionId,
        ...(record.actor.agentId ? { agentId: record.actor.agentId } : {}),
        isSidechain: record.actor.isSidechain,
      },
      actorContext: cloneActorContext(record.actorContext),
      ...(record.action ? { action: cloneAction(record.action) } : {}),
      source: {
        messageUuid: record.source.messageUuid,
        filePath: record.source.filePath,
        ...(record.source.toolUseId ? { toolUseId: record.source.toolUseId } : {}),
        sourceOrder: record.source.sourceOrder,
      },
    }));
  }
}
