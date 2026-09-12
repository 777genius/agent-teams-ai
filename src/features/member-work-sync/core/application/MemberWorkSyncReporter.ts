import { validateMemberWorkSyncReport } from '../domain';
import { getMemberWorkSyncAcceptedReport } from '../domain/MemberWorkSyncAcceptedReport';

import { appendMemberWorkSyncAudit } from './MemberWorkSyncAudit';
import {
  attachMemberWorkSyncReportToken,
  finalizeMemberWorkSyncAgenda,
  MemberWorkSyncReconciler,
} from './MemberWorkSyncReconciler';
import {
  createMemberWorkSyncReportJournalInput,
  matchingPendingReportCheckpoint,
  reportReceiptDraftFromJournal,
  transferAcceptedReportReceipt,
  transferPreviousReportCheckpoint,
} from './MemberWorkSyncReportJournalProtocol';
import { resolveMemberWorkSyncRuntimeActivity } from './MemberWorkSyncRuntimeActivity';
import {
  commitMemberWorkSyncStatus,
  MemberWorkSyncStatusMutationError,
  readMemberWorkSyncStatus,
  runMemberWorkSyncStatusMutation,
} from './MemberWorkSyncStatusMutation';

import type {
  MemberWorkSyncReport,
  MemberWorkSyncReportReceipt,
  MemberWorkSyncReportRequest,
  MemberWorkSyncReportResult,
  MemberWorkSyncStatus,
} from '../../contracts';
import type { MemberWorkSyncReportJournalReplay } from './MemberWorkSyncReportJournalProtocol';
import type { MemberWorkSyncUseCaseDeps } from './ports';

export class MemberWorkSyncReporter {
  private readonly reconciler: MemberWorkSyncReconciler;

  constructor(private readonly deps: MemberWorkSyncUseCaseDeps) {
    this.reconciler = new MemberWorkSyncReconciler(deps);
  }

  async execute(
    request: MemberWorkSyncReportRequest,
    replay?: MemberWorkSyncReportJournalReplay
  ): Promise<MemberWorkSyncReportResult> {
    const receivedAt = replay?.receivedAt ?? this.deps.clock.now().toISOString();
    return runMemberWorkSyncStatusMutation(this.deps, (mutationId) =>
      this.executeAttempt(request, mutationId, receivedAt, replay)
    );
  }

