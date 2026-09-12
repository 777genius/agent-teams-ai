import {
  applyMemberWorkSyncStopLatch,
  attachMemberWorkSyncRecoveryReservation,
  buildMemberWorkSyncNudgePayloadHash,
  buildMemberWorkSyncOutboxEnsureInput,
  clearMemberWorkSyncStopLatch,
} from '../domain';

import { isMemberWorkSyncRecoveryAllocationEnabled } from './MemberWorkSyncNudgeOutboxPlanHelpers';
import {
  commitMemberWorkSyncStatus,
  readMemberWorkSyncStatus,
  runMemberWorkSyncStatusMutation,
} from './MemberWorkSyncStatusMutation';

import type { MemberWorkSyncStatus } from '../../contracts';
import type { MemberWorkSyncUseCaseDeps } from './ports';

export type MemberWorkSyncRecoveryCommandResult =
  | {
      ok: true;
      status: MemberWorkSyncStatus;
      code: 'stopped' | 'resumed' | 'continued' | 'observed';
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
  }): Promise<MemberWorkSyncRecoveryCommandResult> {
    return runMemberWorkSyncStatusMutation(this.deps, (mutationId) =>
      this.mutate(input, mutationId, (status, nowIso) => ({
        ...status,
        recoveryHealth: applyMemberWorkSyncStopLatch({
          previous: status.recoveryHealth,
          nowIso,
          reason: input.reason?.trim() || 'user_stop',
        }),
        evaluatedAt: nowIso,
      }))
    ).then((status) => ({ ok: true as const, status, code: 'stopped' as const }));
  }

  async resume(input: {
    teamName: string;
    memberName: string;
  }): Promise<MemberWorkSyncRecoveryCommandResult> {
    return runMemberWorkSyncStatusMutation(this.deps, (mutationId) =>
      this.mutate(input, mutationId, (status, nowIso) => ({
        ...status,
        recoveryHealth: clearMemberWorkSyncStopLatch({ previous: status.recoveryHealth }),
        evaluatedAt: nowIso,
      }))
    ).then((status) => ({ ok: true as const, status, code: 'resumed' as const }));
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
      if (existing) {
        const existingItem = await outboxStore.readItem?.({
          teamName: input.teamName,
          memberName: input.memberName,
          id: existing,
        });
        recoveryInput = existingItem?.payload.workSyncIntentKey?.startsWith('manual-continue:')
          ? {
              ...baseInput,
              id: existingItem.id,
              agendaFingerprint: existingItem.agendaFingerprint,
              payload: existingItem.payload,
              payloadHash: existingItem.payloadHash,
            }
          : buildRecoveryInput(defaultIntentKey, existing);
      }
      let committedStatus = read.status;
      const candidateId = recoveryInput.id;
      if (!existing) {
        committedStatus = await attachReservation(recoveryInput, read.status);
      }
      let ensured = await outboxStore.ensurePending(recoveryInput);
      // Inbox delivery is not settlement. Keep an unresolved delivered slot.
      // Allocate a new id only after terminal failure, payload conflict, or a
      // leftover delivered row whose slot was already released.
      const needsFreshIntent =
        !ensured.ok ||
        ensured.item.status === 'failed_terminal' ||
        (!existing && ensured.item.status === 'delivered');
      if (needsFreshIntent) {
        const retryKey = `${defaultIntentKey}:${mutationId}`;
        recoveryInput = buildRecoveryInput(retryKey, `${baseInput.id}:${retryKey}`);
        const previous =
          !existing && committedStatus.recoveryHealth
            ? {
                ...committedStatus,
                recoveryHealth: {
                  ...committedStatus.recoveryHealth,
                  reservations: (committedStatus.recoveryHealth.reservations ?? []).map(
                    (reservation) =>
                      reservation.intentId === candidateId
                        ? { ...reservation, state: 'resolved' as const }
                        : reservation
                  ),
                },
              }
            : committedStatus;
        committedStatus = await attachReservation(recoveryInput, previous);
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
          matched = true;
          if (episode.phase === 'expected_wait') {
            return {
              ...episode,
              lastEvidenceId: `stall:${input.reason}:${observedAt}`,
            };
          }
          promoted = true;
          return {
            ...episode,
            lastEvidenceId: `stall:${input.reason}:${observedAt}`,
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
          },
          evaluatedAt: nowIso,
        };
      })
    ).then((status) => ({ ok: true as const, status, code: 'observed' as const }));
  }

  private async mutate(
    input: { teamName: string; memberName: string },
    mutationId: string | undefined,
    next: (status: MemberWorkSyncStatus, nowIso: string) => MemberWorkSyncStatus
  ): Promise<MemberWorkSyncStatus> {
    const read = await readMemberWorkSyncStatus(this.deps, input);
    if (!read.status) {
      const error = new Error('status_missing');
      error.name = 'MemberWorkSyncStatusMissingError';
      throw error;
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
}

export function isAutomaticRecoveryAllocationEnabled(deps: MemberWorkSyncUseCaseDeps): boolean {
  return isMemberWorkSyncRecoveryAllocationEnabled(deps);
}
