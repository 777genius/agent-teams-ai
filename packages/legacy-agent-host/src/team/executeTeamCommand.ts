import { assertGroupOriginal, groupTargetCommand } from '../group-chats/groupDelivery.js';
import { validateCrossTeamTargetContext } from '../cross-team/crossTeamInbound.js';
import { captureCommandSelection } from './captureCommandSelection.js';
import { validateCommandAttachments } from './validateCommandAttachments.js';
import {
  teamCommandPath,
  readProductCommand,
  listProductCommandReceipts,
} from './commandEntries.js';
import { applyTeamTask } from './applyTeamTask.js';
import { requiresHumanTaskActor } from './taskStartIntent.js';
import { commitTeamMessage } from './commitTeamMessage.js';
import { digest, effectId } from './identity.js';
import { TeamOwnerError } from './contracts.js';
import { TaskPolicyRejected } from './ports.js';
import { validateTeamCommand } from './validateTeamCommand.js';
import type { CapturedGroupIntent } from '../group-chats/groupCommandRecords.js';
import type { CapturedCrossTeamIntent } from '../cross-team/contracts.js';
import type { OwnerState } from './ownerState.js';
import type { TaskRecovery } from './TaskRecovery.js';
import type { TeamStore, TeamPolicyPort } from './ports.js';
import type { TeamBinding, TeamGrant, TeamCommand, CommandReceipt } from './contracts.js';

interface TeamCommandExecution {
  binding: TeamBinding;
  store: TeamStore;
  policy: TeamPolicyPort;
  taskRecovery: Pick<TaskRecovery, 'hasPlan' | 'commit'>;
  state(): OwnerState;
  authorize(principalId: string, permission: TeamGrant['permissions'][number]): TeamGrant;
  crossTeamOriginalAuthorized(intent: CapturedCrossTeamIntent): boolean;
  invalidate(): void;
}

