import { parseStandaloneSlashCommand } from '@shared/utils/slashCommands';

import {
  qualifyHostTaskReferenceTeam,
  storeHostTaskReferenceTeam,
  translateHostTaskReferences,
} from './translateHostTaskReferences';
import { prepareHostAttachments, uploadHostAttachments } from './uploadHostAttachments';

import type { BackendHandle } from '../contracts';
import type { BackendConnectionSnapshot } from '../contracts/connections';
import type {
  AgentBackendApi,
  BackendCommandReceipt,
  BackendOperationRequest,
  BackendTask,
} from '../contracts/operations';
import type { AttachmentUpload } from '@agent-teams/legacy-agent-host/attachments/contracts';
import type { NormalizedAttachmentPayload } from '@agent-teams/legacy-agent-host/attachments/portable';
import type { AttachmentPayload, CommentAttachmentPayload } from '@shared/types/team';
import type {
  AddTaskCommentRequest,
  CreateTaskRequest,
  KanbanColumnId,
  SendMessageRequest,
  TaskComment,
  TaskRef,
  TeamTask,
  TeamTaskStatus,
  UpdateKanbanPatch,
} from '@shared/types/team';

/** Safe correlation for explicit lookup after an uncertain result; no automatic replay. */
export class HostTeamOperationError extends Error {
  constructor(
    readonly code: string,
    readonly outcome: string,
    readonly commandId?: string
  ) {
    super(`Host team operation ${code} (${outcome})`);
  }
}
function unsupported(): never {
  throw new HostTeamOperationError('unsupported', 'not-dispatched');
}
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return unsupported();
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some((key) => row[key] !== undefined && !keys.includes(key)))
    return unsupported();
  return row;
}
function attachments(
  source: readonly (AttachmentPayload | CommentAttachmentPayload)[] | undefined,
  purpose: 'task' | 'message'
): NormalizedAttachmentPayload[] {
  try {
    return prepareHostAttachments(source, purpose);
  } catch {
    return unsupported();
  }
}
function uiComment(
  comment: NonNullable<BackendCommandReceipt['comment']>,
  commandId?: string
): TaskComment {
  if (
    typeof comment.author !== 'string' ||
    typeof comment.text !== 'string' ||
    typeof comment.createdAt !== 'string' ||
    !['regular', 'review_request', 'review_approved'].includes(comment.type ?? '')
  )
    throw new HostTeamOperationError('invalid-result', 'unknown', commandId);
  return {
    ...comment,
    author: comment.author,
    text: comment.text,
    createdAt: comment.createdAt,
    type: comment.type as TaskComment['type'],
  };
}
function uiTask(task: BackendTask | undefined, commandId: string): TeamTask {
  if (
    !task ||
    typeof task.subject !== 'string' ||
    !['pending', 'in_progress', 'completed', 'deleted'].includes(task.status)
  )
    throw new HostTeamOperationError('invalid-result', 'unknown', commandId);
  const { comments, ...fields } = task;
  return {
    ...fields,
    subject: task.subject,
    status: task.status as TeamTaskStatus,
    ...(comments ? { comments: comments.map((comment) => uiComment(comment, commandId)) } : {}),
  };
}

