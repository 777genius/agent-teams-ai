import { validateMemberWorkSyncReport } from '../domain';

import { appendMemberWorkSyncAudit } from './MemberWorkSyncAudit';
import {
  attachMemberWorkSyncReportToken,
  finalizeMemberWorkSyncAgenda,
  MemberWorkSyncReconciler,
} from './MemberWorkSyncReconciler';
import { resolveMemberWorkSyncRuntimeActivity } from './MemberWorkSyncRuntimeActivity';

import type {
  MemberWorkSyncReport,
  MemberWorkSyncReportRequest,
  MemberWorkSyncReportResult,
  MemberWorkSyncStatus,
} from '../../contracts';
import type { MemberWorkSyncUseCaseDeps } from './ports';

export class MemberWorkSyncReporter {
  private readonly reconciler: MemberWorkSyncReconciler;

  constructor(private readonly deps: MemberWorkSyncUseCaseDeps) {
    this.reconciler = new MemberWorkSyncReconciler(deps);
  }

  async execute(request: MemberWorkSyncReportRequest): Promise<MemberWorkSyncReportResult> {
    await appendMemberWorkSyncAudit(this.deps, {
      teamName: request.teamName,
      memberName: request.memberName,
      event: 'report_received',
      source: 'reporter',
      agendaFingerprint: request.agendaFingerprint,
      state: request.state,
      ...(request.taskIds?.length
        ? {
            taskRefs: request.taskIds.map((taskId) => ({
              taskId,
              teamName: request.teamName,
            })),
          }
        : {}),
    });
    const source = await this.deps.agendaSource.loadAgenda(request);
    const agenda = finalizeMemberWorkSyncAgenda(this.deps, source);
    const nowIso = this.deps.clock.now().toISOString();
    const runtimeActivity = await resolveMemberWorkSyncRuntimeActivity(this.deps, {
      teamName: agenda.teamName,
      memberName: agenda.memberName,
    });
    if (!runtimeActivity.teamActive) {
      const status = await this.reconciler.execute(request);
      const rejectedStatus = await this.recordRejectedReport(
        status,
        request,
        'team_runtime_inactive'
      );
      return {
        accepted: false,
        code: 'team_runtime_inactive',
        message: 'Team runtime is not active. Restart the team before reporting work sync state.',
        status: rejectedStatus,
      };
    }
    if (!runtimeActivity.memberActive) {
      const status = await this.reconciler.execute(request);
      const rejectedStatus = await this.recordRejectedReport(
        status,
        request,
        'member_runtime_inactive'
      );
      return {
        accepted: false,
        code: 'member_runtime_inactive',
        message:
          'Member runtime is not active. Restart this teammate before reporting work sync state.',
        status: rejectedStatus,
      };
    }
    const tokenValidation = this.deps.reportToken
      ? await this.deps.reportToken.verify({
          token: request.reportToken,
          teamName: agenda.teamName,
          memberName: agenda.memberName,
          agendaFingerprint: agenda.fingerprint,
          nowIso,
        })
      : ({ ok: false, reason: 'missing' } as const);
    const validation = validateMemberWorkSyncReport({
      request,
      agenda,
      nowIso,
      activeMemberNames: source.activeMemberNames,
      tokenValidation,
    });

    if (!validation.ok) {
      const status = await this.reconciler.execute(request);
      const rejectedStatus = await this.recordRejectedReport(status, request, validation.code);
      return {
        accepted: false,
        code: validation.code,
        message: validation.message,
        status: rejectedStatus,
      };
    }

    const report: MemberWorkSyncReport = {
      teamName: agenda.teamName,
      memberName: agenda.memberName,
      state: request.state,
      agendaFingerprint: agenda.fingerprint,
      reportedAt: nowIso,
      ...(validation.expiresAt ? { expiresAt: validation.expiresAt } : {}),
      ...(request.taskIds ? { taskIds: [...request.taskIds] } : {}),
      ...(request.note ? { note: request.note } : {}),
      source: request.source ?? 'app',
      accepted: true,
    };

    const status = await attachMemberWorkSyncReportToken(this.deps, {
      teamName: agenda.teamName,
      memberName: agenda.memberName,
      state:
        report.state === 'caught_up'
          ? ('caught_up' as const)
          : report.state === 'blocked'
            ? ('blocked' as const)
            : ('still_working' as const),
      agenda,
      report,
      shadow: {
        reconciledBy: 'report',
        wouldNudge: false,
        fingerprintChanged: false,
      },
      evaluatedAt: nowIso,
      diagnostics: [...agenda.diagnostics, 'report_accepted'],
      ...(source.providerId ? { providerId: source.providerId } : {}),
    });

    await this.deps.statusStore.write(status);
    await appendMemberWorkSyncAudit(this.deps, {
      teamName: status.teamName,
      memberName: status.memberName,
      event: 'report_accepted',
      source: 'reporter',
      agendaFingerprint: agenda.fingerprint,
      state: status.state,
      actionableCount: agenda.items.length,
      ...(source.providerId ? { providerId: source.providerId } : {}),
    });
    return {
      accepted: true,
      code: 'accepted',
      message: validation.message,
      status,
    };
  }

  private async recordRejectedReport(
    status: MemberWorkSyncStatus,
    request: MemberWorkSyncReportRequest,
    rejectionCode: string
  ): Promise<MemberWorkSyncStatus> {
    const rejectedStatus: MemberWorkSyncStatus = {
      ...status,
      report: {
        teamName: status.teamName,
        memberName: status.memberName,
        state: request.state,
        agendaFingerprint: request.agendaFingerprint,
        reportedAt: status.evaluatedAt,
        ...(request.taskIds ? { taskIds: [...request.taskIds] } : {}),
        ...(request.note ? { note: request.note } : {}),
        source: request.source ?? 'app',
        accepted: false,
        rejectionCode,
      },
      diagnostics: [...status.diagnostics, `report_rejected:${rejectionCode}`],
    };
    await this.deps.statusStore.write(rejectedStatus);
    await appendMemberWorkSyncAudit(this.deps, {
      teamName: status.teamName,
      memberName: status.memberName,
      event: 'report_rejected',
      source: 'reporter',
      agendaFingerprint: request.agendaFingerprint,
      state: request.state,
      actionableCount: status.agenda.items.length,
      reason: rejectionCode,
      ...(status.providerId ? { providerId: status.providerId } : {}),
    });
    return rejectedStatus;
  }
}
