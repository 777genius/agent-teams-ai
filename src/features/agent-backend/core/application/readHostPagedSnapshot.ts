import { assembleHostMessageParts } from './assembleHostMessageParts';
import { assembleHostTaskSubject, type HostTaskSubjectFragment } from './assembleHostTaskSubject';

import type { BackendConnectionSnapshot } from '../../contracts/connections';
import type { AgentBackendApi } from '../../contracts/operations';
import type { BackendTeamSnapshot } from '../../contracts/teamSnapshot';
import type { TeamProductReadOrder } from './TeamProductReadOrder';
import type { TeamReadUnavailable } from '@shared/types/team';

type Connection = BackendConnectionSnapshot['bindings'][number];
type CurrentScope = () => boolean;

/** Only original finite snapshot refusals carry their captured publication assertion. */
export class HostTeamReadUnavailableError extends Error {
  constructor(
    readonly code: TeamReadUnavailable['code'],
    readonly outcome: TeamReadUnavailable['outcome'],
    readonly assertCurrent: () => void
  ) {
    super('Host team read ' + code);
    this.name = 'HostTeamReadUnavailableError';
  }
}

const MAX_PAGES = 128;
const TASK_TEXT_FIELDS = ['description', 'prompt'] as const;
const TASK_ARRAY_FIELDS = [
  'comments',
  'historyEvents',
  'workIntervals',
  'reviewIntervals',
  'attachments',
  'descriptionTaskRefs',
  'promptTaskRefs',
  'blocks',
  'blockedBy',
  'related',
] as const;
type Task = BackendTeamSnapshot['tasks'][number];
type Message = BackendTeamSnapshot['messages'][number];
type CommentPart = NonNullable<
  NonNullable<BackendTeamSnapshot['taskParts']>[number]['commentPart']
>;
interface TaskGroup {
  total: number;
  values: Map<number, Task>;
  commentParts?: Map<number, CommentPart>;
  historyParts?: Map<number, CommentPart>;
  subjectParts?: Map<number, { part: number; total: number }>;
}