/** Small compatibility input adapter; captures one command and one original handle per invocation. */
export function createHostTeamMutations(options: {
  backend: AgentBackendApi;
  resolve(
    key: string,
    current: () => boolean,
    referenceTeams?: readonly string[]
  ): Promise<{
    handle: BackendHandle;
    teamName: string;
    referenceBindings?: BackendConnectionSnapshot['bindings'];
  }>;
  captureScope(): () => boolean;
  invalidateReads?(handle: BackendHandle): void;
}) {
  function refs(source: TaskRef[] | undefined): TaskRef[] | undefined {
    if (source === undefined) return undefined;
    if (!Array.isArray(source)) return unsupported();
    if (source.some((ref) => !ref || typeof ref.teamName !== 'string' || !ref.teamName))
      return unsupported();
    return source.map((ref) => ({ ...ref }));
  }
  async function execute(
    key: string,
    command: Omit<BackendOperationRequest, 'handle'>,
    upload?: {
      purpose: AttachmentUpload['purpose'];
      source?: readonly NormalizedAttachmentPayload[];
    }
  ) {
    // Convert UI selection references only after resolving the original captured target.
    const current = options.captureScope();
    const payload = { ...command.payload } as Record<string, unknown>;
    const referenceTeams = new Set<string>();
    const collect = (team?: string) => {
      if (team !== undefined && team !== key) referenceTeams.add(team);
      return team ?? key;
    };
    for (const field of ['text', 'description', 'prompt', 'summary', 'comment', 'note']) {
      if (typeof payload[field] === 'string') translateHostTaskReferences(payload[field], collect);
    }
    for (const field of ['taskRefs', 'descriptionTaskRefs', 'promptTaskRefs']) {
      const source = payload[field] as TaskRef[] | undefined;
      source?.forEach((ref) => collect(ref.teamName));
    }
    const target = await options.resolve(key, current, [...referenceTeams]);
    const toCanonical = (team?: string) => {
      const stored = storeHostTaskReferenceTeam(
        team,
        target.teamName,
        key,
        target.referenceBindings ?? []
      );
      return stored ?? unsupported();
    };
    for (const field of ['text', 'description', 'prompt', 'summary', 'comment', 'note']) {
      if (typeof payload[field] === 'string')
        payload[field] = translateHostTaskReferences(payload[field], toCanonical);
    }
    for (const field of ['taskRefs', 'descriptionTaskRefs', 'promptTaskRefs']) {
      const source = payload[field] as TaskRef[] | undefined;
      if (source)
        payload[field] = source.map((ref) => ({ ...ref, teamName: toCanonical(ref.teamName) }));
    }
    if (!current())
      throw new HostTeamOperationError('context-changed', 'not-dispatched', command.commandId);
    if (upload?.source?.length) {
      try {
        const uploaded = await uploadHostAttachments({
          backend: options.backend,
          handle: target.handle,
          current,
          commandId: command.commandId,
          purpose: upload.purpose,
          source: upload.source,
        });
        if (command.operation === 'task.attachment.add') payload.attachment = uploaded[0];
        else payload.attachments = uploaded;
      } catch {
        throw new HostTeamOperationError('attachment-upload', 'unknown', command.commandId);
      }
    }
    // Avoid a second owner lookup: this immutable handle remains the original authority through send.
    const receipt = await mutateResolved(target.handle, current, { ...command, payload } as Omit<
      BackendOperationRequest,
      'handle'
    >);
    const qualify = (source: TaskRef[] | undefined) =>
      source?.map((ref) => ({
        ...ref,
        teamName: qualifyHostTaskReferenceTeam(
          ref.teamName,
          target.teamName,
          key,
          target.referenceBindings
        ),
      }));
    if (receipt.task) {
      const task = { ...receipt.task };
      const toSelection = (team?: string) =>
        qualifyHostTaskReferenceTeam(team, target.teamName, key, target.referenceBindings);
      if (task.description !== undefined)
        task.description = translateHostTaskReferences(task.description, toSelection);
      if (task.descriptionTaskRefs) task.descriptionTaskRefs = qualify(task.descriptionTaskRefs);
      if (task.prompt !== undefined)
        task.prompt = translateHostTaskReferences(task.prompt, toSelection);
      if (task.promptTaskRefs) task.promptTaskRefs = qualify(task.promptTaskRefs);
      if (task.comments)
        task.comments = task.comments.map((comment) => {
          return {
            ...comment,
            ...(comment.text === undefined
              ? {}
              : { text: translateHostTaskReferences(comment.text, toSelection) }),
            ...(comment.taskRefs ? { taskRefs: qualify(comment.taskRefs) } : {}),
          };
        });
      receipt.task = task;
    }
    if (receipt.comment) {
      const comment = { ...receipt.comment };
      if (comment.taskRefs) comment.taskRefs = qualify(comment.taskRefs);
      if (comment.text !== undefined)
        comment.text = translateHostTaskReferences(comment.text, (team) =>
          qualifyHostTaskReferenceTeam(team, target.teamName, key, target.referenceBindings)
        );
      receipt.comment = comment;
    }
    return receipt;
  }
  async function mutateResolved(
    handle: BackendHandle,
    current: () => boolean,
    command: Omit<BackendOperationRequest, 'handle'>
  ) {
    if (!current())
      throw new HostTeamOperationError('context-changed', 'not-dispatched', command.commandId);
    let result;
    options.invalidateReads?.(handle);
    try {
      result = await options.backend.invoke({ ...command, handle } as BackendOperationRequest);
    } catch {
      throw new HostTeamOperationError('transport-unavailable', 'unknown', command.commandId);
    } finally {
      if (current()) options.invalidateReads?.(handle);
    }
    if (!current())
      throw new HostTeamOperationError('context-changed', 'unknown', command.commandId);
    if (!result.ok)
      throw new HostTeamOperationError(result.code, result.outcome, command.commandId);
    if (
      !result.value ||
      !('commandId' in result.value) ||
      result.value.commandId !== command.commandId
    )
      throw new HostTeamOperationError('invalid-result', 'unknown', command.commandId);
    const receipt = structuredClone(result.value) as BackendCommandReceipt;
    if (receipt.operation !== command.operation)
      throw new HostTeamOperationError('invalid-result', 'unknown', command.commandId);
    if (receipt.phase !== 'completed')
      throw new HostTeamOperationError(
        receipt.phase,
        receipt.phase === 'rejected' ? 'rejected' : 'unknown',
        command.commandId
      );
    return receipt;
  }
  const lifecycle = async (
    key: string,
    taskId: string,
    action: 'start' | 'complete' | 'delete' | 'restore' | 'pending'
  ) => {
    await execute(key, {
      commandId: crypto.randomUUID(),
      operation: 'task.lifecycle',
      payload: { taskId, action },
    });
  };
  const start = async (key: string, taskId: string, notification: 'legacy' | 'user') => {
    const receipt = await execute(key, {
      commandId: crypto.randomUUID(),
      operation: 'task.start',
      payload: { taskId, notification },
    });
    if (typeof receipt.notifiedOwner !== 'boolean')
      throw new HostTeamOperationError('invalid-result', 'unknown', receipt.commandId);
    return { notifiedOwner: receipt.notifiedOwner };
  };
  return {
    async requestReview(key: string, taskId: string) {
      await execute(key, {
        commandId: crypto.randomUUID(),
        operation: 'task.review',
        payload: { taskId, action: 'request' },
      });
    },
    async updateKanban(key: string, taskId: string, input: UpdateKanbanPatch) {
      const patch = structuredClone(input);
      if (patch.op === 'disapprove') {
        object(patch, ['op']);
        await execute(key, {
          commandId: crypto.randomUUID(),
          operation: 'task.review',
          payload: { taskId, action: 'disapprove' },
        });
        return;
      }
      if (patch.op === 'remove') {
        object(patch, ['op']);
        await execute(key, {
          commandId: crypto.randomUUID(),
          operation: 'task.board.clear',
          payload: { taskId },
        });
        return;
      }
      if (patch.op === 'set_column') {
        object(patch, ['op', 'column']);
        if (patch.column !== 'review' && patch.column !== 'approved') return unsupported();
        await execute(key, {
          commandId: crypto.randomUUID(),
          operation: 'task.review',
          payload:
            patch.column === 'review'
              ? { taskId, action: 'request' }
              : { taskId, action: 'approve', notifyOwner: true, suppressTaskComment: true },
        });
        return;
      }
      if (patch.op !== 'request_changes') return unsupported();
      object(patch, ['op', 'comment', 'taskRefs']);
      const taskRefs = refs(patch.taskRefs);
      await execute(key, {
        commandId: crypto.randomUUID(),
        operation: 'task.review',
        payload: {
          taskId,
          action: 'request_changes',
          comment: patch.comment?.trim() || 'Reviewer requested changes.',
          ...(taskRefs === undefined ? {} : { taskRefs }),
        },
      });
    },
    startTask: (key: string, taskId: string) => start(key, taskId, 'legacy'),
    startTaskByUser: (key: string, taskId: string) => start(key, taskId, 'user'),
    async createTask(key: string, input: CreateTaskRequest) {
      const request = structuredClone(input);
      object(request, [
        'command',
        'subject',
        'description',
        'owner',
        'blockedBy',
        'descriptionTaskRefs',
        'related',
        'prompt',
        'promptTaskRefs',
        'startImmediately',
      ]);
      if (request.startImmediately !== undefined && typeof request.startImmediately !== 'boolean')
        return unsupported();
      // Canonical Desktop semantics only start assigned tasks. The running-team
      // dialog also sends true for an unowned task, which has no start target.
      if (request.command !== undefined) {
        object(request.command, ['commandId', 'idempotencyKey']);
        if (request.command.commandId !== request.command.idempotencyKey) return unsupported();
      }
      const commandId = request.command?.commandId ?? crypto.randomUUID();
      const descriptionTaskRefs = refs(request.descriptionTaskRefs);
      const promptTaskRefs = refs(request.promptTaskRefs);
      const receipt = await execute(key, {
        commandId,
        operation: 'task.create',
        payload: {
          subject: request.subject,
          ...(request.related?.length ? { related: request.related } : {}),
          ...(request.prompt?.trim() ? { prompt: request.prompt } : {}),
          ...(promptTaskRefs?.length ? { promptTaskRefs } : {}),
          ...(request.owner && request.startImmediately === true ? { startImmediately: true } : {}),
          ...(request.description === undefined ? {} : { description: request.description }),
          ...(request.owner === undefined ? {} : { owner: request.owner }),
          ...(request.blockedBy === undefined ? {} : { blockedBy: request.blockedBy }),
          ...(descriptionTaskRefs === undefined ? {} : { descriptionTaskRefs }),
        },
      });
      return uiTask(receipt.task, receipt.commandId);
    },
    async updateTaskFields(
      key: string,
      taskId: string,
      fields: { subject?: string; description?: string }
    ) {
      object(fields, ['subject', 'description']);
      await execute(key, {
        commandId: crypto.randomUUID(),
        operation: 'task.update',
        payload: { ...structuredClone(fields), taskId },
      });
    },
    async updateKanbanColumnOrder(key: string, columnId: KanbanColumnId, orderedTaskIds: string[]) {
      await execute(key, {
        commandId: crypto.randomUUID(),
        operation: 'task.board.order',
        payload: { columnId, orderedTaskIds: [...orderedTaskIds] },
      });
    },
    async addTaskRelationship(
      key: string,
      taskId: string,
      targetId: string,
      type: 'blockedBy' | 'blocks' | 'related'
    ) {
      await execute(key, {
        commandId: crypto.randomUUID(),
        operation: 'task.relationship',
        payload: { taskId, targetId, type, action: 'add' },
      });
    },
    async removeTaskRelationship(
      key: string,
      taskId: string,
      targetId: string,
      type: 'blockedBy' | 'blocks' | 'related'
    ) {
      await execute(key, {
        commandId: crypto.randomUUID(),
        operation: 'task.relationship',
        payload: { taskId, targetId, type, action: 'remove' },
      });
    },
    async setTaskClarification(key: string, taskId: string, value: 'lead' | 'user' | null) {
      await execute(key, {
        commandId: crypto.randomUUID(),
        operation: 'task.clarification',
        payload: { taskId, value },
      });
    },
    async updateTaskOwner(key: string, taskId: string, owner: string | null) {
      await execute(key, {
        commandId: crypto.randomUUID(),
        operation: 'task.assign',
        payload: { taskId, owner },
      });
    },
    async updateTaskStatus(key: string, taskId: string, status: TeamTaskStatus) {
      const action = {
        pending: 'pending',
        in_progress: 'start',
        completed: 'complete',
        deleted: 'delete',
      }[status];
      if (!action) return unsupported();
      await lifecycle(key, taskId, action as 'pending' | 'start' | 'complete' | 'delete');
    },
    softDeleteTask: (key: string, taskId: string) => lifecycle(key, taskId, 'delete'),
    restoreTask: (key: string, taskId: string) => lifecycle(key, taskId, 'restore'),
    async saveTaskAttachment(
      key: string,
      taskId: string,
      attachmentId: string,
      filename: string,
      mimeType: string,
      base64Data: string
    ) {
      const files = attachments([{ id: attachmentId, filename, mimeType, base64Data }], 'task');
      const receipt = await execute(
        key,
        { commandId: crypto.randomUUID(), operation: 'task.attachment.add', payload: { taskId } },
        { purpose: { kind: 'task', taskId }, source: files }
      );
      const metadata = receipt.task?.attachments?.find((item) => item.id === attachmentId);
      if (!metadata)
        throw new HostTeamOperationError('invalid-result', 'unknown', receipt.commandId);
      return metadata;
    },
    async deleteTaskAttachment(key: string, taskId: string, attachmentId: string) {
      await execute(key, {
        commandId: crypto.randomUUID(),
        operation: 'task.attachment.remove',
        payload: { taskId, attachmentId },
      });
    },
    async addTaskComment(key: string, taskId: string, input: AddTaskCommentRequest) {
      const request = structuredClone(input);
      object(request, ['text', 'taskRefs', 'attachments']);
      const files = attachments(request.attachments, 'task');
      const taskRefs = refs(request.taskRefs);
      const receipt = await execute(
        key,
        {
          commandId: crypto.randomUUID(),
          operation: 'task.comment',
          payload: { taskId, text: request.text, ...(taskRefs === undefined ? {} : { taskRefs }) },
        },
        { purpose: { kind: 'task', taskId }, ...(files.length ? { source: files } : {}) }
      );
      if (!receipt.comment)
        throw new HostTeamOperationError('invalid-result', 'unknown', receipt.commandId);
      return uiComment(receipt.comment, receipt.commandId);
    },
    async sendMessage(key: string, input: SendMessageRequest) {
      const request = structuredClone(input);
      object(request, [
        'member',
        'text',
        'taskRefs',
        'attachments',
        'messageId',
        'summary',
        'actionMode',
      ]);
      if (parseStandaloneSlashCommand(request.text)) return unsupported();
      const files = attachments(request.attachments, 'message');
      const taskRefs = refs(request.taskRefs);
      const receipt = await execute(
        key,
        {
          commandId: request.messageId ?? crypto.randomUUID(),
          operation: 'message.send',
          payload: {
            to: request.member,
            text: request.text,
            ...(request.messageId === undefined ? {} : { messageId: request.messageId }),
            ...(request.summary === undefined ? {} : { summary: request.summary }),
            ...(request.actionMode === undefined ? {} : { actionMode: request.actionMode }),
            ...(taskRefs === undefined ? {} : { taskRefs }),
          },
        },
        {
          purpose: { kind: 'message', member: request.member },
          ...(files.length ? { source: files } : {}),
        }
      );
      if (!receipt.messageId)
        throw new HostTeamOperationError('invalid-result', 'unknown', receipt.commandId);
      if (request.messageId !== undefined && receipt.messageId !== request.messageId)
        throw new HostTeamOperationError('invalid-result', 'unknown', receipt.commandId);
      return { deliveredToInbox: true, messageId: receipt.messageId };
    },
  };
}
