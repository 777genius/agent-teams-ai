import { createNativeMemberCreationMcpTools } from './nativeMemberCreationTools.js';
import { createNativeMemberActionMcpTools } from './nativeMemberActionTools.js';
import { createWorkSyncMcpTools } from './workSyncTools.js';
import { createReadMcpTools } from './readTools.js';
import { createProcessMcpTools } from './processTools.js';
import { defineTool as define, formatToolResult as result } from './toolDefinition.js';
import type { BoundTool } from './toolDefinition.js';
import { createCrossTeamMcpTools } from './crossTeamTools.js';
import { z } from 'zod';

import { McpToolFailure } from './contracts.js';

import type { TeamMcpConnection } from './contracts.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

const identifier = z
  .string()
  .min(1)
  .max(256)
  .regex(/^\S(?:[\s\S]*\S)?$/);
const name = z.string().min(1).max(128);
const text = z.string().min(1).max(48_000);
const descriptionText = z.string().max(48_000);
const taskRef = z.strictObject({ taskId: identifier, displayId: identifier, teamName: name });
const refs = z.array(taskRef).max(100).optional();
const command = { commandId: identifier };
const task = { taskId: identifier };
const action = z.enum(['start', 'complete', 'delete', 'restore', 'pending']);

/** Explicitly partial catalog: an absent group never routes to a legacy writer. */
export const TEAM_MCP_CATALOG_DISPOSITION = Object.freeze({
  team: 'partial-bound-read-create-list-pending-owner-ports',
  task: 'partial-create-update-assign-lifecycle-comment-clarification-relationships-get-list',
  lead: 'canonical-bound-operational-briefing',
  kanban: 'partial-bound-state-reviewers-repair-mutations-pending',
  review: 'request-start-approve-request-changes',
  message: 'partial-send-with-taskrefs',
  process: 'register-list-metadata-stop-unregister',
  runtime: 'pending-private-runtime-callback',
  workSync: 'pending-host-handler',
  crossTeam: 'captured-host-source-first-send-list-outbox-lookup',
} as const);

/** JSON wire objects omit absent optionals; the owner uses exact optional types. */
function present<T extends object>(value: T): { [K in keyof T]: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as {
    [K in keyof T]: Exclude<T[K], undefined>;
  };
}

