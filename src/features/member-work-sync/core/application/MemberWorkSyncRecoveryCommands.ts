import {
  applyMemberWorkSyncStopLatch,
  attachMemberWorkSyncRecoveryReservation,
  abandonMemberWorkSyncPendingStop,
  assertValidMemberWorkSyncRuntimeControlReason,
  buildMemberWorkSyncNudgePayloadHash,
  buildMemberWorkSyncOutboxEnsureInput,
  clearMemberWorkSyncStopLatch,
  nextMemberWorkSyncControlRevision,
} from '../domain';

import { isMemberWorkSyncRecoveryAllocationEnabled } from './MemberWorkSyncNudgeOutboxPlanHelpers';
import { retireMemberWorkSyncRecoveryIntent } from './MemberWorkSyncRecoveryDispatchOutcome';
import {
  commitMemberWorkSyncStatus,
  readMemberWorkSyncStatus,
  runMemberWorkSyncStatusMutation,
} from './MemberWorkSyncStatusMutation';

import {
  normalizeMemberWorkSyncRuntimeControlReason,
  type MemberWorkSyncPendingRuntimeControl,
  type MemberWorkSyncStatus,
} from '../../contracts';
import type { MemberWorkSyncUseCaseDeps } from './ports';
import {
  MemberWorkSyncExactRuntimeStop,
  MemberWorkSyncRuntimeControlUnavailableError,
  MemberWorkSyncStaleIncarnationError,
  type MemberWorkSyncRuntimeAdmissionOutcome,
} from './MemberWorkSyncExactRuntimeStop';

export {
  MemberWorkSyncRuntimeControlUnavailableError,
  MemberWorkSyncStaleIncarnationError,
  MemberWorkSyncStaleRuntimeInstanceError,
} from './MemberWorkSyncExactRuntimeStop';
export type { MemberWorkSyncRuntimeAdmissionOutcome } from './MemberWorkSyncExactRuntimeStop';

export type MemberWorkSyncRecoveryCommandResult =
  | {
      ok: true;
      status: MemberWorkSyncStatus;
      code: 'stopped' | 'resumed' | 'continued' | 'observed';
      runtimeAdmission?: MemberWorkSyncRuntimeAdmissionOutcome;
    }
  | {
      ok: false;
      code:
        | 'member_stopped'
        | 'slot_occupied'
        | 'status_missing'
        | 'status_not_nudgeable'
        | 'outbox_unavailable'
        | 'payload_conflict'
        | 'member_busy';
    };

export class MemberWorkSyncRecoveryCommands {
  constructor(private readonly deps: MemberWorkSyncUseCaseDeps) {}

  async stop(input: {
    teamName: string;
    memberName: string;
    reason?: string;
    expectedIncarnation?: string;
    expectedRuntimeInstanceId?: string;
    localStopId?: string;
  }): Promise<MemberWorkSyncRecoveryCommandResult> {
    const expectedRuntimeInstanceId = input.expectedRuntimeInstanceId?.trim();
    const localStopId = input.localStopId?.trim();
    const reason = normalizeMemberWorkSyncRuntimeControlReason(
      input.reason,
      expectedRuntimeInstanceId || localStopId ? 'runtime_local_stop' : 'user_stop'
    );
    assertValidMemberWorkSyncRuntimeControlReason(reason);
    if (expectedRuntimeInstanceId || localStopId) {
      if (
        !expectedRuntimeInstanceId ||
        !localStopId ||
        expectedRuntimeInstanceId.length > 256 ||
        localStopId.length > 256
      ) {
        throw new MemberWorkSyncRuntimeControlUnavailableError();
      }
      return this.stopExactRuntime({ ...input, reason, expectedRuntimeInstanceId, localStopId });
    }
    return runMemberWorkSyncStatusMutation(this.deps, (mutationId) =>
      this.mutate(input, mutationId, (status, nowIso) => ({
        ...status,
        recoveryHealth: applyMemberWorkSyncStopLatch({
          previous: status.recoveryHealth,
          nowIso,
          reason,
        }),
        evaluatedAt: nowIso,
      }))
    ).then(async (status) => {
      const revoked = await invalidateStaleMemberWorkSyncInboxNudges(this.deps, status);
      const nextStatus = await retireRevokedDeliveredRecovery(
        this.deps,
        status,
        revoked.messageIds
      );
      const controlRevision = nextStatus.recoveryHealth?.controlRevision ?? 1;
      const runtimeAdmission = await this.syncRuntimeControl({
        teamName: input.teamName,
        memberName: input.memberName,
        teamIncarnation: nextStatus.statusRevision?.incarnation ?? 'legacy',
        stopped: true,
        controlRevision,
      });
      const persisted = await this.persistRuntimeAdmission(
        input,
        controlRevision,
        runtimeAdmission
      );
      return {
        ok: true as const,
        status: persisted,
        code: 'stopped' as const,
        runtimeAdmission,
      };
    });
  }

