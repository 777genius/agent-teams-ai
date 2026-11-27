import { validateTeamCommand } from './validateTeamCommand.js';
import { lookupOwnedProductCommand } from './commandEntries.js';
import { digest } from './identity.js';
import { TeamOwnerError } from './contracts.js';
import { requiresHumanTaskActor } from './taskStartIntent.js';
import { teamCommandFingerprint } from './teamCommandFingerprint.js';
import { captureCommandSelection } from './captureCommandSelection.js';
import { validateCommandAttachments } from './validateCommandAttachments.js';
import type { TeamBinding, TeamCommand, TeamGrant, TeamMember } from './contracts.js';
import type { TeamPolicyPort, TeamStore } from './ports.js';

/** Original product lookup, shared by recovery and native calls; no execution or recapture. */
export function lookupTeamCommand(options: {
  store: TeamStore; binding: TeamBinding; policy: TeamPolicyPort; members(): TeamMember[];
  authorize(permission: TeamGrant['permissions'][number]): TeamGrant;
}, principalId: string, commandId: string, expected?: TeamCommand) {
  if (expected) validateTeamCommand(expected);
  return options.store.fenced(() => {
    options.authorize('read');
    const receipt = lookupOwnedProductCommand(options.store, principalId, commandId);
    if (receipt && digest(receipt.binding) !== digest(options.binding)) throw new TeamOwnerError('hold');
    if (!expected || !receipt) return receipt;
    const grant = options.authorize(expected.operation === 'message.send' ? 'message.write' : 'task.write');
    if (requiresHumanTaskActor(expected) && grant.memberName !== 'user') throw new TeamOwnerError('forbidden');
    if (expected.commandId !== commandId || digest(receipt.command) !== digest(expected)) throw new TeamOwnerError('conflict');
    if (teamCommandFingerprint(receipt) !== receipt.fingerprint) throw new TeamOwnerError('hold');
    const selected = captureCommandSelection(expected, receipt, options.members(), grant);
    if (teamCommandFingerprint({ binding: options.binding, principalId, command: expected,
      deliveryBinding: selected.deliveryBinding, taskRecipients: selected.taskRecipients,
      messageRecipientRole: selected.messageRecipientRole, taskStartLeadName: selected.taskStartLeadName,
      ...(receipt.hostCommand ? { hostCommand: receipt.hostCommand } : {}),
      ...(receipt.workSyncNudge ? { workSyncNudge: receipt.workSyncNudge } : {}),
      ...(receipt.goal ? { goal: receipt.goal } : {}),
    }) !== receipt.fingerprint) throw new TeamOwnerError('conflict');
    if (receipt.messageRecipientRole !== undefined && receipt.messageRecipientRole !== selected.messageRecipient?.role)
      throw new TeamOwnerError('hold');
    validateCommandAttachments(expected, options.policy.attachments);
    return receipt;
  });
}
