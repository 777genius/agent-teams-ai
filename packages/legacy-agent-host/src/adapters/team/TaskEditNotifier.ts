import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createTeamPolicy } from './ControllerAdapter.js';
import { TeamOwnerError } from '../../team/contracts.js';
import type { CommandReceipt } from '../../team/contracts.js';
import type { JsonValue } from '../../contracts.js';

/** The original task snapshot owns this inbox effect; recovery only publishes its retained bytes. */
export function prepareTaskEditNotification(
  root: string,
  teamName: string,
  receipt: CommandReceipt,
  actor: string,
  task: JsonValue,
  reviewFlowDefaultsDirectory: string
): void {
  if (receipt.command.operation !== 'task.update' || actor !== 'user') return;
  if (
    !task ||
    typeof task !== 'object' ||
    Array.isArray(task) ||
    typeof task.id !== 'string' ||
    !task.id ||
    typeof task.subject !== 'string'
  )
    throw new TeamOwnerError('hold');
  const config = JSON.parse(readFileSync(join(root, 'teams', teamName, 'config.json'), 'utf8')) as {
    members?: { name?: string; agentType?: string }[];
  };
  // Host writes this marker from canonical role authority. Descriptive roles,
  // conventional names and the controller's first-member fallback cannot select a lead.
  const leads = config.members?.filter((member) => member.agentType === 'team-lead') ?? [];
  if (leads.length !== 1 || typeof leads[0]!.name !== 'string') return;
  const lead = receipt.taskRecipients?.find((member) => member.name === leads[0]!.name);
  if (!lead?.delivery) return;
  const { subject, description } = receipt.command.payload;
  const changed = [
    subject === undefined ? undefined : 'title',
    description === undefined ? undefined : 'description',
  ].filter((part) => part !== undefined);
  const displayId = typeof task.displayId === 'string' ? task.displayId : task.id;
  createTeamPolicy(root, teamName, reviewFlowDefaultsDirectory).sendMessage('user', {
    member: lead.name,
    from: 'user',
    source: 'system_notification',
    messageId: receipt.effects.messageId,
    timestamp: receipt.createdAt,
    text: `Task #${displayId} has been updated by the user (changed: ${changed.join(', ')}). New title: "${subject ?? '(unchanged)'}".`,
    summary: `Task #${displayId} updated`,
    taskRefs: [{ taskId: task.id, displayId, teamName }],
  });
}
