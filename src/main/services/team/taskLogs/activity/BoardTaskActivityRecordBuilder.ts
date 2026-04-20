import { createLogger } from '@shared/utils/logger';
import { getTaskDisplayId } from '@shared/utils/taskIdentity';

import type {
  ParsedBoardTaskLink,
  ParsedBoardTaskToolAction,
} from '../contract/BoardTaskTranscriptContract';
import type { BoardTaskActivityRecord } from './BoardTaskActivityRecord';
import type { RawTaskActivityMessage } from './BoardTaskActivityTranscriptReader';
import type {
  BoardTaskActivityAction,
  BoardTaskActivityActor,
  BoardTaskActivityCategory,
  BoardTaskActivityTaskRef,
  BoardTaskLocator,
  TaskRef,
  TeamTask,
} from '@shared/types';

interface TaskLookup {
  byId: Map<string, TeamTask>;
  byDisplayId: Map<string, TeamTask[]>;
}

const logger = createLogger('Service:BoardTaskActivityRecordBuilder');

const CANONICAL_TASK_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function noteReadDiagnostic(
  event: string,
  details: Record<string, string | number | undefined> = {}
): void {
  const suffix = Object.entries(details)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(' ');

  logger.debug(`[board_task_activity.${event}]${suffix ? ` ${suffix}` : ''}`);
}

function buildTaskRef(teamName: string, task: TeamTask): TaskRef {
  return {
    taskId: task.id,
    displayId: getTaskDisplayId(task),
    teamName,
  };
}

function normalizeDisplayRef(value: string): string {
  return value.trim().toLowerCase();
}

function looksLikeCanonicalTaskId(value: string): boolean {
  return CANONICAL_TASK_ID_PATTERN.test(value.trim());
}

function buildTaskLookup(tasks: TeamTask[]): TaskLookup {
  const byId = new Map<string, TeamTask>();
  const byDisplayId = new Map<string, TeamTask[]>();

  for (const task of tasks) {
    byId.set(task.id, task);
    const displayId = normalizeDisplayRef(getTaskDisplayId(task));
    const list = byDisplayId.get(displayId) ?? [];
    list.push(task);
    byDisplayId.set(displayId, list);
  }

  return { byId, byDisplayId };
}

function resolveLocatorToTaskRef(
  teamName: string,
  locator: BoardTaskLocator,
  lookup: TaskLookup
): BoardTaskActivityTaskRef {
  const canonicalCandidate =
    (locator.canonicalId && lookup.byId.get(locator.canonicalId)) ||
    (locator.refKind === 'canonical' ? lookup.byId.get(locator.ref) : undefined) ||
    (locator.refKind === 'unknown' && looksLikeCanonicalTaskId(locator.ref)
      ? lookup.byId.get(locator.ref)
      : undefined);

  if (canonicalCandidate) {
    return {
      locator,
      resolution: canonicalCandidate.status === 'deleted' ? 'deleted' : 'resolved',
      taskRef: buildTaskRef(teamName, canonicalCandidate),
    };
  }

  const displayCandidates = lookup.byDisplayId.get(normalizeDisplayRef(locator.ref)) ?? [];
  if (displayCandidates.length === 1) {
    const task = displayCandidates[0];
    return {
      locator,
      resolution: task.status === 'deleted' ? 'deleted' : 'resolved',
      taskRef: buildTaskRef(teamName, task),
    };
  }

  if (displayCandidates.length > 1) {
    noteReadDiagnostic('ambiguous_locator', { refKind: locator.refKind });
    return {
      locator,
      resolution: 'ambiguous',
    };
  }

  noteReadDiagnostic('unresolved_locator', { refKind: locator.refKind });
  return {
    locator,
    resolution: 'unresolved',
  };
}

function locatorCouldMatchTask(
  locator: BoardTaskLocator,
  targetTask: TeamTask,
  lookup: TaskLookup
): boolean {
  if (locator.canonicalId === targetTask.id) return true;
  if (locator.refKind === 'canonical' && locator.ref === targetTask.id) return true;

  const targetDisplayId = getTaskDisplayId(targetTask);
  const normalizedLocatorRef = normalizeDisplayRef(locator.ref);
  const normalizedTargetDisplayId = normalizeDisplayRef(targetDisplayId);
  if (normalizedLocatorRef !== normalizedTargetDisplayId) return false;

  const candidates = lookup.byDisplayId.get(normalizedTargetDisplayId) ?? [];
  if (candidates.length === 0) return false;
  return candidates.some((candidate) => candidate.id === targetTask.id);
}

function buildActionMap(
  actions: ParsedBoardTaskToolAction[]
): Map<string, ParsedBoardTaskToolAction> {
  const actionMap = new Map<string, ParsedBoardTaskToolAction>();
  for (const action of actions) {
    if (actionMap.has(action.toolUseId)) {
      noteReadDiagnostic('duplicate_action_tool_use_id', { toolUseId: action.toolUseId });
      continue;
    }
    actionMap.set(action.toolUseId, action);
  }
  return actionMap;
}

