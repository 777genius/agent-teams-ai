import type { FastMCP } from 'fastmcp';
import { z } from 'zod';

import { agentBlocks, getController } from '../controller';
import { assertConfiguredTeam } from '../utils/teamConfig';
import { jsonTextContent, taskWriteResult, slimTask } from '../utils/format';
import { taskRefSchema } from '../utils/schemas';
import {
  CANONICAL_TASK_UUID_PATTERN,
  createTaskWithOptionalIdempotency,
  resolveMessageTaskCommandId,
  resolveOptionalTaskCreateCommandId,
} from '../utils/taskCreationIdempotency';

/** stripAgentBlocks from canonical agentBlocks module — single source of truth for the tag format. */
const stripAgentBlocksFn = (text: string): string => agentBlocks.stripAgentBlocks(text);

const toolContextSchema = {
  teamName: z.string().min(1),
  claudeDir: z.string().min(1).optional(),
};

const ALWAYS_LOAD_META = {
  'anthropic/alwaysLoad': true,
} as const;

const relationshipTypeSchema = z.enum(['blocked-by', 'blocks', 'related']);
const inventoryTaskStatusSchema = z.enum(['pending', 'in_progress', 'completed']);
const reviewStateSchema = z.enum(['none', 'review', 'needsFix', 'approved']);
const inventoryKanbanColumnSchema = z.enum(['review', 'approved']);
const taskMutationActorSchema = z
  .string()
  .min(1)
  .describe('Your configured teammate name. Required for ownership and lifecycle enforcement.');
const DEFAULT_TASK_LIST_LIMIT = 50;
const MAX_TASK_LIST_LIMIT = 200;

function normalizeTaskListLimit(limit: number | undefined): number {
  if (limit == null) {
    return DEFAULT_TASK_LIST_LIMIT;
  }
  return Math.min(Math.max(1, Math.floor(limit)), MAX_TASK_LIST_LIMIT);
}

/** Allowed message source types for task_create_from_message provenance. Fail closed — only explicit user-originated sources. */
const USER_ORIGINATED_SOURCES = new Set(['user_sent']);

/**
 * Shared payload builder for task_create and task_create_from_message.
 *
 * Both tools MUST stay semantically aligned — any new field added to task_create
 * that also applies to message-derived tasks must be added here, not duplicated.
 * Do not turn this into a repo-wide abstraction; keep it local to MCP tools.
 */
function buildCreateTaskPayload(params: {
  subject: string;
  description?: string;
  owner?: string;
  createdBy?: string;
  from?: string;
  blockedBy?: string[];
  related?: string[];
  prompt?: string;
  descriptionTaskRefs?: z.infer<typeof taskRefSchema>[];
  promptTaskRefs?: z.infer<typeof taskRefSchema>[];
  startImmediately?: boolean;
  sourceMessageId?: string;
  sourceMessage?: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    subject: params.subject,
    ...(params.description ? { description: params.description } : {}),
    ...(params.owner ? { owner: params.owner } : {}),
    ...(params.createdBy ? { createdBy: params.createdBy } : {}),
    ...(!params.createdBy && params.from ? { from: params.from } : {}),
    ...(params.blockedBy?.length ? { 'blocked-by': params.blockedBy.join(',') } : {}),
    ...(params.related?.length ? { related: params.related.join(',') } : {}),
    ...(params.prompt ? { prompt: params.prompt } : {}),
    ...(params.descriptionTaskRefs?.length
      ? { descriptionTaskRefs: params.descriptionTaskRefs }
      : {}),
    ...(params.promptTaskRefs?.length ? { promptTaskRefs: params.promptTaskRefs } : {}),
    ...(params.startImmediately !== undefined ? { startImmediately: params.startImmediately } : {}),
    ...(params.sourceMessageId ? { sourceMessageId: params.sourceMessageId } : {}),
    ...(params.sourceMessage ? { sourceMessage: params.sourceMessage } : {}),
  };
}

