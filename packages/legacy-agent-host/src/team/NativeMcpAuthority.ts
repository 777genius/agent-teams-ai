import { TeamOwnerError } from './contracts.js';
import { deliveryIdentity, memberBinding } from './DeliveryRecovery.js';
import { readProductCommand } from './commandEntries.js';
import { digest } from './identity.js';
import type {
  ImmutableDelivery,
  RuntimeMemberBinding,
  TeamGrant,
  TeamMember,
} from './contracts.js';
import type { ToolInputCause } from './lookupEvidenceCause.js';
import type { TeamStore } from './ports.js';

export interface NativeMcpAuthorityProof {
  readonly principalId: string;
  readonly authorityRevision: number;
  readonly actorId: string;
  readonly memberName: string;
  readonly role: 'lead' | 'member';
  readonly source: Readonly<RuntimeMemberBinding>;
  readonly original: Readonly<{ inputId: string; deliveryId: string; messageId: string }>;
  readonly cause: Readonly<ToolInputCause>;
  readonly mode: 'do';
  readonly fingerprint: string;
}

/** Trusted composition only. Raw source is the original persisted Runtime input, never MCP args. */
export function captureNativeMcpAuthority(options: {
  principalId: string;
  source: RuntimeMemberBinding;
  raw: ImmutableDelivery;
  requireLead: boolean;
  store: TeamStore;
  members: readonly TeamMember[];
  grant: TeamGrant;
  lookupCause(): ToolInputCause | null;
}): Readonly<NativeMcpAuthorityProof> {
  const { grant, source, raw } = options;
  const member = options.members.find((candidate) => candidate.memberId === source.memberId);
  if (
    grant.principalId !== options.principalId ||
    grant.revoked ||
    grant.memberName === 'user' ||
    !grant.permissions.includes('read') ||
    !grant.permissions.includes('task.write') ||
    !member?.delivery ||
    member.name !== grant.memberName ||
    (options.requireLead && member.role !== 'lead') ||
    digest(memberBinding(member.delivery)) !== digest(memberBinding(source)) ||
    digest(memberBinding(raw.binding)) !== digest(memberBinding(source))
  )
    throw new TeamOwnerError('forbidden');
  const cause = options.lookupCause();
  if (
    !cause ||
    cause.inputId !== raw.inputId ||
    cause.deliveryId !== raw.deliveryId ||
    cause.messageId !== raw.messageId ||
    digest(memberBinding(cause.binding)) !== digest(memberBinding(source))
  )
    throw new TeamOwnerError('forbidden');
  // Same original-input DO policy used by ordinary native helpers: accepted TaskStart,
  // or the original persisted message's explicit/default DO mode. Never a payload mode.
  if (!('taskId' in cause)) {
    const receipt = readProductCommand(options.store, cause.messageCommandId);
    if (
      receipt?.command.operation !== 'message.send' ||
      (receipt.command.payload.actionMode ?? 'do') !== 'do'
    )
      throw new TeamOwnerError('forbidden');
  }
  const value = {
    principalId: options.principalId,
    authorityRevision: grant.revision ?? 1,
    actorId: member.memberId,
    memberName: member.name,
    role: member.role,
    source: Object.freeze({ ...memberBinding(source) }),
    original: Object.freeze({
      inputId: raw.inputId,
      deliveryId: raw.deliveryId,
      messageId: raw.messageId,
    }),
    cause: Object.freeze({ ...cause, binding: Object.freeze({ ...cause.binding }) }),
    mode: 'do' as const,
  };
  return Object.freeze({
    ...value,
    fingerprint: digest({ ...value, delivery: deliveryIdentity(raw) }),
  });
}
