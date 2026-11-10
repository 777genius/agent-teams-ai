import { MemberWorkSyncReconciler, type MemberWorkSyncUseCaseDeps } from '../../core/application';
import { peekMemberWorkSyncLastSettlement } from '../infrastructure/memberWorkSyncLastSettlementStore';

import type { MemberWorkSyncStatus, MemberWorkSyncStatusRequest } from '../../contracts';
import type { MemberWorkSyncReconcileContext } from '../../core/application/MemberWorkSyncReconciler';

export async function resolveMemberWorkSyncRefreshSettlement(input: {
  request: MemberWorkSyncStatusRequest;
  teamsBasePath: string;
  nowIso: string;
}): Promise<MemberWorkSyncReconcileContext['settlement']> {
  return peekMemberWorkSyncLastSettlement(input.request);
}

export async function refreshMemberWorkSyncStatus<TAdmission>(input: {
  request: MemberWorkSyncStatusRequest;
  teamsBasePath: string;
  nowIso: string;
  run: (
    teamName: string,
    work: (admission: TAdmission) => Promise<MemberWorkSyncStatus>
  ) => Promise<MemberWorkSyncStatus>;
  bindDeps: (teamName: string, admission: TAdmission) => MemberWorkSyncUseCaseDeps;
}): Promise<MemberWorkSyncStatus> {
  const settlement = await resolveMemberWorkSyncRefreshSettlement(input);
  return input.run(input.request.teamName, (admission) =>
    new MemberWorkSyncReconciler(input.bindDeps(input.request.teamName, admission)).execute(
      input.request,
      {
        reconciledBy: 'request',
        triggerReasons: ['manual_refresh'],
        ...(settlement ? { settlement } : {}),
      }
    )
  );
}
