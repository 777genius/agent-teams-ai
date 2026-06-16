import {
  buildAgendaFingerprintPayload,
  canonicalizeAgendaFingerprintPayload,
  decideMemberWorkSyncStatus,
  formatAgendaFingerprint,
} from '../domain';

import { appendMemberWorkSyncAudit } from './MemberWorkSyncAudit';
import { MemberWorkSyncNudgeOutboxPlanner } from './MemberWorkSyncNudgeOutboxPlanner';
import { resolveMemberWorkSyncRuntimeActivity } from './MemberWorkSyncRuntimeActivity';

import type { MemberWorkSyncStatus, MemberWorkSyncStatusRequest } from '../../contracts';
import type { MemberWorkSyncAgendaSourceResult, MemberWorkSyncUseCaseDeps } from './ports';

export interface MemberWorkSyncReconcileContext {
  reconciledBy?: 'request' | 'queue';
  triggerReasons?: string[];
  isCancelled?: () => boolean;
  recovery?: {
    kind: 'proof_missing';
    intentKey: string;
    originalMessageId: string;
    taskIds?: string[];
  };
}

export class MemberWorkSyncReconcileCancelledError extends Error {
  constructor() {
    super('member work sync reconcile cancelled');
    this.name = 'MemberWorkSyncReconcileCancelledError';
  }
}

function assertReconcileNotCancelled(context: MemberWorkSyncReconcileContext): void {
  if (context.isCancelled?.()) {
    throw new MemberWorkSyncReconcileCancelledError();
  }
}

export function finalizeMemberWorkSyncAgenda(
  deps: MemberWorkSyncUseCaseDeps,
  source: MemberWorkSyncAgendaSourceResult
) {
  const payload = buildAgendaFingerprintPayload({
    teamName: source.agenda.teamName,
    memberName: source.agenda.memberName,
    items: source.agenda.items,
    sourceRevision: source.agenda.sourceRevision,
  });
  const fingerprint = formatAgendaFingerprint(
    deps.hash.sha256Hex(canonicalizeAgendaFingerprintPayload(payload))
  );
  return {
    ...source.agenda,
    fingerprint,
    diagnostics: [...source.agenda.diagnostics, ...source.diagnostics],
  };
}

export class MemberWorkSyncReconciler {
  private readonly nudgeOutboxPlanner: MemberWorkSyncNudgeOutboxPlanner;

  constructor(private readonly deps: MemberWorkSyncUseCaseDeps) {
    this.nudgeOutboxPlanner = new MemberWorkSyncNudgeOutboxPlanner(deps);
  }

  async execute(
    request: MemberWorkSyncStatusRequest,
    context: MemberWorkSyncReconcileContext = {}
  ): Promise<MemberWorkSyncStatus> {
    await appendMemberWorkSyncAudit(this.deps, {
      teamName: request.teamName,
      memberName: request.memberName,
      event: 'reconcile_started',
      source: 'reconciler',
      ...(context.triggerReasons?.length ? { triggerReasons: context.triggerReasons } : {}),
    });
    const source = await this.deps.agendaSource.loadAgenda(request);
    assertReconcileNotCancelled(context);
    const agenda = finalizeMemberWorkSyncAgenda(this.deps, source);
    await appendMemberWorkSyncAudit(this.deps, {
      teamName: agenda.teamName,
      memberName: agenda.memberName,
      event: 'agenda_loaded',
      source: 'reconciler',
      agendaFingerprint: agenda.fingerprint,
      actionableCount: agenda.items.length,
      ...(source.providerId ? { providerId: source.providerId } : {}),
      diagnostics: agenda.diagnostics,
    });
    assertReconcileNotCancelled(context);
    const previous = await this.deps.statusStore.read(request);
    const nowIso = this.deps.clock.now().toISOString();
    const runtimeActivity = await resolveMemberWorkSyncRuntimeActivity(this.deps, {
      teamName: agenda.teamName,
      memberName: agenda.memberName,
    });
    assertReconcileNotCancelled(context);
    const decision = decideMemberWorkSyncStatus({
      agenda,
      latestAcceptedReport: previous?.report?.accepted ? previous.report : null,
      nowIso,
      inactive: source.inactive || runtimeActivity.inactive,
    });
    await appendMemberWorkSyncAudit(this.deps, {
      teamName: agenda.teamName,
      memberName: agenda.memberName,
      event: source.inactive || runtimeActivity.inactive ? 'team_inactive' : 'decision_made',
      source: 'reconciler',
      agendaFingerprint: agenda.fingerprint,
      state: decision.state,
      actionableCount: agenda.items.length,
      ...(source.providerId ? { providerId: source.providerId } : {}),
      diagnostics: decision.diagnostics,
    });

    assertReconcileNotCancelled(context);
    const status = await attachMemberWorkSyncReportToken(this.deps, {
      teamName: agenda.teamName,
      memberName: agenda.memberName,
      state: decision.state,
      agenda,
      ...(decision.acceptedReport ? { report: decision.acceptedReport } : {}),
      shadow: {
        reconciledBy: context.reconciledBy ?? 'request',
        wouldNudge: decision.state === 'needs_sync' && agenda.items.length > 0,
        fingerprintChanged:
          Boolean(previous?.agenda.fingerprint) &&
          previous?.agenda.fingerprint !== agenda.fingerprint,
        ...(previous?.agenda.fingerprint
          ? { previousFingerprint: previous.agenda.fingerprint }
          : {}),
        ...(context.triggerReasons?.length
          ? { triggerReasons: [...new Set(context.triggerReasons)].sort() }
          : {}),
        ...(context.recovery
          ? {
              recovery: {
                kind: context.recovery.kind,
                intentKey: context.recovery.intentKey,
                originalMessageId: context.recovery.originalMessageId,
                taskIds: [...new Set(context.recovery.taskIds ?? [])].sort(),
              },
            }
          : {}),
      },
      evaluatedAt: nowIso,
      diagnostics: [...agenda.diagnostics, ...runtimeActivity.diagnostics, ...decision.diagnostics],
      ...(source.providerId ? { providerId: source.providerId } : {}),
    });

    assertReconcileNotCancelled(context);
    await this.deps.statusStore.write(status);
    assertReconcileNotCancelled(context);
    await this.planNudgeOutbox(status);
    return status;
  }

  private async planNudgeOutbox(status: MemberWorkSyncStatus): Promise<void> {
    const result = await this.nudgeOutboxPlanner.plan(status);
    if (result.code !== 'outbox_unavailable' && result.code !== 'status_not_nudgeable') {
      this.deps.logger?.debug('member work sync nudge outbox planning result', {
        teamName: status.teamName,
        memberName: status.memberName,
        code: result.code,
        planned: result.planned,
      });
    }
  }
}

export async function attachMemberWorkSyncReportToken(
  deps: MemberWorkSyncUseCaseDeps,
  status: MemberWorkSyncStatus
): Promise<MemberWorkSyncStatus> {
  if (!deps.reportToken) {
    return status;
  }

  const issued = await deps.reportToken.create({
    teamName: status.teamName,
    memberName: status.memberName,
    agendaFingerprint: status.agenda.fingerprint,
    issuedAt: status.evaluatedAt,
  });

  return {
    ...status,
    reportToken: issued.token,
    reportTokenExpiresAt: issued.expiresAt,
    diagnostics: [...status.diagnostics, 'report_token_issued'],
  };
}
