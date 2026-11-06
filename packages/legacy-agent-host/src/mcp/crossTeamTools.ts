import { z } from 'zod';
import { defineTool } from './toolDefinition.js';
import type { BoundTool } from './toolDefinition.js';
import type { TeamMcpCrossTeamPort } from './nativeCrossTeamContracts.js';

const id = z.string().min(1).max(256).regex(/^\S(?:[\s\S]*\S)?$/);
const name = z.string().min(1).max(128);
const source = { teamName: name.optional(), fromMember: name.optional() };

/** Existing cross-Team tool names, bound to one authenticated source and Host catalog. */
export function createCrossTeamMcpTools(port: TeamMcpCrossTeamPort): BoundTool[] {
  return [
    { ...defineTool('cross_team_send',
      'Send to an opaque toTeam resourceRef returned by cross_team_list_targets. Source actor is captured. After uncertainty use cross_team_lookup with the original commandId.',
      z.strictObject({ ...source, commandId:id, toTeam:id, text:z.string().min(1).max(48_000),
        summary:z.string().max(4_000).optional(),conversationId:id.optional(),replyToConversationId:id.optional(),
        taskRefs:z.array(z.strictObject({taskId:id,displayId:id,teamName:name})).max(100).optional(),
        chainDepth:z.number().int().min(0).max(4).optional(),
      }), input => port.send(input)), asynchronous:true },
    defineTool('cross_team_list_targets', 'List captured Host resources eligible for cross-Team messaging. Use resourceRef as toTeam; display names never select authority.',
      z.strictObject({ teamName:name.optional(),excludeTeam:id.optional() }), input => port.listTargets(input), false),
    { ...defineTool('cross_team_get_outbox', 'Read original sent cross-Team history for this captured source.',
      z.strictObject({teamName:name.optional()}), input => port.getOutbox(input), false), asynchronous:true },
    defineTool('cross_team_lookup', 'Read the exact original source command and original target outcome. This never sends a replacement.',
      z.strictObject({commandId:id}), ({commandId}) => port.lookup(commandId), false),
  ];
}