  private async stopExactRuntime(input: {
    teamName: string;
    memberName: string;
    reason?: string;
    expectedIncarnation?: string;
    expectedRuntimeInstanceId: string;
    localStopId: string;
  }): Promise<MemberWorkSyncRecoveryCommandResult> {
    const exact = await new MemberWorkSyncExactRuntimeStop(this.deps).execute(input);
    const status = exact.status;
    const revoked = await invalidateStaleMemberWorkSyncInboxNudges(this.deps, status);
    const nextStatus = await retireRevokedDeliveredRecovery(this.deps, status, revoked.messageIds);
    return {
      ok: true,
      status: nextStatus,
      code: 'stopped',
      runtimeAdmission: exact.runtimeAdmission,
    };
  }

  async resume(input: {
    teamName: string;
    memberName: string;
  }): Promise<MemberWorkSyncRecoveryCommandResult> {
    return runMemberWorkSyncStatusMutation(this.deps, (mutationId) =>
      this.mutate(input, mutationId, (status, nowIso) => {
        const existing = status.recoveryHealth?.pendingRuntimeControl;
        if (existing && !existing.stopped) return status;
        if (!existing?.stopped) {
          return {
            ...status,
            recoveryHealth: clearMemberWorkSyncStopLatch({ previous: status.recoveryHealth }),
            evaluatedAt: nowIso,
          };
        }
        const abandoned = abandonMemberWorkSyncPendingStop({
          previous: status.recoveryHealth!,
          checkpoint: existing,
          retire: true,
        });
        const controlRevision = nextMemberWorkSyncControlRevision(status.recoveryHealth);
        const requestId = `resume-${controlRevision}-${this.deps.hash.sha256Hex(
          JSON.stringify([
            existing.incarnation,
            existing.runtimeInstanceId,
            controlRevision,
            existing.requestId,
          ])
        )}`;
        return {
          ...status,
          recoveryHealth: {
            ...abandoned,
            controlRevision,
            // Admission stays closed until this higher ordered Resume is ACKed and finalized.
            autoResumeStopLatch: status.recoveryHealth!.autoResumeStopLatch!,
            pendingRuntimeControl: {
              teamName: input.teamName,
              memberName: input.memberName,
              incarnation: existing.incarnation,
              runtimeInstanceId: existing.runtimeInstanceId,
              requestId,
              controlRevision,
              stopped: false,
              issuedAt: nowIso,
              reason: 'user_resume',
            },
          },
          evaluatedAt: nowIso,
        };
      })
    ).then(async (status) => {
      await invalidateStaleMemberWorkSyncInboxNudges(this.deps, status);
      const controlRevision = status.recoveryHealth?.controlRevision ?? 1;
      const pendingResume = status.recoveryHealth?.pendingRuntimeControl;
      const runtimeAdmission = await this.syncRuntimeControl({
        teamName: input.teamName,
        memberName: input.memberName,
        teamIncarnation: status.statusRevision?.incarnation ?? 'legacy',
        stopped: false,
        controlRevision,
        ...(pendingResume && !pendingResume.stopped
          ? {
              runtimeInstanceId: pendingResume.runtimeInstanceId,
              requestId: pendingResume.requestId,
              issuedAt: pendingResume.issuedAt,
            }
          : {}),
      });
      const persisted =
        pendingResume && !pendingResume.stopped
          ? await this.finalizePendingResume(input, pendingResume, runtimeAdmission)
          : await this.persistRuntimeAdmission(input, controlRevision, runtimeAdmission);
      return {
        ok: true as const,
        status: persisted,
        code: 'resumed' as const,
        runtimeAdmission,
      };
    });
  }