/** One synchronous Team-fenced command transition, including private physical group delivery. */
export function executeTeamCommand(
  options: TeamCommandExecution,
  principalId: string,
  rawCommand: TeamCommand,
  crossTeam?: CapturedCrossTeamIntent,
  group?: CapturedGroupIntent
): CommandReceipt {
  validateTeamCommand(rawCommand);
  const command = structuredClone(rawCommand);
  return options.store.fenced(() => {
    const grant = options.authorize(
      principalId,
      command.operation === 'message.send' ? 'message.write' : 'task.write'
    );
    if (group) {
      assertGroupOriginal(options.store, options.binding, group);
      if (
        crossTeam ||
        group.principalId !== principalId ||
        group.actor !== grant.memberName ||
        group.authorityRevision !== (grant.revision ?? 1) ||
        digest(groupTargetCommand(group)) !== digest(command) ||
        digest(
          options.state().members.find((member) => member.name === group.recipient.name)?.delivery
        ) !== digest(group.recipient.binding)
      )
        throw new TeamOwnerError('forbidden');
    }
    if (crossTeam) {
      validateCrossTeamTargetContext(
        options.binding,
        principalId,
        command,
        crossTeam,
        grant.revision ?? 1
      );
      if (!options.crossTeamOriginalAuthorized(crossTeam)) throw new TeamOwnerError('hold');
    }
    // Completed replay must pass current authority, not only the original mutation's check.
    options.authorize(principalId, 'read');
    if (requiresHumanTaskActor(command) && grant.memberName !== 'user')
      throw new TeamOwnerError('forbidden');
    validateCommandAttachments(command, options.policy.attachments);
    const location = teamCommandPath(command.commandId);
    if (
      options.state().rosterCommands?.some((receipt) => receipt.commandId === command.commandId) ||
      options.state().runtimeCaptures?.some((receipt) => receipt.commandId === command.commandId)
    )
      throw new TeamOwnerError('conflict');
    let receipt = readProductCommand(options.store, command.commandId);
    const {
      messageRecipient,
      messageRecipientRole,
      deliveryBinding,
      taskRecipients,
      taskStartLeadName,
    } = captureCommandSelection(command, receipt, options.state().members, grant);
    const fingerprint = digest({
      binding: options.binding,
      principalId,
      command,
      deliveryBinding,
      taskRecipients,
      messageRecipientRole,
      taskStartLeadName,
      ...(crossTeam ? { crossTeam } : {}),
      ...(group ? { group } : {}),
    });
    if (receipt) {
      if (
        receipt.messageRecipientRole !== undefined &&
        receipt.messageRecipientRole !== messageRecipient?.role
      )
        throw new TeamOwnerError('hold');
      if (receipt.principalId !== principalId || receipt.fingerprint !== fingerprint)
        throw new TeamOwnerError('conflict');
      if (receipt.phase === 'completed' || receipt.phase === 'rejected') return receipt;
      if (
        command.operation !== 'message.send' &&
        receipt.phase !== 'prepared' &&
        !options.taskRecovery.hasPlan(receipt) &&
        (receipt.taskPlanVersion !== 1 ||
          receipt.taskPreimage !== options.store.productFingerprint(options.binding.teamName))
      )
        throw new TeamOwnerError('hold');
    } else {
      if (command.operation === 'message.send') {
        const to = command.payload.to;
        if (
          to === 'user'
            ? grant.memberName === 'user'
            : !options.state().members.some((member) => member.name === to && member.delivery)
        )
          throw new TeamOwnerError('invalid');
      }
      const pending = listProductCommandReceipts(options.store);
      if (
        command.operation !== 'message.send' &&
        pending.some(
          (entry) =>
            entry.command.operation !== 'message.send' &&
            !['completed', 'rejected'].includes(entry.phase)
        )
      )
        throw new TeamOwnerError('hold');
      const seed = [options.binding.backendId, options.binding.teamId, command.commandId];
      receipt = {
        schemaVersion: 1,
        binding: options.binding,
        commandId: command.commandId,
        principalId,
        fingerprint,
        command,
        ...(crossTeam ? { crossTeam: structuredClone(crossTeam) } : {}),
        ...(group ? { group: structuredClone(group) } : {}),
        ...(taskStartLeadName ? { taskStartLeadName } : {}),
        ...(messageRecipientRole ? { messageRecipientRole } : {}),
        effects: {
          taskId: effectId('task', ...seed),
          commentId: effectId('comment', ...seed),
          messageId: crossTeam
            ? crossTeam.request.messageId
            : command.operation === 'message.send' && command.payload.messageId !== undefined
              ? command.payload.messageId
              : effectId('message', ...seed),
          deliveryId: effectId('delivery', ...seed),
        },
        createdAt: group?.message.timestamp ?? crossTeam?.timestamp ?? new Date().toISOString(),
        phase: 'prepared',
        authorityRevision: grant.revision ?? 1,
        ...(command.operation !== 'message.send'
          ? {
              taskPlanVersion: 1 as const,
              taskPreimage: options.store.productFingerprint(options.binding.teamName),
              taskRecipients: taskRecipients!,
            }
          : {}),
        ...(deliveryBinding
          ? {
              deliveryBinding: structuredClone(deliveryBinding),
              authorityRevision: grant.revision ?? 1,
            }
          : {}),
      };
      options.store.write(location, receipt);
    }
    receipt.phase = 'applying';
    options.store.write(location, receipt);
    const before = options.store.productFingerprint(options.binding.teamName);
    try {
      if (command.operation === 'message.send')
        receipt.result = commitTeamMessage(
          receipt,
          grant.memberName,
          options.state().members,
          options.store,
          options.policy,
          options.policy.attachments
        );
      else {
        const plan = options.taskRecovery.commit(
          receipt,
          grant.memberName,
          options.state().members,
          (board) =>
            applyTeamTask(
              receipt,
              grant.memberName,
              board,
              options.binding.teamName,
              options.policy.attachments
            )
        );
        receipt.result = plan.result;
        receipt.taskHash = plan.taskHash;
      }
      receipt.phase = 'completed';
      options.store.write(location, receipt);
      return receipt;
    } catch (error) {
      if (
        command.operation !== 'message.send' &&
        error instanceof TaskPolicyRejected &&
        options.store.productFingerprint(options.binding.teamName) === before &&
        !receipt.result
      ) {
        receipt.phase = 'rejected';
        receipt.result = { rejected: true, reason: 'policy' };
        options.store.write(location, receipt);
        return receipt;
      }
      // Exception may follow partial filesystem effects; never label it not-applied.
      receipt.phase = 'held';
      options.store.write(location, receipt);
      throw new TeamOwnerError('hold');
    } finally {
      options.invalidate();
    }
  });
}
