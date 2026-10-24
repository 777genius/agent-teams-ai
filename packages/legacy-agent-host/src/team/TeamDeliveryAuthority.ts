import { assertGroupOriginal } from '../group-chats/groupDelivery.js';
import { teamExecutionAllowed } from './teamLifecycleAdmission.js';
import { digest, safeSegment } from './identity.js';
import { deliveryIdentity, memberBinding } from './DeliveryRecovery.js';
import { readProductCommand } from './commandEntries.js';
import { formatTeamMessage } from './formatTeamMessage.js';
import type { TeamStore, TeamRuntimeBindings } from './ports.js';
import type { OwnerState } from './ownerState.js';
import type { TaskRecovery } from './TaskRecovery.js';
import type {
  TeamBinding,
  TeamGrant,
  CommandReceipt,
  RuntimeMemberBinding,
  ImmutableDelivery,
  DeliveryIntent,
} from './contracts.js';
import type { CapturedCrossTeamIntent } from '../cross-team/contracts.js';
/** Current Team delivery authority, shared unchanged by live admission and evidence attribution. */
export function createTeamDeliveryAuthority(options: {
  binding: TeamBinding;
  store: TeamStore;
  state(): OwnerState;
  authorize(principalId: string, permission: 'read' | 'message.write'): TeamGrant;
  runtimeBindings?: TeamRuntimeBindings | undefined;
  taskRecovery: Pick<TaskRecovery, 'authorizeRetraction' | 'retracting' | 'owns'>;
  taskAuthorityCurrent(receipt: CommandReceipt): boolean;
  authorizeRetainedCancellation?(raw: ImmutableDelivery): boolean;
  retractingRetainedDelivery?(raw: ImmutableDelivery): boolean;
  crossTeamSourceAuthority?: ((intent: CapturedCrossTeamIntent) => boolean) | undefined;
}) {
  function runtimeAccess(
    principalId: string,
    binding: RuntimeMemberBinding,
    action: 'read' | 'control'
  ): boolean {
    return options.store.fenced(() => {
      try {
        const grant = options.authorize(principalId, 'read');
        const member = options
          .state()
          .members.find(
            (candidate) =>
              candidate.delivery &&
              (digest(memberBinding(candidate.delivery)) === digest(memberBinding(binding)) ||
                (action === 'read' &&
                  options.runtimeBindings?.retained(memberBinding(candidate.delivery), binding)))
          );
        if (!member) return false;
        return (
          action === 'read' ||
          grant.permissions.includes('admin') ||
          (member?.name === grant.memberName &&
            (grant.permissions.includes('task.write') ||
              grant.permissions.includes('message.write')))
        );
      } catch {
        return false;
      }
    });
  }

  /** Synchronous Runtime-fence callback; callers separately authenticate user/admin control. */
  function authorizeMember(
    binding: RuntimeMemberBinding,
    action: 'read' | 'admit' | 'dispatch' | 'control'
  ): boolean {
    return options.store.fenced(() => memberAuthorized(binding, action));
  }

  /** Runtime passes the original persisted input identity, never an actor claimed by a tool. */
  function authorizeIntent(
    raw: ImmutableDelivery,
    action: 'read' | 'admit' | 'dispatch' | 'control' = 'admit'
  ): boolean {
    return options.store.fenced(() => {
      try {
        if (
          (action === 'control' || action === 'read') &&
          (options.taskRecovery.authorizeRetraction(raw) ||
            options.authorizeRetainedCancellation?.(raw))
        )
          return true;
        if (
          (action === 'admit' || action === 'dispatch') &&
          (options.taskRecovery.retracting(raw) || options.retractingRetainedDelivery?.(raw))
        )
          return false;
        safeSegment(raw.deliveryId);
        const intent = options.store.read<DeliveryIntent>(`outbox/${raw.deliveryId}.json`);
        return (
          !!intent &&
          digest(deliveryIdentity(raw)) === digest(deliveryIdentity(intent)) &&
          deliveryAuthorized(intent)
        );
      } catch {
        return false;
      }
    });
  }

  function memberAuthorized(
    binding: RuntimeMemberBinding,
    action: 'read' | 'admit' | 'dispatch' | 'control'
  ): boolean {
    try {
      const state = options.state();
      if (
        (action === 'admit' || action === 'dispatch') &&
        !teamExecutionAllowed(state, options.store)
      )
        return false;
      const member = state.members.find(
        (candidate) =>
          candidate.delivery &&
          digest(memberBinding(candidate.delivery)) === digest(memberBinding(binding))
      );
      if (!member) return false;
      if (
        (action === 'admit' || action === 'dispatch') &&
        options.runtimeBindings?.current(memberBinding(member.delivery!))?.workAllowed === false
      )
        return false;
      return state.grants.some(
        (grant) =>
          grant.memberName === member.name &&
          !grant.revoked &&
          grant.permissions.includes('read') &&
          (action === 'read' ||
            action === 'control' ||
            grant.permissions.includes('message.write') ||
            grant.permissions.includes('task.write'))
      );
    } catch {
      return false;
    }
  }

  /** Called under the same Team fence as mutations/revoke and outbox publication. */
  function deliveryAuthorized(intent: DeliveryIntent): boolean {
    try {
      if (intent.schemaVersion !== 1 || !memberAuthorized(intent.binding, 'admit')) return false;
      const receipt = readProductCommand(options.store, intent.commandId);
      if (receipt?.group) assertGroupOriginal(options.store, options.binding, receipt.group);
      if (receipt?.crossTeam && !crossTeamOriginalAuthorized(receipt.crossTeam)) return false;
      if (receipt && receipt.command.operation !== 'message.send')
        return options.taskAuthorityCurrent(receipt) && options.taskRecovery.owns(intent, receipt);
      const grant = options.authorize(intent.principalId, 'message.write');
      if ((grant.revision ?? 1) !== intent.authorityRevision) return false;
      if (
        !receipt ||
        receipt.command.operation !== 'message.send' ||
        receipt.phase === 'rejected' ||
        receipt.principalId !== intent.principalId ||
        receipt.effects.messageId !== intent.messageId ||
        receipt.effects.deliveryId !== intent.deliveryId ||
        intent.inputId !== intent.deliveryId ||
        formatTeamMessage(
          receipt.command.payload,
          grant.memberName,
          receipt.effects.messageId,
          receipt.messageRecipientRole,
          receipt.crossTeam,
          receipt.group
        ) !== intent.content ||
        digest(intent.attachments ?? []) !== digest(receipt.command.payload.attachments ?? []) ||
        !receipt.deliveryBinding ||
        digest(receipt.deliveryBinding) !== digest(intent.binding) ||
        receipt.authorityRevision !== intent.authorityRevision ||
        receipt.fingerprint !==
          digest({
            binding: options.binding,
            principalId: receipt.principalId,
            command: receipt.command,
            deliveryBinding: receipt.deliveryBinding,
            messageRecipientRole: receipt.messageRecipientRole,
            ...(receipt.crossTeam ? { crossTeam: receipt.crossTeam } : {}),
            ...(receipt.group ? { group: receipt.group } : {}),
          })
      )
        return false;
      const member = options
        .state()
        .members.find((candidate) => candidate.memberId === intent.binding.memberId);
      return (
        !!member &&
        member.name === receipt.command.payload.to &&
        (receipt.messageRecipientRole === undefined ||
          member.role === receipt.messageRecipientRole) &&
        (grant.memberName !== 'user' ||
          receipt.command.payload.actionMode !== 'delegate' ||
          member.role === 'lead')
      );
    } catch {
      return false;
    }
  }

  function crossTeamOriginalAuthorized(intent: CapturedCrossTeamIntent): boolean {
    try {
      return options.crossTeamSourceAuthority?.(intent) === true;
    } catch {
      return false;
    }
  }
  return {
    runtimeAccess,
    authorizeMember,
    authorizeIntent,
    crossTeamOriginalAuthorized,
    deliveryAuthorized: (intent: DeliveryIntent) =>
      options.store.fenced(() => deliveryAuthorized(intent)),
  };
}