function buildActionCategory(action: ParsedBoardTaskToolAction): BoardTaskActivityCategory {
  switch (action.canonicalToolName) {
    case 'task_start':
    case 'task_complete':
    case 'task_set_status':
      return 'status';
    case 'review_start':
    case 'review_request':
    case 'review_approve':
    case 'review_request_changes':
      return 'review';
    case 'task_add_comment':
    case 'task_get_comment':
      return 'comment';
    case 'task_set_owner':
      return 'assignment';
    case 'task_get':
      return 'read';
    case 'task_attach_file':
    case 'task_attach_comment_file':
      return 'attachment';
    case 'task_link':
    case 'task_unlink':
      return 'relationship';
    case 'task_set_clarification':
      return 'clarification';
    default:
      return 'other';
  }
}

function buildActionDetails(
  action: ParsedBoardTaskToolAction
): BoardTaskActivityAction['details'] | undefined {
  const details = {
    ...(action.input?.status ? { status: action.input.status } : {}),
    ...(action.input && 'owner' in action.input ? { owner: action.input.owner } : {}),
    ...(action.input && 'clarification' in action.input
      ? { clarification: action.input.clarification }
      : {}),
    ...(action.input?.reviewer ? { reviewer: action.input.reviewer } : {}),
    ...(action.input?.relationship ? { relationship: action.input.relationship } : {}),
    ...(action.input?.commentId ? { commentId: action.input.commentId } : {}),
    ...(action.resultRefs?.commentId ? { commentId: action.resultRefs.commentId } : {}),
    ...(action.resultRefs?.attachmentId ? { attachmentId: action.resultRefs.attachmentId } : {}),
    ...(action.resultRefs?.filename ? { filename: action.resultRefs.filename } : {}),
  };

  return Object.keys(details).length > 0 ? details : undefined;
}

function buildRelationshipPerspective(
  link: ParsedBoardTaskLink,
  action: ParsedBoardTaskToolAction
): BoardTaskActivityAction['relationshipPerspective'] | undefined {
  const relationship = action.input?.relationship;
  if (!relationship) {
    return undefined;
  }
  if (relationship === 'related') {
    return 'symmetric';
  }
  if (relationship === 'blocked-by') {
    return link.targetRole === 'subject' ? 'incoming' : 'outgoing';
  }
  if (relationship === 'blocks') {
    return link.targetRole === 'subject' ? 'outgoing' : 'incoming';
  }
  return undefined;
}

function buildAction(args: {
  action: ParsedBoardTaskToolAction | undefined;
  link: ParsedBoardTaskLink;
  peerTask?: BoardTaskActivityTaskRef;
}): BoardTaskActivityAction | undefined {
  const { action, link, peerTask } = args;
  if (!action) return undefined;
  const category = buildActionCategory(action);
  const details = buildActionDetails(action);
  const relationshipPerspective =
    category === 'relationship' ? buildRelationshipPerspective(link, action) : undefined;

  return {
    canonicalToolName: action.canonicalToolName,
    toolUseId: action.toolUseId,
    category,
    ...(details ? { details } : {}),
    ...(category === 'relationship' && peerTask ? { peerTask } : {}),
    ...(relationshipPerspective ? { relationshipPerspective } : {}),
  };
}

function resolveActivityActor(message: RawTaskActivityMessage): BoardTaskActivityActor {
  const memberName =
    typeof message.agentName === 'string' && message.agentName.trim().length > 0
      ? message.agentName.trim()
      : undefined;

  return {
    ...(memberName ? { memberName } : {}),
    role: memberName
      ? message.isSidechain
        ? 'member'
        : 'lead'
      : message.isSidechain
        ? 'member'
        : 'unknown',
    sessionId: message.sessionId,
    ...(message.agentId ? { agentId: message.agentId } : {}),
    isSidechain: message.isSidechain,
  };
}

function resolvePeerTask(
  teamName: string,
  currentLink: ParsedBoardTaskLink,
  allLinks: ParsedBoardTaskLink[],
  targetTask: TeamTask,
  lookup: TaskLookup
): BoardTaskActivityTaskRef | undefined {
  for (const link of allLinks) {
    if (link === currentLink) continue;
    if (link.toolUseId !== currentLink.toolUseId) continue;
    if (locatorCouldMatchTask(link.task, targetTask, lookup)) continue;
    return resolveLocatorToTaskRef(teamName, link.task, lookup);
  }
  return undefined;
}

function buildActorContext(
  teamName: string,
  actorContext: ParsedBoardTaskLink['actorContext'],
  lookup: TaskLookup
): BoardTaskActivityRecord['actorContext'] {
  return {
    relation: actorContext.relation,
    ...(actorContext.activeTask
      ? { activeTask: resolveLocatorToTaskRef(teamName, actorContext.activeTask, lookup) }
      : {}),
    ...(actorContext.activePhase ? { activePhase: actorContext.activePhase } : {}),
    ...(actorContext.activeExecutionSeq
      ? { activeExecutionSeq: actorContext.activeExecutionSeq }
      : {}),
  };
}

