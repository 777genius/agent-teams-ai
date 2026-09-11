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
      if (existing) {
        return { ok: true as const, status: read.status, code: 'continued' as const };
      }
      if (this.deps.busySignal) {
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
      const intentKey = `manual-continue:${input.idempotencyKey?.trim() || 'default'}`;
      const payload = {
        ...baseInput.payload,
        workSyncIntentKey: intentKey,
      };
      const recoveryInput = {
        ...baseInput,
        payload,
        payloadHash: buildMemberWorkSyncNudgePayloadHash(this.deps.hash, payload),
        id: `${baseInput.id}:${intentKey}`,
      };
      const nowIso = this.deps.clock.now().toISOString();
      const controlRevision =
        read.status.recoveryHealth?.controlRevision ??
        read.status.recoveryHealth?.autoResumeStopLatch?.controlRevision ??
        1;
      const reserved = {
        ...read.status,
        recoveryHealth: attachMemberWorkSyncRecoveryReservation({
          previous: read.status.recoveryHealth,
          reservation: {
            intentId: recoveryInput.id,
            episodeId: read.status.recoveryHealth?.episodes[0]?.episodeId ?? `manual:${nowIso}`,
            trigger: 'manual',
            reservedAt: nowIso,
            state: 'reserved',
            payloadHash: recoveryInput.payloadHash,
            controlRevision,
          },
        }),
        evaluatedAt: nowIso,
      };
      const committed = await commitMemberWorkSyncStatus(this.deps, read, reserved, mutationId);
      const ensured = await outboxStore.ensurePending(recoveryInput);
      if (!ensured.ok) {
        return { ok: false as const, code: 'payload_conflict' as const };
      }
      return { ok: true as const, status: committed.status, code: 'continued' as const };
    });
  }

  async recordStallObservation(input: {
    teamName: string;
    memberName: string;
    taskId: string;
    reason: string;
    observedAt?: string;
  }): Promise<MemberWorkSyncRecoveryCommandResult> {
    try {
      return await runMemberWorkSyncStatusMutation(this.deps, (mutationId) =>
        this.mutate(input, mutationId, (status, nowIso) => {
          const observedAt = input.observedAt ?? nowIso;
          const episodes = status.recoveryHealth?.episodes ?? [];
          const nextEpisodes = episodes.map((episode) =>
            episode.taskId === input.taskId
              ? {
                  ...episode,
                  lastEvidenceId: `stall:${input.reason}:${observedAt}`,
                  reason: episode.reason === 'queued' ? episode.reason : 'no_progress_deadline',
                }
              : episode
          );
          return {
            ...status,
            recoveryHealth: {
              schemaVersion: 1 as const,
              episodes: nextEpisodes,
              ...(status.recoveryHealth?.unresolvedIntentId
                ? { unresolvedIntentId: status.recoveryHealth.unresolvedIntentId }
                : {}),
              ...(status.recoveryHealth?.attentionAt
                ? { attentionAt: status.recoveryHealth.attentionAt }
                : { attentionAt: observedAt }),
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
    } catch (error) {
      if (error instanceof Error && error.name === 'MemberWorkSyncStatusMissingError') {
        return { ok: false, code: 'status_missing' };
      }
      throw error;
    }
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
  return (
    isMemberWorkSyncRecoveryAllocationEnabled(deps) || (deps.recoveryProtocol?.version ?? 0) >= 1
  );
}