  private async executeAttempt(
    request: MemberWorkSyncReportRequest,
    mutationId: string | undefined,
    receivedAt: string,
    replay?: MemberWorkSyncReportJournalReplay
  ): Promise<MemberWorkSyncReportResult> {
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
    let read = await readMemberWorkSyncStatus(this.deps, request);
    const checkpoint = matchingPendingReportCheckpoint(read.status, replay);
    if (checkpoint && replay) {
      return this.completeCheckpointBackedReplay({
        request,
        mutationId,
        replay,
        read,
        checkpoint,
      });
    }
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
        'team_runtime_inactive',
        mutationId
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
        'member_runtime_inactive',
        mutationId
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
      leaseOriginIso: receivedAt,
    });

    if (!validation.ok) {
      const status = await this.reconciler.execute(request);
      const rejectedStatus = await this.recordRejectedReport(
        status,
        request,
        validation.code,
        mutationId
      );
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
      reportedAt: receivedAt,
      ...(validation.expiresAt ? { expiresAt: validation.expiresAt } : {}),
      ...(request.taskIds ? { taskIds: [...request.taskIds] } : {}),
      ...(request.note ? { note: request.note } : {}),
      source: request.source ?? 'app',
      accepted: true,
    };

    let status = await attachMemberWorkSyncReportToken(this.deps, {
      ...read.status,
      reportToken: undefined,
      reportTokenExpiresAt: undefined,
      providerId: source.providerId,
      lastAcceptedReport: report,
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
    });

    const journal = this.deps.reportJournal;
    const incarnation = read.snapshot?.incarnation;
    let journalInput =
      journal && incarnation
        ? createMemberWorkSyncReportJournalInput({
            request,
            incarnation,
            receivedAt,
            hash: this.deps.hash,
            replay,
          })
        : undefined;
    let replacedReceipt = read.status?.pendingReportReceipt;
    if (journal && journalInput && read.status) {
      const transferred = await transferPreviousReportCheckpoint(
        journal,
        read.status,
        journalInput.intentId
      );
      if (transferred === 'degraded') {
        throw new MemberWorkSyncStatusMutationError('unavailable', mutationId);
      }
      const refreshed = await readMemberWorkSyncStatus(this.deps, request);
      if (!refreshed.status) throw new MemberWorkSyncStatusMutationError('unavailable', mutationId);
      read = refreshed;
      replacedReceipt = refreshed.status.pendingReportReceipt;
      status = {
        ...status,
        statusRevision: refreshed.status.statusRevision,
      };
    }
    if (replacedReceipt && replacedReceipt.intentId === journalInput?.intentId) {
      replacedReceipt = undefined;
    }
    if (journal && journalInput) {
      const ensured = await journal.ensure(journalInput);
      if (ensured.state === 'present' && ensured.intent.status === 'accepted' && read.status) {
        return {
          accepted: true,
          code: 'accepted',
          message: validation.message,
          status: read.status,
        };
      }
      if (ensured.state !== 'present') {
        throw new MemberWorkSyncStatusMutationError(
          ensured.state === 'conflict' ? 'conflict' : 'unavailable',
          mutationId
        );
      }
      journalInput = {
        ...journalInput,
        receivedAt: ensured.intent.journal?.firstRecordedAt ?? journalInput.receivedAt,
        origin: ensured.intent.journal?.origin ?? journalInput.origin,
      };
    }

    const committed = await commitMemberWorkSyncStatus(
      this.deps,
      read,
      status,
      mutationId,
      journalInput ? reportReceiptDraftFromJournal(journalInput, validation.expiresAt) : undefined,
      replacedReceipt
    );
    let projectionDegraded = !committed.canProject;
    if (journal && journalInput && committed.status.pendingReportReceipt) {
      projectionDegraded =
        !(await transferAcceptedReportReceipt(
          journal,
          journalInput,
          committed.status.pendingReportReceipt
        )) || projectionDegraded;
    }
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
      status: committed.status,
      ...(projectionDegraded ? { projectionDegraded: true } : {}),
    };
  }

  private async recordRejectedReport(
    status: MemberWorkSyncStatus,
    request: MemberWorkSyncReportRequest,
    rejectionCode: string,
    mutationId: string | undefined
  ): Promise<MemberWorkSyncStatus> {
    const read = await readMemberWorkSyncStatus(this.deps, request);
    // Reconcile may have completed before a newer report; preserve the fresh status and accepted lease.
    if (!read.status) throw new MemberWorkSyncStatusMutationError('unavailable', mutationId);
    status = read.status;
    const lastAcceptedReport = getMemberWorkSyncAcceptedReport(status);
    const rejectedStatus: MemberWorkSyncStatus = {
      ...status,
      ...(lastAcceptedReport ? { lastAcceptedReport } : {}),
      shadow: {
        ...status.shadow,
        reconciledBy: 'report',
        wouldNudge: status.shadow?.wouldNudge ?? false,
        fingerprintChanged: status.shadow?.fingerprintChanged ?? false,
      },
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
    const committed = await commitMemberWorkSyncStatus(this.deps, read, rejectedStatus, mutationId);
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
    return committed.status;
  }

  private async completeCheckpointBackedReplay(input: {
    request: MemberWorkSyncReportRequest;
    mutationId: string | undefined;
    replay: MemberWorkSyncReportJournalReplay;
    read: Awaited<ReturnType<typeof readMemberWorkSyncStatus>>;
    checkpoint: MemberWorkSyncReportReceipt;
  }): Promise<MemberWorkSyncReportResult> {
    const { request, mutationId, replay, checkpoint } = input;
    const status = input.read.status;
    if (!status) {
      throw new MemberWorkSyncStatusMutationError('unavailable', mutationId);
    }
    const journal = this.deps.reportJournal;
    if (!journal) {
      return {
        accepted: true,
        code: 'accepted',
        message: 'Member work sync report accepted.',
        status,
      };
    }
    const incarnation = input.read.snapshot?.incarnation;
    if (!incarnation) {
      throw new MemberWorkSyncStatusMutationError('unavailable', mutationId);
    }
    const journalInput = createMemberWorkSyncReportJournalInput({
      request,
      incarnation,
      receivedAt: replay.receivedAt,
      hash: this.deps.hash,
      replay,
    });
    const transferredPrevious = await transferPreviousReportCheckpoint(
      journal,
      status,
      journalInput.intentId
    );
    if (transferredPrevious === 'degraded') {
      throw new MemberWorkSyncStatusMutationError('unavailable', mutationId);
    }
    const ensured = await journal.ensure(journalInput);
    if (ensured.state === 'present' && ensured.intent.status === 'accepted') {
      return {
        accepted: true,
        code: 'accepted',
        message: 'Member work sync report accepted.',
        status,
      };
    }
    if (ensured.state !== 'present') {
      throw new MemberWorkSyncStatusMutationError(
        ensured.state === 'conflict' ? 'conflict' : 'unavailable',
        mutationId
      );
    }
    const transferred = await transferAcceptedReportReceipt(
      journal,
      {
        ...journalInput,
        receivedAt: ensured.intent.journal?.firstRecordedAt ?? journalInput.receivedAt,
        origin: ensured.intent.journal?.origin ?? journalInput.origin,
      },
      checkpoint
    );
    if (!transferred) {
      throw new MemberWorkSyncStatusMutationError('unavailable', mutationId);
    }
    return {
      accepted: true,
      code: 'accepted',
      message: 'Member work sync report accepted.',
      status,
    };
  }
}