/** Merge only projected task parts; never publish incomplete nested history. */
export function assembleTaskParts(
  groups: Map<number, TaskGroup>,
  taskTotal: number
): BackendTeamSnapshot['tasks'] {
  if (groups.size !== taskTotal) throw new Error('Missing Host task pages');
  const tasks: BackendTeamSnapshot['tasks'] = [];
  for (let index = 0; index < taskTotal; index++) {
    const group = groups.get(index);
    if (!group || group.values.size !== group.total)
      throw new Error('Incomplete Host task history');
    const base = group.values.get(0);
    if (!base) throw new Error('Missing Host task base');
    const merged: Record<string, unknown> = { ...base };
    const subjects = new Map<number, HostTaskSubjectFragment>();
    let pendingComment:
      | {
          field: 'comments' | 'historyEvents';
          index: number;
          total: number;
          next: number;
          metadata: string;
          value: Record<string, unknown>;
        }
      | undefined;
    for (let part = 1; part < group.total; part++) {
      const value = group.values.get(part);
      if (!value || value.id !== base.id || value.status !== base.status)
        throw new Error('Mismatched Host task fragment');
      const extra = value as unknown as Record<string, unknown>;
      const subjectPart = group.subjectParts?.get(part);
      if (subjectPart) {
        if (
          base.subject !== '' ||
          pendingComment ||
          group.commentParts?.has(part) ||
          group.historyParts?.has(part) ||
          subjects.has(subjectPart.part) ||
          subjectPart.part !== subjects.size ||
          Object.keys(extra).some(
            (key) => !['id', 'subject', 'status', 'kanbanColumn', 'reviewer'].includes(key)
          )
        )
          throw new Error('Invalid Host subject fragment');
        subjects.set(subjectPart.part, { total: subjectPart.total, subject: value.subject });
        continue;
      }
      if (value.subject !== base.subject) throw new Error('Mismatched Host task fragment');
      const commentPart = group.commentParts?.get(part);
      const historyPart = group.historyParts?.get(part);
      if (commentPart && historyPart) throw new Error('Mixed Host history fragment');
      const fragment = commentPart ?? historyPart;
      if (fragment) {
        // Publish only a complete comment or event from matching projected parts.
        const field = historyPart ? 'historyEvents' : 'comments';
        const textField = historyPart ? 'note' : 'text';
        const items = extra[field];
        if (
          !Array.isArray(items) ||
          items.length !== 1 ||
          TASK_ARRAY_FIELDS.some((other) => other !== field && extra[other] !== undefined) ||
          TASK_TEXT_FIELDS.some((field) => extra[field] !== undefined) ||
          extra.sourceMessage !== undefined
        )
          throw new Error('Invalid Host comment fragment');
        const comment = items[0] as Record<string, unknown> | undefined;
        if (!comment) throw new Error('Invalid Host comment text');
        const { [textField]: text, ...identity } = comment;
        if (typeof text !== 'string') throw new Error('Invalid Host comment text');
        const metadata = JSON.stringify(identity);
        if (fragment.part === 0) {
          if (
            pendingComment ||
            fragment.index !== ((merged[field] as unknown[] | undefined)?.length ?? 0)
          )
            throw new Error('Out-of-order Host comment fragment');
          pendingComment = {
            field,
            index: fragment.index,
            total: fragment.total,
            next: 0,
            metadata,
            value: { ...comment, [textField]: '' },
          };
        }
        if (
          !pendingComment ||
          pendingComment.field !== field ||
          pendingComment.index !== fragment.index ||
          pendingComment.total !== fragment.total ||
          pendingComment.next !== fragment.part ||
          pendingComment.metadata !== metadata
        )
          throw new Error('Mismatched Host comment fragment');
        pendingComment.value[textField] = (pendingComment.value[textField] as string) + text;
        pendingComment.next++;
        if (pendingComment.next === pendingComment.total) {
          merged[field] = [
            ...((merged[field] as unknown[] | undefined) ?? []),
            pendingComment.value,
          ];
          pendingComment = undefined;
        }
        continue;
      }
      if (pendingComment) throw new Error('Incomplete Host comment fragment');
      if (value.sourceMessage !== undefined) {
        const source = value.sourceMessage;
        if (
          !base.sourceMessage ||
          base.sourceMessage.text !== '' ||
          !base.sourceMessageId ||
          value.sourceMessageId !== base.sourceMessageId ||
          source.from !== base.sourceMessage.from ||
          source.timestamp !== base.sourceMessage.timestamp ||
          source.source !== base.sourceMessage.source ||
          typeof source.text !== 'string' ||
          Object.keys(source).some(
            (key) => !['from', 'timestamp', 'source', 'text'].includes(key)
          ) ||
          Object.keys(extra).some(
            (key) =>
              ![
                'id',
                'subject',
                'status',
                'sourceMessageId',
                'sourceMessage',
                'kanbanColumn',
                'reviewer',
              ].includes(key)
          )
        )
          throw new Error('Mismatched Host source message fragment');
        const previous = merged.sourceMessage as NonNullable<Task['sourceMessage']>;
        merged.sourceMessage = { ...previous, text: previous.text + source.text };
        continue;
      }
      for (const field of TASK_ARRAY_FIELDS) {
        if (extra[field] === undefined) continue;
        const items = extra[field];
        if (!Array.isArray(items)) throw new Error('Invalid Host task history');
        const prior = merged[field];
        if (prior !== undefined && !Array.isArray(prior))
          throw new Error('Mismatched Host task history');
        merged[field] = [...((prior as unknown[] | undefined) ?? []), ...items];
      }
      for (const field of TASK_TEXT_FIELDS) {
        const chunk = extra[field];
        if (chunk === undefined) continue;
        const previous = merged[field];
        if (typeof chunk !== 'string' || (previous !== undefined && typeof previous !== 'string'))
          throw new Error('Mismatched Host task text fragment');
        merged[field] = (previous ?? '') + chunk;
      }
    }
    if (pendingComment) throw new Error('Incomplete Host comment fragment');
    if (group.subjectParts?.size) merged.subject = assembleHostTaskSubject(subjects);
    tasks.push(merged as unknown as Task);
  }
  return tasks;
}