  async continueManually(input: {
    teamName: string;
    memberName: string;
    idempotencyKey?: string;
  }): Promise<MemberWorkSyncRecoveryCommandResult> {
    return runMemberWorkSyncStatusMutation(this.deps, async (mutationId) => {
      const read = await readMemberWorkSyncStatus(this.deps, input);
      if (!read.status) {
        return { ok: false as const, code: 'status_missing' as const };
      }
      if (read.status.recoveryHealth?.autoResumeStopLatch) {
        return { ok: false as const, code: 'member_stopped' as const };
      }
      const existing = read.status.recoveryHealth?.unresolvedIntentId;
      const hadUnresolvedIntent = Boolean(existing);
      if (!existing && this.deps.busySignal) {
        const busy = await this.deps.busySignal.isBusy({
          teamName: input.teamName,
          memberName: input.memberName,
          nowIso: this.deps.clock.now().toISOString(),
        });
        if (busy.busy) {
          return { ok: false as const, code: 'member_busy' as const };
        }
      }
      const outboxStore = this.deps.outboxStore;
      if (!outboxStore) {
        return { ok: false as const, code: 'outbox_unavailable' as const };
      }
      const baseInput = buildMemberWorkSyncOutboxEnsureInput({
        status: read.status,
        hash: this.deps.hash,
        nowIso: this.deps.clock.now().toISOString(),
      });
      if (!baseInput) {
        return { ok: false as const, code: 'status_not_nudgeable' as const };
      }
      const buildRecoveryInput = (intentKey: string, id: string) => {
        const payload = {
          ...baseInput.payload,
          workSyncIntentKey: intentKey,
        };
        return {
          ...baseInput,
          payload,
          payloadHash: buildMemberWorkSyncNudgePayloadHash(this.deps.hash, payload),
          id,
        };
      };
      const attachReservation = async (
        recoveryInput: ReturnType<typeof buildRecoveryInput>,
        previous: MemberWorkSyncStatus
      ) => {
        const nowIso = this.deps.clock.now().toISOString();
        const controlRevision =
          previous.recoveryHealth?.controlRevision ??
          previous.recoveryHealth?.autoResumeStopLatch?.controlRevision ??
          1;
        const reserved = {
          ...previous,
          recoveryHealth: attachMemberWorkSyncRecoveryReservation({
            previous: previous.recoveryHealth,
            reservation: {
              intentId: recoveryInput.id,
              episodeId: previous.recoveryHealth?.episodes[0]?.episodeId ?? `manual:${nowIso}`,
              trigger: 'manual' as const,
              reservedAt: nowIso,
              state: 'reserved' as const,
              payloadHash: recoveryInput.payloadHash,
              controlRevision,
            },
          }),
          evaluatedAt: nowIso,
        };
        return (await commitMemberWorkSyncStatus(this.deps, read, reserved, mutationId)).status;
      };
      const defaultIntentKey = `manual-continue:${input.idempotencyKey?.trim() || 'default'}`;
      let recoveryInput = buildRecoveryInput(
        defaultIntentKey,
        `${baseInput.id}:${defaultIntentKey}`
      );
      if (!hadUnresolvedIntent) {
        const leftover = await outboxStore.readItem?.({
          teamName: input.teamName,
          memberName: input.memberName,
          id: recoveryInput.id,
        });
        if (
          leftover &&
          (leftover.status === 'delivered' ||
            leftover.status === 'superseded' ||
            leftover.status === 'claimed')
        ) {
          const retryKey = `${defaultIntentKey}:${mutationId}`;
          recoveryInput = buildRecoveryInput(retryKey, `${baseInput.id}:${retryKey}`);
        }
      }
      if (hadUnresolvedIntent && existing) {
        const existingItem = await outboxStore.readItem?.({
          teamName: input.teamName,
          memberName: input.memberName,
          id: existing,
        });
        const existingKey = existingItem?.payload.workSyncIntentKey;
        const preserveExistingEnvelope =
          existingItem != null &&
          existingKey !== undefined &&
          existingItem.status !== 'superseded' &&
          existingItem.status !== 'failed_terminal';
        recoveryInput =
          existingItem && existingKey && preserveExistingEnvelope
            ? {
                ...baseInput,
                id: existingItem.id,
                agendaFingerprint: existingItem.agendaFingerprint,
                payload: {
                  ...existingItem.payload,
                  workSyncIntentKey: existingKey,
                },
                payloadHash: existingItem.payloadHash,
              }
            : buildRecoveryInput(defaultIntentKey, existing);
      }
      let ensured = await outboxStore.ensurePending(recoveryInput);
      // Inbox delivery is not settlement. Keep an unresolved delivered slot.
      // Allocate a new id only after terminal failure, payload conflict, or a
      // leftover delivered row whose slot was already released.
      const needsFreshIntent =
        !ensured.ok ||
        ensured.item.status === 'failed_terminal' ||
        (!hadUnresolvedIntent && ensured.item.status === 'delivered');
      if (needsFreshIntent) {
        const retryKey = `${defaultIntentKey}:${mutationId}`;
        recoveryInput = buildRecoveryInput(retryKey, `${baseInput.id}:${retryKey}`);
      }
      let committedStatus = read.status;
      if (!hadUnresolvedIntent || needsFreshIntent) {
        const previous =
          needsFreshIntent && hadUnresolvedIntent && committedStatus.recoveryHealth
            ? {
                ...committedStatus,
                recoveryHealth: {
                  ...committedStatus.recoveryHealth,
                  reservations: (committedStatus.recoveryHealth.reservations ?? []).map(
                    (reservation) =>
                      reservation.intentId === existing
                        ? { ...reservation, state: 'resolved' as const }
                        : reservation
                  ),
                },
              }
            : committedStatus;
        committedStatus = await attachReservation(recoveryInput, previous);
      }
      if (needsFreshIntent) {
        ensured = await outboxStore.ensurePending(recoveryInput);
      }
      if (!ensured.ok) {
        return { ok: false as const, code: 'payload_conflict' as const };
      }
      return { ok: true as const, status: committedStatus, code: 'continued' as const };
    });
  }

