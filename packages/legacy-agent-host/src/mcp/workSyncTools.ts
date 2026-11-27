import { z } from 'zod';

import { defineTool } from './toolDefinition.js';

import type { TeamMcpWorkSyncPort } from './workSyncContracts.js';
import type { BoundTool } from './toolDefinition.js';

const commandId = z
  .string()
  .min(1)
  .max(256)
  .regex(/^\S(?:[\s\S]*\S)?$/);

/** No actor, filesystem root, Team selector or control URL is admitted at this boundary. */
export function createWorkSyncMcpTools(port: TeamMcpWorkSyncPort): BoundTool[] {
  return [
    {
      ...defineTool(
        'member_work_sync_status',
        'Read and reconcile your current actionable-work agenda. Follow nextRequiredToolCall before going idle.',
        z.strictObject({ commandId, forceNudge: z.boolean().optional() }),
        ({ commandId, forceNudge }) =>
          port.status(commandId, forceNudge === undefined ? {} : { forceNudge })
      ),
      asynchronous: true,
    },
    {
      ...defineTool(
        'member_work_sync_report',
        'Report your work-sync state for the original agenda/token. This does not complete or approve Tasks.',
        z.strictObject({
          commandId,
          state: z.enum(['still_working', 'blocked', 'caught_up']),
          agendaFingerprint: z.string().min(1).max(256),
          reportToken: z.string().min(1).max(4096),
          taskIds: z.array(z.string().min(1).max(256)).max(200).optional(),
          note: z.string().max(4000).optional(),
          leaseTtlMs: z.number().int().min(60_000).max(3_600_000).optional(),
          wait: z.strictObject({
            kind: z.literal('ci'), repository: z.string().max(256).regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
            runId: z.string().regex(/^[0-9]{1,24}$/), expectedCommit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
            taskId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/).optional(),
            horizonAt: z.string().max(64).refine(value => Number.isFinite(Date.parse(value))),
            status: z.enum(['pending', 'succeeded', 'failed', 'cancelled']),
          }).optional(),
        }),
        ({ commandId, ...input }) =>
          port.report(commandId, {
            state: input.state,
            agendaFingerprint: input.agendaFingerprint,
            reportToken: input.reportToken,
            ...(input.taskIds ? { taskIds: input.taskIds } : {}),
            ...(input.note !== undefined ? { note: input.note } : {}),
            ...(input.leaseTtlMs !== undefined ? { leaseTtlMs: input.leaseTtlMs } : {}),
            ...(input.wait !== undefined ? { wait: input.wait } : {}),
          })
      ),
      asynchronous: true,
    },
  ];
}
