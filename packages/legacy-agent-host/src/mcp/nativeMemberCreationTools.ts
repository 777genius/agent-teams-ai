import { nativeMemberCreationSchema } from '../team/nativeMemberCreationContracts.js';
import { defineTool } from './toolDefinition.js';
import type { TeamMcpNativeMemberCreationPort } from './nativeMemberCreationContracts.js';
import type { BoundTool } from './toolDefinition.js';

export function createNativeMemberCreationMcpTools(
  port: TeamMcpNativeMemberCreationPort
): BoundTool[] {
  return [
    {
      ...defineTool(
        'team_member_create',
        'Add one configured persistent teammate under your current lead DO authority. Send its work later using message_send. Repeating the command only returns the original receipt.',
        nativeMemberCreationSchema,
        (raw) => port.invoke('create', raw)
      ),
      asynchronous: true,
    },
    {
      ...defineTool(
        'team_member_create_lookup',
        'Look up the exact original member-creation receipt without retrying model inference or native allocation.',
        nativeMemberCreationSchema,
        (raw) => port.invoke('lookup', raw),
        false
      ),
      asynchronous: true,
    },
  ];
}