  async recordStallObservation(input: {
    teamName: string;
    memberName: string;
    taskId: string;
    reason: string;
    observedAt?: string;
  }): Promise<MemberWorkSyncRecoveryCommandResult> {
    return runMemberWorkSyncStatusMutation(this.deps, (mutationId) =>
      this.mutate(input, mutationId, (status, nowIso) => {
        const observedAt = input.observedAt ?? nowIso;
        const episodes = status.recoveryHealth?.episodes ?? [];
        let matched = false;
        let promoted = false;
        const nextEpisodes = episodes.map((episode) => {
          if (episode.taskId !== input.taskId) {
            return episode;
          }
          if (Date.parse(observedAt) < Date.parse(episode.firstObservedAt)) {
            return episode;
          }
          matched = true;
          if (episode.phase === 'expected_wait') {
            return episode;
          }
          promoted = true;
          return {
            ...episode,
            reason: episode.reason === 'queued' ? episode.reason : 'no_progress_deadline',
            phase: 'attention' as const,
          };
        });
        if (!matched) {
          const error = new Error('episode_missing');
          error.name = 'MemberWorkSyncStallEpisodeMissingError';
          throw error;
        }
        const attentionAt = promoted
          ? (status.recoveryHealth?.attentionAt ?? observedAt)
          : status.recoveryHealth?.attentionAt;
        return {
          ...status,
          recoveryHealth: {
            schemaVersion: 1 as const,
            episodes: nextEpisodes,
            ...(status.recoveryHealth?.unresolvedIntentId
              ? { unresolvedIntentId: status.recoveryHealth.unresolvedIntentId }
              : {}),
            ...(attentionAt ? { attentionAt } : {}),
            ...(status.recoveryHealth?.autoResumeStopLatch
              ? { autoResumeStopLatch: status.recoveryHealth.autoResumeStopLatch }
              : {}),
            ...(typeof status.recoveryHealth?.controlRevision === 'number'
              ? { controlRevision: status.recoveryHealth.controlRevision }
              : {}),
            ...(status.recoveryHealth?.reservations
              ? { reservations: status.recoveryHealth.reservations }
              : {}),
            ...(status.recoveryHealth?.durableStopReceipts
              ? { durableStopReceipts: status.recoveryHealth.durableStopReceipts }
              : {}),
            ...(status.recoveryHealth?.pendingRuntimeControl
              ? { pendingRuntimeControl: status.recoveryHealth.pendingRuntimeControl }
              : {}),
            ...(status.recoveryHealth?.retiredStopFilter
              ? { retiredStopFilter: status.recoveryHealth.retiredStopFilter }
              : {}),
          },
          evaluatedAt: nowIso,
        };
      })
    ).then((status) => ({ ok: true as const, status, code: 'observed' as const }));
  }

