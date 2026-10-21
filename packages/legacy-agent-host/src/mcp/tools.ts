import { z } from 'zod';

import { McpToolFailure } from './contracts.js';

import type { TeamMcpConnection } from './contracts.js';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';

const identifier = z.string().min(1).max(256).regex(/^\S(?:[\s\S]*\S)?$/);
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
  team: 'pending-host-handler',
  task: 'partial-create-update-assign-lifecycle-comment-get-list',
  lead: 'pending-host-handler',
  kanban: 'pending-host-handler',
  review: 'pending-host-handler',
  message: 'partial-send-with-taskrefs',
  process: 'pending-host-handler',
  runtime: 'pending-private-runtime-callback',
  workSync: 'pending-host-handler',
  crossTeam: 'pending-host-handler',
} as const);

interface BoundTool {
  definition: Tool;
  invoke(args: unknown): unknown;
  mutation: boolean;
}

/** JSON wire objects omit absent optionals; the owner uses exact optional types. */
function present<T extends object>(value: T): { [K in keyof T]: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as {
    [K in keyof T]: Exclude<T[K], undefined>;
  };
}

function define<S extends z.ZodType>(
  toolName: string, description: string, schema: S,
  invoke: (args: z.output<S>) => unknown, mutation = true,
): BoundTool {
  return {
    definition: {
      name: toolName,
      description: description + (mutation
        ? ' Supply a stable commandId before first dispatch. Reuse it only for the same intent and payload after a lost response; changed payload conflicts.'
        : ''),
      inputSchema: z.toJSONSchema(schema) as Tool['inputSchema'],
      annotations: { readOnlyHint: !mutation, destructiveHint: mutation },
    },
    mutation,
    invoke: (args) => {
      const parsed = schema.safeParse(args);
      if (!parsed.success) throw new McpToolFailure('invalid');
      return invoke(parsed.data);
    },
  };
}

function result(value: unknown, mutation: boolean): CallToolResult {
  const serialized = JSON.stringify(value ?? null);
  if (Buffer.byteLength(serialized, 'utf8') > 256 * 1024)
    throw new McpToolFailure('output-limit');
  const phase = value && typeof value === 'object' && 'phase' in value ? value.phase : undefined;
  return {
    content: [{ type: 'text', text: serialized }],
    structuredContent: { result: value ?? null },
    ...(mutation && (phase === 'rejected' || phase === 'held') ? { isError: true } : {}),
  };
}

/** Shared handlers use the injected owner connection. No controller or filesystem access. */
export function createTeamMcpTools(connection: TeamMcpConnection) {
  const tools: BoundTool[] = [
    define('task_create', 'Create a task as the authenticated member.', z.strictObject({
      ...command, subject: text, description: descriptionText.optional(), owner: name.optional(),
      blockedBy: z.array(identifier).max(100).optional(), descriptionTaskRefs: refs,
    }), ({ commandId, ...payload }) => connection.execute({ commandId, operation: 'task.create', payload: present(payload) })),
    define('task_update', 'Update task subject/description; authorization comes from the captured connection.',
      z.strictObject({ ...command, ...task, subject: text.optional(), description: descriptionText.optional() }),
      ({ commandId, ...payload }) => connection.execute({ commandId, operation: 'task.update', payload: present(payload) })),
    define('task_set_owner', 'Assign/reassign a task. Clearing ownership is not implemented in this slice.',
      z.strictObject({ ...command, ...task, owner: name }),
      ({ commandId, ...payload }) => connection.execute({ commandId, operation: 'task.assign', payload })),
    define('task_lifecycle', 'Start/complete/delete/restore/return a task to pending using canonical Team policy.',
      z.strictObject({ ...command, ...task, action }),
      ({ commandId, ...payload }) => connection.execute({ commandId, operation: 'task.lifecycle', payload })),
    define('task_set_status', 'Set work status. Owner/dependency policy is checked by Team.',
      z.strictObject({ ...command, ...task, status: z.enum(['pending', 'in_progress', 'completed', 'deleted']) }),
      ({ commandId, taskId, status }) => connection.execute({ commandId, operation: 'task.lifecycle',
        payload: { taskId, action: ({ pending: 'pending', in_progress: 'start', completed: 'complete', deleted: 'delete' } as const)[status] } })),
    define('task_add_comment', 'Add one comment as the authenticated member; TaskRefs are data, not authority.',
      z.strictObject({ ...command, ...task, text, taskRefs: refs }),
      ({ commandId, ...payload }) => connection.execute({ commandId, operation: 'task.comment', payload: present(payload) })),
    define('task_get', 'Read an existing task from this captured Team owner.', z.strictObject(task),
      ({ taskId }) => connection.getTask(taskId), false),
    define('task_list', 'Read active task inventory (default 50, maximum 200).', z.strictObject({
      owner: name.optional(), status: z.enum(['pending', 'in_progress', 'completed']).optional(),
      limit: z.number().int().min(1).max(200).optional(),
    }), ({ owner, status, limit }) => connection.listTasks().filter((item) => item.status !== 'deleted' &&
      (owner === undefined || item.owner === owner) && (status === undefined || item.status === status))
      .slice(0, limit ?? 50), false),
    define('message_send', 'Persist a visible message and delivery intent as the authenticated member. Business completion does not imply native delivery.',
      z.strictObject({ ...command, to: name, text, taskRefs: refs }),
      ({ commandId, ...payload }) => connection.execute({ commandId, operation: 'message.send', payload: present(payload) })),
    define('command_lookup', 'Read the original command receipt under current grants; missing is null, not success.',
      z.strictObject(command), ({ commandId }) => connection.lookup(commandId), false),
  ];
  for (const fixed of ['start', 'complete', 'restore', 'delete'] as const) {
    tools.push(define(`task_${fixed}`, `Task ${fixed} with the current actor and canonical Team guards.`,
      z.strictObject({ ...command, ...task }), ({ commandId, taskId }) => connection.execute({
        commandId, operation: 'task.lifecycle', payload: { taskId, action: fixed },
      })));
  }
  // Native TaskGet/TaskList have a different namespace/result/filtering contract.
  // Do not present product task inventory as an equivalent native-tool alias.
  const byName = new Map(tools.map((tool) => [tool.definition.name, tool]));
  return Object.freeze({
    list: () => tools.map((tool) => structuredClone(tool.definition)),
    call: (toolName: string, args: unknown): CallToolResult => {
      const tool = byName.get(toolName);
      if (!tool) throw new McpToolFailure('unsupported');
      return result(tool.invoke(args), tool.mutation);
    },
  });
}
