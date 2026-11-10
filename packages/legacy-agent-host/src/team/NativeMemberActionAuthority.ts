import { TeamOwnerError } from './contracts.js';
import { memberBinding } from './DeliveryRecovery.js';
import { digest } from './identity.js';
import { assertTeamExecutionAllowed } from './teamLifecycleAdmission.js';
import type { NativeMcpAuthorityProof } from './NativeMcpAuthority.js';
import type { OwnerState } from './ownerState.js';
import type { RuntimeMemberBinding, TeamGrant } from './contracts.js';
import type { TeamRuntimeBindings, TeamStore } from './ports.js';

export interface NativeMemberActionTarget {
  memberId: string;
  /** Exact current native generation when controlling a runtime; absent for metadata-only lookup. */
  binding?: RuntimeMemberBinding;
}
export interface NativeMemberActionRequest {
  proof: Readonly<NativeMcpAuthorityProof>;
  target: NativeMemberActionTarget;
  action: 'read' | 'control' | 'work';
  assertSourceTeam(): void;
}
/** Called only inside the actual Team fence; Runtime's original-input check occurs immediately before it. */
export function withNativeMemberActionAuthority<T>(
  options: NativeMemberActionRequest & {
    state: OwnerState;
    store: TeamStore;
    grant: TeamGrant;
    runtimeBindings?: TeamRuntimeBindings | undefined;
  },
  callback: () => T
): T {
  options.assertSourceTeam();
  const { proof, grant, state, target } = options;
  const actor = state.members.find((m) => m.memberId === proof.actorId);
  const member = state.members.find((m) => m.memberId === target.memberId);
  if (
    proof.mode !== 'do' ||
    proof.role !== 'lead' ||
    !actor?.delivery ||
    actor.role !== 'lead' ||
    proof.principalId !== grant.principalId ||
    proof.authorityRevision !== (grant.revision ?? 1) ||
    grant.revoked ||
    grant.memberName !== actor.name ||
    !grant.permissions.includes('read') ||
    !grant.permissions.includes('task.write') ||
    !member ||
    member.memberId === actor.memberId ||
    member.role !== 'member' ||
    digest(memberBinding(actor.delivery)) !== digest(memberBinding(proof.source))
  )
    throw new TeamOwnerError('forbidden');
  if (member.delivery) {
    const current =
      options.runtimeBindings?.current(memberBinding(member.delivery))?.binding ??
      memberBinding(member.delivery);
    if (
      ['backendId', 'teamId', 'runId'].some(
        (k) => current[k as 'runId'] !== proof.source[k as 'runId']
      ) ||
      (target.binding && digest(memberBinding(target.binding)) !== digest(memberBinding(current)))
    )
      throw new TeamOwnerError('forbidden');
  } else if (target.binding) throw new TeamOwnerError('forbidden');
  if (options.action === 'work') assertTeamExecutionAllowed(state, options.store);
  options.assertSourceTeam();
  return callback();
}