  private async mutate(
    input: { teamName: string; memberName: string; expectedIncarnation?: string },
    mutationId: string | undefined,
    next: (status: MemberWorkSyncStatus, nowIso: string) => MemberWorkSyncStatus
  ): Promise<MemberWorkSyncStatus> {
    const read = await readMemberWorkSyncStatus(this.deps, input);
    if (!read.status) {
      const error = new Error('status_missing');
      error.name = 'MemberWorkSyncStatusMissingError';
      throw error;
    }
    const expectedIncarnation = input.expectedIncarnation?.trim();
    if (
      expectedIncarnation &&
      (read.status.statusRevision?.incarnation !== expectedIncarnation ||
        (read.snapshot && read.snapshot.incarnation !== expectedIncarnation))
    ) {
      throw new MemberWorkSyncStaleIncarnationError();
    }
    const nowIso = this.deps.clock.now().toISOString();
    const committed = await commitMemberWorkSyncStatus(
      this.deps,
      read,
      next(read.status, nowIso),
      mutationId
    );
    return committed.status;
  }

  private async persistRuntimeAdmission(
    input: { teamName: string; memberName: string },
    expectedControlRevision: number,
    runtimeAdmission: MemberWorkSyncRuntimeAdmissionOutcome
  ): Promise<MemberWorkSyncStatus> {
    return runMemberWorkSyncStatusMutation(this.deps, (mutationId) =>
      this.mutate(input, mutationId, (status) => {
        const currentRevision =
          status.recoveryHealth?.controlRevision ??
          status.recoveryHealth?.autoResumeStopLatch?.controlRevision ??
          1;
        if (currentRevision !== expectedControlRevision) {
          return status;
        }
        return { ...status, runtimeAdmission };
      })
    );
  }

  private async syncRuntimeControl(input: {
    teamName: string;
    memberName: string;
    teamIncarnation?: string;
    stopped: boolean;
    controlRevision: number;
    runtimeInstanceId?: string;
    requestId?: string;
    issuedAt?: string;
  }): Promise<MemberWorkSyncRuntimeAdmissionOutcome> {
    if (!this.deps.runtimeTicketAdmission?.syncControl) {
      return { state: 'unknown' };
    }
    const result = await this.deps.runtimeTicketAdmission.syncControl({
      teamName: input.teamName,
      memberName: input.memberName,
      teamIncarnation: input.teamIncarnation,
      runtimeInstanceId: input.runtimeInstanceId ?? '',
      controlRevision: input.controlRevision,
      stopped: input.stopped,
      ...(input.requestId ? { requestId: input.requestId } : {}),
      ...(input.issuedAt ? { issuedAt: input.issuedAt } : {}),
    });
    if (result.ok) {
      return { state: 'applied', controlRevision: result.controlRevision };
    }
    if (result.code === 'superseded') {
      return { state: 'superseded', controlRevision: input.controlRevision };
    }
    return { state: result.code === 'conflict' ? 'unknown' : 'pending' };
  }