function compareRecords(left: BoardTaskActivityRecord, right: BoardTaskActivityRecord): number {
  const leftTs = Date.parse(left.timestamp);
  const rightTs = Date.parse(right.timestamp);
  if (Number.isFinite(leftTs) && Number.isFinite(rightTs) && leftTs !== rightTs) {
    return leftTs - rightTs;
  }
  if (left.source.filePath !== right.source.filePath) {
    return left.source.filePath.localeCompare(right.source.filePath);
  }
  if (left.source.sourceOrder !== right.source.sourceOrder) {
    return left.source.sourceOrder - right.source.sourceOrder;
  }
  if ((left.source.toolUseId ?? '') !== (right.source.toolUseId ?? '')) {
    return (left.source.toolUseId ?? '').localeCompare(right.source.toolUseId ?? '');
  }
  return left.id.localeCompare(right.id);
}

function resolveCandidateTaskIds(locator: BoardTaskLocator, lookup: TaskLookup): string[] {
  const canonicalTask =
    (locator.canonicalId && lookup.byId.get(locator.canonicalId)) ||
    (locator.refKind === 'canonical' ? lookup.byId.get(locator.ref) : undefined) ||
    (locator.refKind === 'unknown' && looksLikeCanonicalTaskId(locator.ref)
      ? lookup.byId.get(locator.ref)
      : undefined);
  if (canonicalTask) {
    return [canonicalTask.id];
  }

  const displayCandidates = lookup.byDisplayId.get(normalizeDisplayRef(locator.ref)) ?? [];
  return [...new Set(displayCandidates.map((task) => task.id))];
}

export class BoardTaskActivityRecordBuilder {
  buildForTask(args: {
    teamName: string;
    targetTask: TeamTask;
    tasks: TeamTask[];
    messages: RawTaskActivityMessage[];
  }): BoardTaskActivityRecord[] {
    return (
      this.buildForTasks({
        teamName: args.teamName,
        tasks: args.tasks,
        messages: args.messages,
      }).get(args.targetTask.id) ?? []
    );
  }

  buildForTasks(args: {
    teamName: string;
    tasks: TeamTask[];
    messages: RawTaskActivityMessage[];
  }): Map<string, BoardTaskActivityRecord[]> {
    const lookup = buildTaskLookup(args.tasks);
    const recordsByTaskId = new Map<string, BoardTaskActivityRecord[]>();
    const seenIdsByTaskId = new Map<string, Set<string>>();

    for (const message of args.messages) {
      const actionMap = buildActionMap(message.boardTaskToolActions);

      for (const link of message.boardTaskLinks) {
        const resolvedTask = resolveLocatorToTaskRef(args.teamName, link.task, lookup);
        const candidateTaskIds = resolveCandidateTaskIds(link.task, lookup);
        if (candidateTaskIds.length === 0) {
          continue;
        }
        const action =
          link.linkKind === 'execution' || !link.toolUseId
            ? undefined
            : actionMap.get(link.toolUseId);

        for (const taskId of candidateTaskIds) {
          const targetTask = lookup.byId.get(taskId);
          if (!targetTask) {
            continue;
          }
          if (
            resolvedTask.taskRef?.taskId !== targetTask.id &&
            !locatorCouldMatchTask(link.task, targetTask, lookup)
          ) {
            continue;
          }

          const peerTask = resolvePeerTask(
            args.teamName,
            link,
            message.boardTaskLinks,
            targetTask,
            lookup
          );
          const record: BoardTaskActivityRecord = {
            id: [
              message.uuid,
              link.toolUseId ?? 'ambient',
              link.task.ref,
              link.targetRole,
              link.linkKind,
            ].join(':'),
            timestamp: message.timestamp,
            task: resolvedTask,
            linkKind: link.linkKind,
            targetRole: link.targetRole,
            actor: resolveActivityActor(message),
            actorContext: buildActorContext(args.teamName, link.actorContext, lookup),
            ...(action ? { action: buildAction({ action, link, peerTask }) } : {}),
            source: {
              messageUuid: message.uuid,
              filePath: message.filePath,
              ...(link.toolUseId ? { toolUseId: link.toolUseId } : {}),
              sourceOrder: message.sourceOrder,
            },
          };

          const seenIds = seenIdsByTaskId.get(taskId) ?? new Set<string>();
          if (seenIds.has(record.id)) {
            continue;
          }
          seenIds.add(record.id);
          seenIdsByTaskId.set(taskId, seenIds);

          const taskRecords = recordsByTaskId.get(taskId) ?? [];
          taskRecords.push(record);
          recordsByTaskId.set(taskId, taskRecords);
        }
      }
    }

    for (const [taskId, records] of recordsByTaskId) {
      recordsByTaskId.set(taskId, records.sort(compareRecords));
    }

    return recordsByTaskId;
  }
}
