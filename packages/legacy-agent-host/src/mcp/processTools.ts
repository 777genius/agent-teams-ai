import { z } from 'zod';
import { projectProcessReceipt } from '../process/projectProcessViews.js';
import { McpToolFailure } from './contracts.js';
import { defineTool as define } from './toolDefinition.js';
import type { TeamMcpConnection } from './contracts.js';
import type { BoundTool } from './toolDefinition.js';

/** Metadata-only member catalog. Native stop is an explicit operator capability. */
export function createProcessMcpTools(
  process: NonNullable<TeamMcpConnection['process']>
): BoundTool[] {
  const identifier = z
    .string()
    .min(1)
    .max(256)
    .regex(/^\S(?:[\s\S]*\S)?$/);
  const command = { commandId: identifier };
  const pid = z.number().int().min(2).max(0x7fffffff);
  const selector = z.union([z.strictObject({ id: identifier }), z.strictObject({ pid })]);
  const present = <T extends object>(value: T): { [K in keyof T]: Exclude<T[K], undefined> } =>
    Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined)) as {
      [K in keyof T]: Exclude<T[K], undefined>;
    };
  return [
    define(
      'process_register',
      'Register a service from this exact captured native member session. Registration is metadata; OS custody requires original qualified lineage.',
      z.strictObject({
        ...command,
        pid,
        label: z.string().min(1).max(1024),
        port: z.number().int().min(1).max(65535).optional(),
        url: z.string().max(4096).optional(),
        command: z.string().max(4096).optional(),
      }),
      ({ commandId, ...payload }) =>
        projectProcessReceipt(process.register(commandId, present(payload)))
    ),
    define(
      'process_list',
      'Read registered services and stopped history; native observations never prove teammate readiness.',
      z.strictObject({}),
      () => process.list(),
      false
    ),
    ...(['stop', 'unregister'] as const).map((operation) =>
      define(
        `process_${operation}`,
        operation === 'stop'
          ? 'Mark existing process metadata stopped by ID or PID. This never sends an OS signal.'
          : 'Remove registry metadata only; PID removes its complete registered history. This never sends an OS signal.',
        z.strictObject({ ...command, id: identifier.optional(), pid: pid.optional() }),
        ({ commandId, id, pid }) => {
          const selected = selector.safeParse(present({ id, pid }));
          if (!selected.success) throw new McpToolFailure('invalid');
          return projectProcessReceipt(
            process.metadata(
              commandId,
              operation === 'stop' ? 'metadata-stop' : 'unregister',
              selected.data
            )
          );
        }
      )
    ),
    define(
      'process_lookup',
      'Look up the original process command under current authority; no native replay.',
      z.strictObject(command),
      ({ commandId }) => projectProcessReceipt(process.lookup(commandId)),
      false
    ),
  ];
}
