import { z } from 'zod';
import { defineTool } from './toolDefinition.js';
import type { BoundTool } from './toolDefinition.js';
import type { TeamMcpConnection } from './contracts.js';

/** No start/control/authority argument is exposed to the model. */
export function createGoalMcpTools(goals: NonNullable<TeamMcpConnection['goals']>): BoundTool[] {
  return [
    defineTool('goal_status', 'Read the accepted objective, limits and current completion state. Reading never starts work.',
      z.strictObject({}), () => goals.status(), false),
    { ...defineTool('goal_propose', 'Lead only: propose the verified final result for the accepted objective. Returns before this turn ends. Finish the turn; Host accepts and publishes once all required inputs settle and current work remains complete. Do not separately send a duplicate final answer.',
      z.strictObject({ commandId: z.string().min(1).max(256), result: z.string().min(1).max(48000),
        evidence: z.string().max(8192).optional() }),
      input => goals.propose({ commandId: input.commandId, result: input.result,
        ...(input.evidence === undefined ? {} : { evidence: input.evidence }) })), asynchronous: true },
  ];
}