/** Shared handlers use the injected owner connection. No controller or filesystem access. */
export function createTeamMcpTools(connection: TeamMcpConnection) {
  const tools: BoundTool[] = [
    define(
      'task_create',
      'Create a task as the authenticated member.',
      z.strictObject({
        ...command,
        subject: text,
        description: descriptionText.optional(),
        owner: name.optional(),
        blockedBy: z.array(identifier).max(100).optional(),
        related: z.array(identifier).max(100).optional(),
        prompt: text.optional(),
        promptTaskRefs: refs,
        startImmediately: z.boolean().optional(),
        descriptionTaskRefs: refs,
      }),
      ({ commandId, ...payload }) =>
        connection.execute({ commandId, operation: 'task.create', payload: present(payload) })
    ),
    define(
      'task_update',
      'Update task subject/description; authorization comes from the captured connection.',
      z.strictObject({
        ...command,
        ...task,
        subject: text.optional(),
        description: descriptionText.optional(),
      }),
      ({ commandId, ...payload }) =>
        connection.execute({ commandId, operation: 'task.update', payload: present(payload) })
    ),
    define(
      'task_set_owner',
      'Assign/reassign or explicitly clear Task ownership through canonical Team policy.',
      z.strictObject({ ...command, ...task, owner: name.nullable() }),
      ({ commandId, ...payload }) =>
        connection.execute({ commandId, operation: 'task.assign', payload })
    ),
    define(
      'task_lifecycle',
      'Start/complete/delete/restore/return a task to pending using canonical Team policy.',
      z.strictObject({ ...command, ...task, action }),
      ({ commandId, ...payload }) =>
        connection.execute({ commandId, operation: 'task.lifecycle', payload })
    ),
    define(
      'task_set_status',
      'Set work status. Owner/dependency policy is checked by Team.',
      z.strictObject({
        ...command,
        ...task,
        status: z.enum(['pending', 'in_progress', 'completed', 'deleted']),
      }),
      ({ commandId, taskId, status }) =>
        connection.execute({
          commandId,
          operation: 'task.lifecycle',
          payload: {
            taskId,
            action: (
              {
                pending: 'pending',
                in_progress: 'start',
                completed: 'complete',
                deleted: 'delete',
              } as const
            )[status],
          },
        })
    ),
    define(
      'task_add_comment',
      'Add one comment as the authenticated member; TaskRefs are data, not authority.',
      z.strictObject({ ...command, ...task, text, taskRefs: refs }),
      ({ commandId, ...payload }) =>
        connection.execute({ commandId, operation: 'task.comment', payload: present(payload) })
    ),
    define(
      'task_set_clarification',
      'Set or explicitly clear durable task clarification through Team policy.',
      z.strictObject({ ...command, ...task, value: z.enum(['lead', 'user', 'clear']) }),
      ({ commandId, taskId, value }) =>
        connection.execute({
          commandId,
          operation: 'task.clarification',
          payload: { taskId, value: value === 'clear' ? null : value },
        })
    ),
    ...(['add', 'remove'] as const).map((action) =>
      define(
        action === 'add' ? 'task_link' : 'task_unlink',
        'Change reciprocal task relationships using canonical dependency and cycle policy.',
        z.strictObject({
          ...command,
          ...task,
          targetId: identifier,
          relationship: z.enum(['blocked-by', 'blocks', 'related']),
        }),
        ({ commandId, taskId, targetId, relationship }) =>
          connection.execute({
            commandId,
            operation: 'task.relationship',
            payload: {
              taskId,
              targetId,
              type: relationship === 'blocked-by' ? 'blockedBy' : relationship,
              action,
            },
          })
      )
    ),
    define(
      'review_request',
      'Request canonical review of completed work as the captured actor.',
      z.strictObject({ ...command, ...task, reviewer: name.optional() }),
      ({ commandId, ...payload }) =>
        connection.execute({
          commandId,
          operation: 'task.review',
          payload: { ...present(payload), action: 'request' },
        })
    ),
    define(
      'review_start',
      'Begin review as the captured reviewer; assigned-reviewer policy applies.',
      z.strictObject({ ...command, ...task }),
      ({ commandId, ...payload }) =>
        connection.execute({
          commandId,
          operation: 'task.review',
          payload: { ...payload, action: 'start' },
        })
    ),
    define(
      'review_approve',
      'Approve completed work in its current review cycle.',
      z.strictObject({
        ...command,
        ...task,
        note: text.optional(),
        notifyOwner: z.boolean().optional(),
        suppressTaskComment: z.boolean().optional(),
      }),
      ({ commandId, ...payload }) =>
        connection.execute({
          commandId,
          operation: 'task.review',
          payload: { ...present(payload), action: 'approve' },
        })
    ),
    define(
      'review_request_changes',
      'Return reviewed work to pending with a fix request and TaskRefs.',
      z.strictObject({ ...command, ...task, comment: text, taskRefs: refs }),
      ({ commandId, ...payload }) =>
        connection.execute({
          commandId,
          operation: 'task.review',
          payload: { ...present(payload), action: 'request_changes' },
        })
    ),
    define(
      'task_get',
      'Read an existing task from this captured Team owner.',
      z.strictObject(task),
      ({ taskId }) => connection.getTask(taskId),
      false
    ),
    define(
      'task_list',
      'Read active task inventory (default 50, maximum 200).',
      z.strictObject({
        owner: name.optional(),
        status: z.enum(['pending', 'in_progress', 'completed']).optional(),
        limit: z.number().int().min(1).max(200).optional(),
      }),
      ({ owner, status, limit }) =>
        connection
          .listTasks()
          .filter(
            (item) =>
              item.status !== 'deleted' &&
              (owner === undefined || item.owner === owner) &&
              (status === undefined || item.status === status)
          )
          .slice(0, limit ?? 50),
      false
    ),
    define(
      'message_send',
      'Persist a visible message and delivery intent as the authenticated member. Business completion does not imply native delivery.',
      z.strictObject({ ...command, to: name, text, taskRefs: refs }),
      ({ commandId, ...payload }) =>
        connection.execute({ commandId, operation: 'message.send', payload: present(payload) })
    ),
    define(
      'command_lookup',
      'Read the original command receipt under current grants; missing is null, not success.',
      z.strictObject(command),
      ({ commandId }) => connection.lookup(commandId),
      false
    ),
  ];
  for (const fixed of ['start', 'complete', 'restore', 'delete'] as const) {
    tools.push(
      define(
        `task_${fixed}`,
        `Task ${fixed} with the current actor and canonical Team guards.`,
        z.strictObject({ ...command, ...task }),
        ({ commandId, taskId }) =>
          connection.execute({
            commandId,
            operation: 'task.lifecycle',
            payload: { taskId, action: fixed },
          })
      )
    );
  }
  // Native TaskGet/TaskList have a different namespace/result/filtering contract.
  // Do not present product task inventory as an equivalent native-tool alias.
  if (connection.crossTeam) tools.push(...createCrossTeamMcpTools(connection.crossTeam));
  if (connection.process) tools.push(...createProcessMcpTools(connection.process));
  if (connection.nativeMemberCreation) tools.push(...createNativeMemberCreationMcpTools(connection.nativeMemberCreation));
  if (connection.nativeMemberActions)
    tools.push(...createNativeMemberActionMcpTools(connection.nativeMemberActions));
  if (connection.workSync) tools.push(...createWorkSyncMcpTools(connection.workSync));
  if (connection.readQueries) {
    const inventory = tools.findIndex((tool) => tool.definition.name === 'task_list');
    tools.splice(inventory, 1);
    tools.push(...createReadMcpTools(connection.readQueries));
  }
  const byName = new Map(tools.map((tool) => [tool.definition.name, tool]));
  return Object.freeze({
    list: () => tools.map((tool) => structuredClone(tool.definition)),
    call: (toolName: string, args: unknown): CallToolResult => {
      const tool = byName.get(toolName);
      if (!tool || tool.asynchronous) throw new McpToolFailure('unsupported');
      return result(tool.invoke(args), tool.mutation);
    },
    callAsync: async (toolName: string, args: unknown): Promise<CallToolResult> => {
      const tool = byName.get(toolName);
      if (!tool) throw new McpToolFailure('unsupported');
      return result(await tool.invoke(args), tool.mutation);
    },
  });
}