export function registerTaskTools(server: Pick<FastMCP, 'addTool'>) {
  server.addTool({
    name: 'task_create',
    description:
      'Create a team task. Always provide a stable idempotencyKey (or commandId UUID) and reuse it only when retrying the exact same request after timeout or response loss. Use a new key for every distinct task intent.',
    parameters: z.object({
      ...toolContextSchema,
      subject: z.string().min(1),
      description: z.string().optional(),
      owner: z.string().optional(),
      createdBy: z.string().optional(),
      from: z.string().optional(),
      blockedBy: z.array(z.string().min(1)).optional(),
      related: z.array(z.string().min(1)).optional(),
      prompt: z.string().optional(),
      descriptionTaskRefs: z.array(taskRefSchema).optional(),
      promptTaskRefs: z.array(taskRefSchema).optional(),
      startImmediately: z.boolean().optional(),
      commandId: z
        .string()
        .regex(CANONICAL_TASK_UUID_PATTERN, 'Must be a canonical task UUID (version 1-5)')
        .optional()
        .describe('Stable UUID for retrying the same task creation request.'),
      idempotencyKey: z
        .string()
        .trim()
        .min(1)
        .max(256)
        .optional()
        .describe('Stable retry key. Opaque keys are deterministically mapped to a command UUID.'),
    }),
    execute: async ({
      teamName,
      claudeDir,
      subject,
      description,
      owner,
      createdBy,
      from,
      blockedBy,
      related,
      prompt,
      descriptionTaskRefs,
      promptTaskRefs,
      startImmediately,
      commandId,
      idempotencyKey,
    }) => {
      assertConfiguredTeam(teamName, claudeDir);
      const controller = getController(teamName, claudeDir);
      const { taskBoard } = controller;
      const payload = buildCreateTaskPayload({
        subject,
        description,
        owner,
        createdBy,
        from,
        blockedBy,
        related,
        prompt,
        descriptionTaskRefs,
        promptTaskRefs,
        startImmediately,
      });
      const resolvedCommandId = resolveOptionalTaskCreateCommandId({
        teamName,
        commandId,
        idempotencyKey,
      });
      return await Promise.resolve(
        jsonTextContent(
          createTaskWithOptionalIdempotency({
            taskBoard,
            teamName,
            operation: 'task.create',
            payload,
            commandId: resolvedCommandId,
          })
        )
      );
    },
  });

  /*
   * task_create_from_message — creates a task from an exact persisted user message.
   *
   * This is NOT a heuristic "current context" resolver. It requires an exact messageId
   * that points to a persisted row in sentMessages.json or an inbox file.
   * Must reject relay copies, non-user sources, and ambiguous matches.
   * Must not auto-generate subject or infer importState from attachments.
   */
  server.addTool({
    name: 'task_create_from_message',
    description:
      'Create a task from a persisted user message. Always provide a stable requestKey for this exact task intent and reuse the same messageId + requestKey only on retry. Use a different requestKey to create another legitimate task from the same message.',
    parameters: z.object({
      ...toolContextSchema,
      messageId: z.string().min(1),
      subject: z.string().min(1),
      description: z.string().optional(),
      owner: z.string().optional(),
      createdBy: z.string().optional(),
      blockedBy: z.array(z.string().min(1)).optional(),
      related: z.array(z.string().min(1)).optional(),
      prompt: z.string().optional(),
      descriptionTaskRefs: z.array(taskRefSchema).optional(),
      promptTaskRefs: z.array(taskRefSchema).optional(),
      startImmediately: z.boolean().optional(),
      requestKey: z
        .string()
        .trim()
        .min(1)
        .max(256)
        .optional()
        .describe(
          'Stable discriminator for this task intent within the exact messageId. Reuse it only when retrying the same task creation request.'
        ),
    }),
    execute: async ({
      teamName,
      claudeDir,
      messageId,
      subject,
      description,
      owner,
      createdBy,
      blockedBy,
      related,
      prompt,
      descriptionTaskRefs,
      promptTaskRefs,
      startImmediately,
      requestKey,
    }) => {
      assertConfiguredTeam(teamName, claudeDir);
      const controller = getController(teamName, claudeDir);
      const { taskBoard } = controller;

      // 1. Lookup message by exact messageId
      let message: Record<string, unknown>;
      try {
        ({ message } = controller.messages.lookupMessage(messageId));
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('Message not found:')) {
          throw new Error(
            `${error.message}. task_create_from_message only works with the explicit User MessageId shown in the relay prompt for a user_sent message. Do not use teammate inbox ids or guessed ids.`
          );
        }
        throw error;
      }

      // 2. Reject if message source is not user-originated
      const source = typeof message.source === 'string' ? message.source : '';
      if (!USER_ORIGINATED_SOURCES.has(source)) {
        throw new Error(
          `Message source "${source}" is not user-originated. task_create_from_message only accepts explicit user_sent messages from the relay prompt. For teammate, system, or cross-team messages, use task_create instead.`
        );
      }

      // 3. Reject relay copies explicitly
      if (typeof message.relayOfMessageId === 'string' && message.relayOfMessageId.trim()) {
        throw new Error(
          'Cannot create task from a relay copy. Use the original user_sent message and its explicit User MessageId from the relay prompt instead.'
        );
      }

      // 4. Build sanitized source snapshot
      const rawText = typeof message.text === 'string' ? message.text : '';
      const sanitizedText = stripAgentBlocksFn(rawText);

      const sourceMessage: Record<string, unknown> = {
        text: sanitizedText,
        from: typeof message.from === 'string' ? message.from : 'unknown',
        timestamp: typeof message.timestamp === 'string' ? message.timestamp : '',
        ...(source ? { source } : {}),
      };

      // Preserve attachment metadata — filePath included when available
      if (Array.isArray(message.attachments) && message.attachments.length > 0) {
        sourceMessage.attachments = (message.attachments as Record<string, unknown>[])
          .filter(
            (a) =>
              a &&
              typeof a === 'object' &&
              typeof a.id === 'string' &&
              typeof a.filename === 'string'
          )
          .map((a) => ({
            id: String(a.id),
            filename: String(a.filename),
            mimeType: typeof a.mimeType === 'string' ? a.mimeType : '',
            size: typeof a.size === 'number' ? a.size : 0,
            ...(typeof a.filePath === 'string' ? { filePath: a.filePath } : {}),
          }));
      }

      // 5. Forward into canonical create-task path
      const payload = buildCreateTaskPayload({
        subject,
        description,
        owner,
        createdBy,
        blockedBy,
        related,
        prompt,
        descriptionTaskRefs,
        promptTaskRefs,
        startImmediately,
        sourceMessageId: messageId,
        sourceMessage,
      });
      const commandId = resolveMessageTaskCommandId({ teamName, messageId, requestKey });
      return await Promise.resolve(
        jsonTextContent(
          createTaskWithOptionalIdempotency({
            taskBoard,
            teamName,
            operation: 'task.create_from_message',
            payload,
            commandId,
          })
        )
      );
    },
  });

  server.addTool({
    name: 'task_get',
    description:
      'Get a task by id. Response includes:\n' +
      '- sourceMessage.attachments: from original user message (filePath = absolute path to file on disk, use Read tool to view)\n' +
      '- attachments: files attached to the task (filePath = absolute path, use Read tool to view)\n' +
      '- comments[].attachments: files on comments (filePath = absolute path, use Read tool to view)',
    parameters: z.object({
      ...toolContextSchema,
      taskId: z.string().min(1),
    }),
    execute: async ({ teamName, claudeDir, taskId }) => {
      assertConfiguredTeam(teamName, claudeDir);
      return await Promise.resolve(
        jsonTextContent(getController(teamName, claudeDir).taskBoard.getTask(taskId))
      );
    },
  });

  server.addTool({
    name: 'task_get_comment',
    description:
      'Get a single task comment by id. Returns the comment object and minimal task context (id, displayId, subject, status, owner).',
    parameters: z.object({
      ...toolContextSchema,
      taskId: z.string().min(1),
      commentId: z.string().min(1),
    }),
    execute: async ({ teamName, claudeDir, taskId, commentId }) => {
      assertConfiguredTeam(teamName, claudeDir);
      return await Promise.resolve(
        jsonTextContent(
          getController(teamName, claudeDir).taskBoard.getTaskComment(taskId, commentId)
        )
      );
    },
  });

  server.addTool({
    name: 'task_list',
    description:
      'List compact active task inventory/search rows for a team. Deleted tasks are excluded. Use it to browse, filter, and drill into inventory, not as a primary working queue. Defaults to 50 rows and caps at 200 rows; use filters or a smaller limit to narrow results. Supports stable conjunctive filters for owner, active status, reviewState, review overlay column, and task relationships.',
    parameters: z.object({
      ...toolContextSchema,
      owner: z.string().min(1).optional(),
      status: inventoryTaskStatusSchema.optional(),
      reviewState: reviewStateSchema.optional(),
      kanbanColumn: inventoryKanbanColumnSchema.optional(),
      relatedTo: z.string().min(1).optional(),
      blockedBy: z.string().min(1).optional(),
      limit: z.number().int().positive().optional(),
    }),
    execute: async ({
      teamName,
      claudeDir,
      owner,
      status,
      reviewState,
      kanbanColumn,
      relatedTo,
      blockedBy,
      limit,
    }) => {
      assertConfiguredTeam(teamName, claudeDir);
      return await Promise.resolve(
        jsonTextContent(
          getController(teamName, claudeDir).taskBoard.listTaskInventory({
            ...(owner ? { owner } : {}),
            ...(status ? { status } : {}),
            ...(reviewState ? { reviewState } : {}),
            ...(kanbanColumn ? { kanbanColumn } : {}),
            ...(relatedTo ? { relatedTo } : {}),
            ...(blockedBy ? { blockedBy } : {}),
            limit: normalizeTaskListLimit(limit),
          })
        )
      );
    },
  });

  server.addTool({
    name: 'task_set_status',
    description:
      'Set task work status. Execution transitions require the current owner; lead override is limited to administrative transitions.',
    parameters: z.object({
      ...toolContextSchema,
      taskId: z.string().min(1),
      status: z.enum(['pending', 'in_progress', 'completed', 'deleted']),
      actor: taskMutationActorSchema,
    }),
    execute: async ({ teamName, claudeDir, taskId, status, actor }) => {
      assertConfiguredTeam(teamName, claudeDir);
      return await Promise.resolve(
        jsonTextContent(
          slimTask(
            getController(teamName, claudeDir).taskBoard.setTaskStatus(
              taskId,
              status,
              actor
            ) as Record<string, unknown>
          )
        )
      );
    },
  });

  server.addTool({
    name: 'task_restore',
    description:
      'Restore a deleted task back to pending work state as its current owner or the team lead',
    parameters: z.object({
      ...toolContextSchema,
      taskId: z.string().min(1),
      actor: taskMutationActorSchema,
    }),
    execute: async ({ teamName, claudeDir, taskId, actor }) => {
      assertConfiguredTeam(teamName, claudeDir);
      return await Promise.resolve(
        jsonTextContent(
          slimTask(
            getController(teamName, claudeDir).taskBoard.restoreTask(taskId, actor) as Record<
              string,
              unknown
            >
          )
        )
      );
    },
  });

  server.addTool({
    name: 'task_start',
    description: 'Mark task as in progress. Only the current owner may start it.',
    parameters: z.object({
      ...toolContextSchema,
      taskId: z.string().min(1),
      actor: taskMutationActorSchema,
    }),
    execute: async ({ teamName, claudeDir, taskId, actor }) => {
      assertConfiguredTeam(teamName, claudeDir);
      return await Promise.resolve(
        jsonTextContent(
          slimTask(
            getController(teamName, claudeDir).taskBoard.startTask(taskId, actor) as Record<
              string,
              unknown
            >
          )
        )
      );
    },
  });

  server.addTool({
    name: 'task_complete',
    description: 'Mark task as completed. Only the current owner may complete it.',
    parameters: z.object({
      ...toolContextSchema,
      taskId: z.string().min(1),
      actor: taskMutationActorSchema,
    }),
    execute: async ({ teamName, claudeDir, taskId, actor }) => {
      assertConfiguredTeam(teamName, claudeDir);
      return await Promise.resolve(
        jsonTextContent(
          slimTask(
            getController(teamName, claudeDir).taskBoard.completeTask(taskId, actor) as Record<
              string,
              unknown
            >
          )
        )
      );
    },
  });

  server.addTool({
    name: 'task_set_owner',
    description:
      'Assign, reassign, or clear task owner. Lead may reassign any task; current owner may hand off; other members may only self-claim an unassigned task.',
    parameters: z.object({
      ...toolContextSchema,
      taskId: z.string().min(1),
      owner: z.string().nullable(),
      actor: taskMutationActorSchema,
    }),
    execute: async ({ teamName, claudeDir, taskId, owner, actor }) => {
      assertConfiguredTeam(teamName, claudeDir);
      return await Promise.resolve(
        jsonTextContent(
          slimTask(
            getController(teamName, claudeDir).taskBoard.setTaskOwner(
              taskId,
              owner,
              actor
            ) as Record<string, unknown>
          )
        )
      );
    },
  });

  server.addTool({
    name: 'task_add_comment',
    description:
      'Add task comment. from is required and must be your configured teammate name; user/system are reserved for app-owned writes.',
    parameters: z.object({
      ...toolContextSchema,
      taskId: z.string().min(1),
      text: z.string().min(1),
      from: z.string().min(1),
      taskRefs: z.array(taskRefSchema).optional(),
    }),
    execute: async ({ teamName, claudeDir, taskId, text, from, taskRefs }) => {
      assertConfiguredTeam(teamName, claudeDir);
      return await Promise.resolve(
        jsonTextContent(
          taskWriteResult(
            getController(teamName, claudeDir).taskBoard.addTaskComment(taskId, {
              text,
              ...(from ? { from } : {}),
              ...(taskRefs?.length ? { taskRefs } : {}),
            }) as Record<string, unknown>
          )
        )
      );
    },
  });

  server.addTool({
    name: 'task_attach_file',
    description:
      'Attach a file to a task. Returns attachment metadata with filePath for future access via Read tool.',
    parameters: z.object({
      ...toolContextSchema,
      taskId: z.string().min(1),
      filePath: z.string().min(1),
      mode: z.enum(['copy', 'link']).optional(),
      filename: z.string().optional(),
      mimeType: z.string().optional(),
      noFallback: z.boolean().optional(),
    }),
    execute: async ({
      teamName,
      claudeDir,
      taskId,
      filePath,
      mode,
      filename,
      mimeType,
      noFallback,
    }) => {
      assertConfiguredTeam(teamName, claudeDir);
      return await Promise.resolve(
        jsonTextContent(
          taskWriteResult(
            getController(teamName, claudeDir).taskBoard.attachTaskFile(taskId, {
              file: filePath,
              ...(mode ? { mode } : {}),
              ...(filename ? { filename } : {}),
              ...(mimeType ? { 'mime-type': mimeType } : {}),
              ...(noFallback ? { 'no-fallback': true } : {}),
            }) as Record<string, unknown>
          )
        )
      );
    },
  });

  server.addTool({
    name: 'task_attach_comment_file',
    description:
      'Attach a file to a task comment. Returns attachment metadata with filePath for future access via Read tool.',
    parameters: z.object({
      ...toolContextSchema,
      taskId: z.string().min(1),
      commentId: z.string().min(1),
      filePath: z.string().min(1),
      mode: z.enum(['copy', 'link']).optional(),
      filename: z.string().optional(),
      mimeType: z.string().optional(),
      noFallback: z.boolean().optional(),
    }),
    execute: async ({
      teamName,
      claudeDir,
      taskId,
      commentId,
      filePath,
      mode,
      filename,
      mimeType,
      noFallback,
    }) => {
      assertConfiguredTeam(teamName, claudeDir);
      return await Promise.resolve(
        jsonTextContent(
          taskWriteResult(
            getController(teamName, claudeDir).taskBoard.attachCommentFile(taskId, commentId, {
              file: filePath,
              ...(mode ? { mode } : {}),
              ...(filename ? { filename } : {}),
              ...(mimeType ? { 'mime-type': mimeType } : {}),
              ...(noFallback ? { 'no-fallback': true } : {}),
            }) as Record<string, unknown>
          )
        )
      );
    },
  });

  server.addTool({
    name: 'task_set_clarification',
    description: 'Set or clear task clarification state',
    parameters: z.object({
      ...toolContextSchema,
      taskId: z.string().min(1),
      value: z.enum(['lead', 'user', 'clear']),
    }),
    execute: async ({ teamName, claudeDir, taskId, value }) => {
      assertConfiguredTeam(teamName, claudeDir);
      return await Promise.resolve(
        jsonTextContent(
          slimTask(
            getController(teamName, claudeDir).taskBoard.setNeedsClarification(
              taskId,
              value === 'clear' ? null : value
            ) as Record<string, unknown>
          )
        )
      );
    },
  });

  server.addTool({
    name: 'task_link',
    description: 'Link tasks by blockedBy, blocks, or related relationship',
    parameters: z.object({
      ...toolContextSchema,
      taskId: z.string().min(1),
      targetId: z.string().min(1),
      relationship: relationshipTypeSchema,
    }),
    execute: async ({ teamName, claudeDir, taskId, targetId, relationship }) => {
      assertConfiguredTeam(teamName, claudeDir);
      return await Promise.resolve(
        jsonTextContent(
          slimTask(
            getController(teamName, claudeDir).taskBoard.linkTask(
              taskId,
              targetId,
              relationship
            ) as Record<string, unknown>
          )
        )
      );
    },
  });

  server.addTool({
    name: 'task_unlink',
    description: 'Remove task relationship link',
    parameters: z.object({
      ...toolContextSchema,
      taskId: z.string().min(1),
      targetId: z.string().min(1),
      relationship: relationshipTypeSchema,
    }),
    execute: async ({ teamName, claudeDir, taskId, targetId, relationship }) => {
      assertConfiguredTeam(teamName, claudeDir);
      return await Promise.resolve(
        jsonTextContent(
          slimTask(
            getController(teamName, claudeDir).taskBoard.unlinkTask(
              taskId,
              targetId,
              relationship
            ) as Record<string, unknown>
          )
        )
      );
    },
  });

  server.addTool({
    name: 'member_briefing',
    description: 'Get bootstrap briefing for a team member',
    _meta: ALWAYS_LOAD_META,
    parameters: z.object({
      ...toolContextSchema,
      memberName: z.string().min(1),
      runtimeProvider: z.enum(['native', 'opencode', 'codex']).optional(),
      includeActiveProcesses: z.boolean().optional(),
    }),
    execute: async ({
      teamName,
      claudeDir,
      memberName,
      runtimeProvider,
      includeActiveProcesses,
    }) => {
      assertConfiguredTeam(teamName, claudeDir);
      return {
        content: [
          {
            type: 'text' as const,
            text: await getController(teamName, claudeDir).taskBoard.memberBriefing(memberName, {
              ...(runtimeProvider ? { runtimeProvider } : {}),
              ...(includeActiveProcesses !== undefined ? { includeActiveProcesses } : {}),
            }),
          },
        ],
      };
    },
  });

  server.addTool({
    name: 'task_briefing',
    description: 'Get formatted task briefing for a member',
    parameters: z.object({
      ...toolContextSchema,
      memberName: z.string().min(1),
    }),
    execute: async ({ teamName, claudeDir, memberName }) => {
      assertConfiguredTeam(teamName, claudeDir);
      return {
        content: [
          {
            type: 'text' as const,
            text: await getController(teamName, claudeDir).taskBoard.taskBriefing(memberName),
          },
        ],
      };
    },
  });
}
