import { reserveMemberWorkSyncRecoveryIntent } from './MemberWorkSyncRecoveryAllocator';

import type { MemberWorkSyncOutboxEnsureInput, MemberWorkSyncStatus } from '../../contracts';
import type { MemberWorkSyncUseCaseDeps } from './ports';

interface BlockedRecoveryPlan {
  planned: false;
  code: 'recovery_allocation_disabled' | 'member_stopped' | 'slot_occupied';
}

export async function skipMemberWorkSyncRecoveryAllocation(input: {
  status: MemberWorkSyncStatus;
  appendPlanAudit: (status: MemberWorkSyncStatus, result: BlockedRecoveryPlan) => Promise<void>;
}): Promise<BlockedRecoveryPlan> {
  const result = { planned: false, code: 'recovery_allocation_disabled' } as const;
  await input.appendPlanAudit(input.status, result);
  return result;
}

export async function reserveAllocatedMemberWorkSyncRecovery(input: {
  deps: MemberWorkSyncUseCaseDeps;
  status: MemberWorkSyncStatus;
  recoveryInput: MemberWorkSyncOutboxEnsureInput;
  appendPlanAudit: (status: MemberWorkSyncStatus, result: BlockedRecoveryPlan) => Promise<void>;
}): Promise<BlockedRecoveryPlan | null> {
  const reserved = await reserveMemberWorkSyncRecoveryIntent({
    deps: input.deps,
    status: input.status,
    recoveryInput: input.recoveryInput,
    trigger: 'automatic',
  });
  if (reserved.ok) {
    return null;
  }
  const code = reserved.code === 'member_stopped' ? 'member_stopped' : 'slot_occupied';
  const result = { planned: false, code } as const;
  await input.appendPlanAudit(input.status, result);
  return result;
}
