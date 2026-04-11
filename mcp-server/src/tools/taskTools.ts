import type { FastMCP } from 'fastmcp';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

import { agentBlocks, getController } from '../controller';
import { jsonTextContent, taskWriteResult, slimTask, slimTaskForList } from '../utils/format';

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
    ...(params.startImmediately !== undefined ? { startImmediately: params.startImmediately } : {}),
    ...(params.sourceMessageId ? { sourceMessageId: params.sourceMessageId } : {}),
    ...(params.sourceMessage ? { sourceMessage: params.sourceMessage } : {}),
  };
}

function resolveConfigPath(teamName: string, claudeDir?: string): string {
  const controller = getController(teamName, claudeDir) as {
    context?: { paths?: { teamDir?: string } };
  };
  const teamDir = controller.context?.paths?.teamDir;
  if (typeof teamDir !== 'string' || teamDir.trim().length === 0) {
    throw new Error(
      `Unknown team "${teamName}". Board tools require an existing configured team with config.json. Use the real board teamName from durable team context - never use a member or lead name as teamName.`
    );
  }
  return path.join(teamDir, 'config.json');
}

function assertConfiguredTeam(teamName: string, claudeDir?: string): void {
  const configPath = resolveConfigPath(teamName, claudeDir);
  let raw = '';
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch {
    throw new Error(
      `Unknown team "${teamName}". Board tools require an existing configured team with config.json. Use the real board teamName from durable team context - never use a member or lead name as teamName.`
    );
  }

  try {
    const parsed = JSON.parse(raw) as { name?: unknown };
    if (typeof parsed?.name !== 'string' || parsed.name.trim().length === 0) {
      throw new Error('invalid');
    }
  } catch {
    throw new Error(
      `Unknown team "${teamName}". Board tools require an existing configured team with config.json. Use the real board teamName from durable team context - never use a member or lead name as teamName.`
    );
  }
}