  private finalizePendingResume(
    input: { teamName: string; memberName: string },
    checkpoint: MemberWorkSyncPendingRuntimeControl,
    runtimeAdmission: MemberWorkSyncRuntimeAdmissionOutcome
  ): Promise<MemberWorkSyncStatus> {
    return runMemberWorkSyncStatusMutation(this.deps, (mutationId) =>
      this.mutate(input, mutationId, (status) => {
        const pending = status.recoveryHealth?.pendingRuntimeControl;
        if (
          !pending ||
          pending.requestId !== checkpoint.requestId ||
          pending.teamName !== checkpoint.teamName ||
          pending.memberName !== checkpoint.memberName ||
          pending.controlRevision !== checkpoint.controlRevision ||
          pending.runtimeInstanceId !== checkpoint.runtimeInstanceId ||
          pending.incarnation !== checkpoint.incarnation ||
          pending.issuedAt !== checkpoint.issuedAt ||
          pending.reason !== checkpoint.reason ||
          pending.localStopId !== checkpoint.localStopId ||
          pending.stopped ||
          checkpoint.stopped ||
          status.recoveryHealth?.controlRevision !== checkpoint.controlRevision
        ) {
          return status;
        }
        if (runtimeAdmission.state !== 'applied') {
          return { ...status, runtimeAdmission };
        }
        const {
          pendingRuntimeControl: _pending,
          autoResumeStopLatch: _latch,
          ...health
        } = status.recoveryHealth!;
        return {
          ...status,
          recoveryHealth: health,
          runtimeAdmission,
        };
      })
    );
  }
}

export async function invalidateStaleMemberWorkSyncInboxNudges(
  deps: MemberWorkSyncUseCaseDeps,
  status: MemberWorkSyncStatus
): Promise<{ invalidated: number; messageIds: string[] }> {
  const beforeControlRevision = status.recoveryHealth?.controlRevision;
  if (typeof beforeControlRevision !== 'number') {
    return { invalidated: 0, messageIds: [] };
  }
  const result = await deps.inboxNudge?.invalidateDeliveredNudges?.({
    teamName: status.teamName,
    memberName: status.memberName,
    beforeControlRevision,
  });
  return {
    invalidated: result?.invalidated ?? 0,
    messageIds: result?.messageIds ?? [],
  };
}

async function retireRevokedDeliveredRecovery(
  deps: MemberWorkSyncUseCaseDeps,
  status: MemberWorkSyncStatus,
  revokedMessageIds: string[]
): Promise<MemberWorkSyncStatus> {
  const intentId = status.recoveryHealth?.unresolvedIntentId;
  if (!intentId || revokedMessageIds.length === 0 || !deps.outboxStore?.readItem) {
    return status;
  }
  const item = await deps.outboxStore.readItem({
    teamName: status.teamName,
    memberName: status.memberName,
    id: intentId,
  });
  if (!item || (item.status !== 'delivered' && item.status !== 'claimed')) {
    return status;
  }
  const deliveredId = item.deliveredMessageId ?? item.id;
  if (!revokedMessageIds.includes(deliveredId) && !revokedMessageIds.includes(item.id)) {
    return status;
  }
  if (item.status === 'claimed') {
    await deps.outboxStore.markSuperseded({
      teamName: status.teamName,
      id: item.id,
      reason: 'inbox_revoked',
      nowIso: deps.clock.now().toISOString(),
    });
  }
  const retired = await retireMemberWorkSyncRecoveryIntent({
    deps,
    teamName: status.teamName,
    memberName: status.memberName,
    intentId,
    receiptId: `inbox-revoked:${intentId}`,
  });
  return retired ?? status;
}

export function isAutomaticRecoveryAllocationEnabled(deps: MemberWorkSyncUseCaseDeps): boolean {
  return isMemberWorkSyncRecoveryAllocationEnabled(deps);
}
