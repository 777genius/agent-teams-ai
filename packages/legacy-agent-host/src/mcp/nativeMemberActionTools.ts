import { z } from 'zod';
import { defineTool } from './toolDefinition.js';
import type { TeamMcpNativeMemberActionPort } from './nativeMemberActionContracts.js';
import type { BoundTool } from './toolDefinition.js';

const id = z
  .string()
  .min(1)
  .max(256)
  .regex(/^\S(?:[\s\S]*\S)?$/);
const selected = { launchId: id, memberId: id };
const source = { ...selected, rosterRevision: z.string().regex(/^[a-f0-9]{64}$/) };
const action = z.strictObject({
  ...source,
  expectedGeneration: id.nullable(),
  action: z.enum(['restart', 'skip']),
});

/** Original lead/input authority is captured by the private port; public arguments select only the existing transition. */
export function createNativeMemberActionMcpTools(port: TeamMcpNativeMemberActionPort): BoundTool[] {
  return [
    ...(['prepare', 'execute'] as const).map((operation) => ({
      ...defineTool(
        `team_member_action_${operation}`,
        operation === 'prepare'
          ? 'Prepare one member restart or skip under your current lead DO authority.'
          : 'Execute the original prepared member action once; unknown outcomes never replay.',
        z.strictObject({ commandId: id, ...action.shape }),
        ({ commandId, ...raw }) => port.invoke(operation, commandId, raw)
      ),
      asynchronous: true as const,
    })),
    {
      ...defineTool(
        'team_member_actions_read',
        'Read the selected member transition history under your current authority.',
        z.strictObject({ commandId: id, ...selected }),
        ({ commandId, ...raw }) => port.invoke('read', commandId, raw),
        false
      ),
      asynchronous: true as const,
    },
    {
      ...defineTool(
        'team_member_action_lookup',
        'Look up the original transition command without replay.',
        z.strictObject({ commandId: id, ...selected, originalCommandId: id }),
        ({ commandId, ...raw }) => port.invoke('lookup', commandId, raw),
        false
      ),
      asynchronous: true as const,
    },
    {
      ...defineTool(
        'team_member_retry',
        'Retry the selected original technical allocation attempt; this never replaces the roster.',
        z.strictObject({ commandId: id, ...source, attemptId: id }),
        ({ commandId, ...raw }) => port.invoke('retry', commandId, raw)
      ),
      asynchronous: true as const,
    },
  ];
}