export function registerTaskTools(server: Pick<FastMCP, 'addTool'>) {
  server.addTool({
    name: 'task_create',
    description: 'Create a team task',
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
      startImmediately: z.boolean().optional(),
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
      startImmediately,
    }) => {
      assertConfiguredTeam(teamName, claudeDir);
      const controller = getController(teamName, claudeDir);
      return await Promise.resolve(
        jsonTextContent(
          controller.tasks.createTask(
            buildCreateTaskPayload({
              subject,
              description,
              owner,
              createdBy,
              from,
              blockedBy,
              related,
              prompt,
              startImmediately,
            })
          )
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
      'Create a task from a persisted user message. Resolves the message by exact messageId, builds sanitized provenance, and creates the task through the canonical path.',
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
      startImmediately: z.boolean().optional(),
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
      startImmediately,
    }) => {
      assertConfiguredTeam(teamName, claudeDir);
      const controller = getController(teamName, claudeDir);

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
      return await Promise.resolve(
        jsonTextContent(
          controller.tasks.createTask(
            buildCreateTaskPayload({
              subject,
              description,
              owner,
              createdBy,
              blockedBy,
              related,
              prompt,
              startImmediately,
              sourceMessageId: messageId,
              sourceMessage,
            })
          )
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
    execute: async ({ teamName, claudeDir, taskId }) =>
      await Promise.resolve(jsonTextContent(getController(teamName, claudeDir).tasks.getTask(taskId))),
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
    execute: async ({ teamName, claudeDir, taskId, commentId }) =>
      await Promise.resolve(
        jsonTextContent(
          getController(teamName, claudeDir).tasks.getTaskComment(taskId, commentId)
        )
      ),
  });

  server.addTool({
    name: 'task_list',
    description: 'List tasks for a team',
    parameters: z.object({
      ...toolContextSchema,
    }),
    execute: async ({ teamName, claudeDir }) =>
      await Promise.resolve(
        jsonTextContent(
          (getController(teamName, claudeDir).tasks.listTasks() as Record<string, unknown>[]).map(slimTaskForList)
        )
      ),
  });

  server.addTool({
    name: 'task_set_status',
    description: 'Set task work status',
    parameters: z.object({
      ...toolContextSchema,
      taskId: z.string().min(1),
      status: z.enum(['pending', 'in_progress', 'completed', 'deleted']),
      actor: z.string().optional(),
    }),
    execute: async ({ teamName, claudeDir, taskId, status, actor }) =>
      await Promise.resolve(
        jsonTextContent(slimTask(getController(teamName, claudeDir).tasks.setTaskStatus(taskId, status, actor) as Record<string, unknown>))
      ),
  });

  server.addTool({
    name: 'task_start',
    description: 'Mark task as in progress',
    parameters: z.object({
      ...toolContextSchema,
      taskId: z.string().min(1),
      actor: z.string().optional(),
    }),
    execute: async ({ teamName, claudeDir, taskId, actor }) =>
      await Promise.resolve(jsonTextContent(slimTask(getController(teamName, claudeDir).tasks.startTask(taskId, actor) as Record<string, unknown>))),
  });

  server.addTool({
    name: 'task_complete',
    description: 'Mark task as completed',
    parameters: z.object({
      ...toolContextSchema,
      taskId: z.string().min(1),
      actor: z.string().optional(),
    }),
    execute: async ({ teamName, claudeDir, taskId, actor }) =>
      await Promise.resolve(
        jsonTextContent(slimTask(getController(teamName, claudeDir).tasks.completeTask(taskId, actor) as Record<string, unknown>))
      ),
  });

  server.addTool({
    name: 'task_set_owner',
    description: 'Assign or clear task owner',
    parameters: z.object({
      ...toolContextSchema,
      taskId: z.string().min(1),
      owner: z.string().nullable(),
    }),
    execute: async ({ teamName, claudeDir, taskId, owner }) =>
      await Promise.resolve(
        jsonTextContent(slimTask(getController(teamName, claudeDir).tasks.setTaskOwner(taskId, owner) as Record<string, unknown>))
      ),
  });

  server.addTool({
    name: 'task_add_comment',
    description: 'Add task comment',
    parameters: z.object({
      ...toolContextSchema,
      taskId: z.string().min(1),
      text: z.string().min(1),
      from: z.string().optional(),
    }),
    execute: async ({ teamName, claudeDir, taskId, text, from }) =>
      await Promise.resolve(
        jsonTextContent(
          taskWriteResult(
            getController(teamName, claudeDir).tasks.addTaskComment(taskId, {
            text,
            ...(from ? { from } : {}),
            }) as Record<string, unknown>
          )
        )
      ),
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
    }) =>
      await Promise.resolve(
        jsonTextContent(
          taskWriteResult(
            getController(teamName, claudeDir).tasks.attachTaskFile(taskId, {
            file: filePath,
            ...(mode ? { mode } : {}),
            ...(filename ? { filename } : {}),
            ...(mimeType ? { 'mime-type': mimeType } : {}),
            ...(noFallback ? { 'no-fallback': true } : {}),
            }) as Record<string, unknown>
          )
        )
      ),
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
    }) =>
      await Promise.resolve(
        jsonTextContent(
          taskWriteResult(
            getController(teamName, claudeDir).tasks.attachCommentFile(taskId, commentId, {
            file: filePath,
            ...(mode ? { mode } : {}),
            ...(filename ? { filename } : {}),
            ...(mimeType ? { 'mime-type': mimeType } : {}),
            ...(noFallback ? { 'no-fallback': true } : {}),
            }) as Record<string, unknown>
          )
        )
      ),
  });

  server.addTool({
    name: 'task_set_clarification',
    description: 'Set or clear task clarification state',
    parameters: z.object({
      ...toolContextSchema,
      taskId: z.string().min(1),
      value: z.enum(['lead', 'user', 'clear']),
    }),
    execute: async ({ teamName, claudeDir, taskId, value }) =>
      await Promise.resolve(
        jsonTextContent(
          slimTask(
            getController(teamName, claudeDir).tasks.setNeedsClarification(
            taskId,
            value === 'clear' ? null : value
            ) as Record<string, unknown>
          )
        )
      ),
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
    execute: async ({ teamName, claudeDir, taskId, targetId, relationship }) =>
      await Promise.resolve(
        jsonTextContent(slimTask(getController(teamName, claudeDir).tasks.linkTask(taskId, targetId, relationship) as Record<string, unknown>))
      ),
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
    execute: async ({ teamName, claudeDir, taskId, targetId, relationship }) =>
      await Promise.resolve(
        jsonTextContent(
          slimTask(getController(teamName, claudeDir).tasks.unlinkTask(taskId, targetId, relationship) as Record<string, unknown>)
        )
      ),
  });

  server.addTool({
    name: 'member_briefing',
    description: 'Get bootstrap briefing for a team member',
    _meta: ALWAYS_LOAD_META,
    parameters: z.object({
      ...toolContextSchema,
      memberName: z.string().min(1),
    }),
    execute: async ({ teamName, claudeDir, memberName }) => ({
      content: [
        {
          type: 'text' as const,
          text: await getController(teamName, claudeDir).tasks.memberBriefing(memberName),
        },
      ],
    }),
  });

  server.addTool({
    name: 'task_briefing',
    description: 'Get formatted task briefing for a member',
    parameters: z.object({
      ...toolContextSchema,
      memberName: z.string().min(1),
    }),
    execute: async ({ teamName, claudeDir, memberName }) => ({
      content: [
        {
          type: 'text' as const,
          text: await getController(teamName, claudeDir).tasks.taskBriefing(memberName),
        },
      ],
    }),
  });
}
