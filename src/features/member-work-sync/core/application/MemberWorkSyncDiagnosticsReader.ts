import { decideMemberWorkSyncStatus } from '../domain';

import {
  attachMemberWorkSyncReportToken,
  finalizeMemberWorkSyncAgenda,
} from './MemberWorkSyncReconciler';
import { resolveMemberWorkSyncRuntimeActivity } from './MemberWorkSyncRuntimeActivity';

import type { MemberWorkSyncStatus, MemberWorkSyncStatusRequest } from '../../contracts';
import type { MemberWorkSyncUseCaseDeps } from './ports';

export class MemberWorkSyncDiagnosticsReader {
  constructor(private readonly deps: MemberWorkSyncUseCaseDeps) {}

  async execute(request: MemberWorkSyncStatusRequest): Promise<MemberWorkSyncStatus> {
    const stored = await this.deps.statusStore.read(request);
    if (stored) {
      return stored;
    }

    const source = await this.deps.agendaSource.loadAgenda(request);
    const agenda = finalizeMemberWorkSyncAgenda(this.deps, source);
    const nowIso = this.deps.clock.now().toISOString();
    const runtimeActivity = await resolveMemberWorkSyncRuntimeActivity(this.deps, {
      teamName: agenda.teamName,
      memberName: agenda.memberName,
    });
    const decision = decideMemberWorkSyncStatus({
      agenda,
      nowIso,
      inactive: source.inactive || runtimeActivity.inactive,
    });

    return attachMemberWorkSyncReportToken(this.deps, {
      teamName: agenda.teamName,
      memberName: agenda.memberName,
      state: decision.state,
      agenda,
      shadow: {
        reconciledBy: 'request',
        wouldNudge: false,
        fingerprintChanged: false,
      },
      evaluatedAt: nowIso,
      diagnostics: [
        ...agenda.diagnostics,
        ...runtimeActivity.diagnostics,
        ...decision.diagnostics,
        'status_snapshot_not_persisted',
      ],
      ...(source.providerId ? { providerId: source.providerId } : {}),
    });
  }
}