/** Only complete projected message text leaves the page-assembly boundary. */
function assembleMessageParts(
  groups: Map<number, { total: number; values: Map<number, Message> }>,
  messageTotal: number
): BackendTeamSnapshot['messages'] {
  if (groups.size !== messageTotal) throw new Error('Missing Host message pages');
  const messages: BackendTeamSnapshot['messages'] = [];
  for (let index = 0; index < messageTotal; index++) {
    const group = groups.get(index);
    if (!group || group.values.size !== group.total)
      throw new Error('Incomplete Host message text');
    messages.push(assembleHostMessageParts(group));
  }
  return messages;
}

/** Publish a complete read only after bounded Owner pages pass the original fences. */
export async function readHostPagedSnapshot(
  backend: Pick<AgentBackendApi, 'invoke'>,
  connection: Connection,
  check: CurrentScope,
  readOrder: TeamProductReadOrder
): Promise<{ data: BackendTeamSnapshot; assertCurrent(): void }> {
  const assertScope = () => {
    if (!check()) throw new Error('Team context changed');
  };
  readOrder.capture(check);
  const handleId = connection.handle.handleId;
  const readFence = readOrder.readFence(handleId);
  const refusedPosition = readOrder.position(handleId);
  const assertRefusalCurrent = () => {
    assertScope();
    readFence();
    const position = readOrder.position(handleId);
    if (
      position?.streamId !== refusedPosition?.streamId ||
      position?.sequence !== refusedPosition?.sequence
    )
      throw new Error('Stale Host product snapshot');
  };
  let cursor: string | undefined;
  let first: BackendTeamSnapshot | undefined;
  const tasks: BackendTeamSnapshot['tasks'] = [];
  const taskParts = new Map<number, TaskGroup>();
  const messages: BackendTeamSnapshot['messages'] = [];
  const messageParts = new Map<number, { total: number; values: Map<number, Message> }>();
  let kanbanState: BackendTeamSnapshot['kanbanState'] | undefined;
  const seen = new Set<string>();

  for (let index = 0; index < MAX_PAGES; index++) {
    const result = await backend.invoke({
      handle: connection.handle,
      commandId: crypto.randomUUID(),
      operation: 'team.snapshot',
      payload: cursor ? { cursor } : {},
    });
    assertScope();
    if (!result.ok) {
      assertRefusalCurrent();
      if (
        result.code === 'busy' ||
        result.code === 'unavailable' ||
        result.code === 'shutting-down'
      )
        throw new HostTeamReadUnavailableError(result.code, result.outcome, assertRefusalCurrent);
      throw new Error('Host team read ' + result.code);
    }
    if (!result.value || !('revision' in result.value) || !('kanbanState' in result.value))
      throw new Error('Invalid Host team snapshot');
    const page = result.value;
    readFence();
    if (first) {
      if (
        page.revision !== first.revision ||
        page.teamName !== first.teamName ||
        page.feed.streamId !== first.feed.streamId ||
        page.feed.sequence !== first.feed.sequence ||
        page.autonomousGoalAvailable !== first.autonomousGoalAvailable ||
        JSON.stringify(page.autonomousGoal) !== JSON.stringify(first.autonomousGoal) ||
        page.taskTotal !== first.taskTotal ||
        Boolean(page.taskParts) !== Boolean(first.taskParts) ||
        page.messageTotal !== first.messageTotal ||
        Boolean(page.messageParts) !== Boolean(first.messageParts)
      )
        throw new Error('Host team changed during paged read');
    } else {
      first = page;
    }
    if (page.taskParts) {
      if (page.taskParts.length !== page.tasks.length || page.taskTotal === undefined)
        throw new Error('Invalid Host task page');
      for (const [position, task] of page.tasks.entries()) {
        const marker = page.taskParts[position];
        if (!marker || marker.index >= page.taskTotal || marker.part >= marker.total)
          throw new Error('Invalid Host task part');
        let group = taskParts.get(marker.index);
        if (!group) {
          group = { total: marker.total, values: new Map<number, Task>() };
          taskParts.set(marker.index, group);
        }
        if (group.total !== marker.total || group.values.has(marker.part))
          throw new Error('Duplicate Host task fragment');
        group.values.set(marker.part, task);
        if (marker.commentPart) {
          group.commentParts ??= new Map();
          group.commentParts.set(marker.part, marker.commentPart);
        }
        if (marker.historyPart) {
          group.historyParts ??= new Map();
          group.historyParts.set(marker.part, marker.historyPart);
        }
        if (marker.subjectPart) {
          group.subjectParts ??= new Map();
          group.subjectParts.set(marker.part, marker.subjectPart);
        }
      }
    } else {
      tasks.push(...page.tasks);
    }
    if (page.messageParts) {
      if (page.messageParts.length !== page.messages.length || page.messageTotal === undefined)
        throw new Error('Invalid Host message page');
      for (const [position, message] of page.messages.entries()) {
        const marker = page.messageParts[position];
        if (!marker || marker.index >= page.messageTotal || marker.part >= marker.total)
          throw new Error('Invalid Host message part');
        let group = messageParts.get(marker.index);
        if (!group) {
          group = { total: marker.total, values: new Map<number, Message>() };
          messageParts.set(marker.index, group);
        }
        if (group.total !== marker.total || group.values.has(marker.part))
          throw new Error('Duplicate Host message fragment');
        group.values.set(marker.part, message);
      }
    } else {
      messages.push(...page.messages);
    }
    // Page-local Kanban fragments are not a complete board. Reconstruct the
    // original ordered map and column arrays before exposing any product view.
    if (!kanbanState)
      kanbanState = {
        ...page.kanbanState,
        tasks: {},
        reviewers: [],
        ...(page.kanbanState.columnOrder ? { columnOrder: {} } : {}),
      };
    kanbanState.reviewers.push(...page.kanbanState.reviewers);
    for (const [taskId, entry] of Object.entries(page.kanbanState.tasks)) {
      if (Object.hasOwn(kanbanState.tasks, taskId))
        throw new Error('Duplicate Host Kanban task across pages');
      kanbanState.tasks[taskId] = entry;
    }
    for (const [column, ids] of Object.entries(page.kanbanState.columnOrder ?? {})) {
      const key = column as keyof NonNullable<BackendTeamSnapshot['kanbanState']['columnOrder']>;
      const original = kanbanState.columnOrder?.[key] ?? [];
      kanbanState.columnOrder ??= {};
      kanbanState.columnOrder[key] = [...original, ...ids];
    }

    if (page.nextCursor === undefined || page.nextCursor === null) {
      const completeKanban = kanbanState;
      if (!completeKanban) throw new Error('Missing Host Kanban state');
      const reconstructed = first.taskParts
        ? assembleTaskParts(taskParts, first.taskTotal ?? 0)
        : tasks;
      const fullTasks = reconstructed.map((task) => {
        const board = completeKanban.tasks[task.id];
        return board ? { ...task, kanbanColumn: board.column, reviewer: board.reviewer } : task;
      });
      const data: BackendTeamSnapshot = {
        ...first,
        tasks: fullTasks,
        messages: first.messageParts
          ? assembleMessageParts(messageParts, first.messageTotal ?? 0)
          : messages,
        kanbanState: completeKanban,
      };
      delete data.nextCursor;
      delete data.taskTotal;
      delete data.taskParts;
      delete data.messageTotal;
      delete data.messageParts;
      readOrder.acceptSnapshot(handleId, data);
      return {
        data,
        assertCurrent: () => {
          assertScope();
          readFence();
          readOrder.assertCurrent(handleId, data.feed);
        },
      };
    }
    if (seen.has(page.nextCursor)) throw new Error('Repeated Host team page cursor');
    seen.add(page.nextCursor);
    cursor = page.nextCursor;
  }
  throw new Error('Host team snapshot exceeded page budget');
}
