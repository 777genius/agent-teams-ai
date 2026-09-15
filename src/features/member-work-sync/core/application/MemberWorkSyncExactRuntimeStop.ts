import {
  abandonMemberWorkSyncPendingStop,
  assertValidMemberWorkSyncRuntimeControlReason,
  completeMemberWorkSyncPendingStop,
  findMemberWorkSyncDurableStopReceipt,
  isMatchingMemberWorkSyncPendingStop,
  isMemberWorkSyncStopRetired,
  prepareMemberWorkSyncPendingStop,
} from '../domain';

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

export interface MemberWorkSyncRuntimeAdmissionOutcome {
  state: 'applied' | 'pending' | 'unknown' | 'superseded';
  controlRevision?: number;
}

export class MemberWorkSyncStaleIncarnationError extends Error {
  constructor() {
    super('stale_runtime_incarnation');
    this.name = 'MemberWorkSyncStaleIncarnationError';
  }
}

export class MemberWorkSyncStaleRuntimeInstanceError extends Error {
  constructor() {
    super('stale_runtime_instance');
    this.name = 'MemberWorkSyncStaleRuntimeInstanceError';
  }
}

export class MemberWorkSyncRuntimeControlUnavailableError extends Error {
  constructor() {
    super('runtime_control_unavailable');
    this.name = 'MemberWorkSyncRuntimeControlUnavailableError';
  }
}

export interface ExactRuntimeStopInput {
  teamName: string;
  memberName: string;
  reason?: string;
  expectedIncarnation?: string;
  expectedRuntimeInstanceId: string;
  localStopId: string;
}

interface PreparedStop {
  status: MemberWorkSyncStatus;
  checkpoint?: MemberWorkSyncPendingRuntimeControl & { stopped: true; localStopId: string };
  retirementUncertain?: true;
}

function scopeOf(input: ExactRuntimeStopInput, incarnation: string) {
  return {
    teamName: input.teamName,
    memberName: input.memberName,
    incarnation,
    runtimeInstanceId: input.expectedRuntimeInstanceId,
    localStopId: input.localStopId,
  };
}

function isSameRuntimeControlCheckpoint(
  current: MemberWorkSyncPendingRuntimeControl | undefined,
  checkpoint: MemberWorkSyncPendingRuntimeControl
): boolean {
  return Boolean(
    current &&
    current.teamName === checkpoint.teamName &&
    current.memberName === checkpoint.memberName &&
    current.incarnation === checkpoint.incarnation &&
    current.runtimeInstanceId === checkpoint.runtimeInstanceId &&
    current.requestId === checkpoint.requestId &&
    current.controlRevision === checkpoint.controlRevision &&
    current.stopped === checkpoint.stopped &&
    current.issuedAt === checkpoint.issuedAt &&
    current.reason === checkpoint.reason &&
    current.localStopId === checkpoint.localStopId
  );
}

export class MemberWorkSyncExactRuntimeStop {
  constructor(private readonly deps: MemberWorkSyncUseCaseDeps) {}

  async execute(input: ExactRuntimeStopInput): Promise<{
    status: MemberWorkSyncStatus;
    runtimeAdmission: MemberWorkSyncRuntimeAdmissionOutcome;
  }> {
    const reason = normalizeMemberWorkSyncRuntimeControlReason(input.reason, 'runtime_local_stop');
    assertValidMemberWorkSyncRuntimeControlReason(reason);
    const prepared = await this.prepare({ ...input, reason });
    if (prepared.retirementUncertain) {
      // The retirement filter is only a bounded replay hint. A positive match may be a
      // collision, so retain the durable Stop fence but never report it as an applied Stop.
      throw new MemberWorkSyncRuntimeControlUnavailableError();
    }
    if (!prepared.checkpoint) {
      return {
        status: prepared.status,
        runtimeAdmission: prepared.status.runtimeAdmission ?? { state: 'applied' },
      };
    }
    let admission: MemberWorkSyncRuntimeAdmissionOutcome;
    try {
      admission = await this.apply(prepared.checkpoint);
    } catch (error) {
      if (error instanceof MemberWorkSyncStaleRuntimeInstanceError) {
        await this.abandon(prepared.checkpoint, true);
      }
      throw error;
    }
    return this.finalize(prepared.checkpoint, admission);
  }

  private prepare(input: ExactRuntimeStopInput & { reason: string }): Promise<PreparedStop> {
    return runMemberWorkSyncStatusMutation(this.deps, async (mutationId) => {
      const read = await readMemberWorkSyncStatus(this.deps, input);
      if (!read.status) {
        const error = new Error('status_missing');
        error.name = 'MemberWorkSyncStatusMissingError';
        throw error;
      }
      const incarnation = input.expectedIncarnation?.trim();
      if (
        !incarnation ||
        incarnation.length > 256 ||
        input.teamName.length > 256 ||
        input.memberName.length > 256 ||
        read.status.statusRevision?.incarnation !== incarnation ||
        (read.snapshot && read.snapshot.incarnation !== incarnation)
      ) {
        throw new MemberWorkSyncStaleIncarnationError();
      }
      const scope = scopeOf(input, incarnation);
      if (findMemberWorkSyncDurableStopReceipt(read.status.recoveryHealth, scope)) {
        return { status: read.status };
      }
      const existing = read.status.recoveryHealth?.pendingRuntimeControl;
      if (isMemberWorkSyncStopRetired(read.status.recoveryHealth, scope)) {
        if (isMatchingMemberWorkSyncPendingStop(existing, scope)) {
          return { status: read.status, retirementUncertain: true };
        }
        if (existing) throw new MemberWorkSyncRuntimeControlUnavailableError();
        if (read.status.recoveryHealth?.autoResumeStopLatch) {
          // Admission is already fenced. Preserve the newer Stop revision and reason;
          // the probabilistic retirement match cannot authorize superseding it.
          return { status: read.status, retirementUncertain: true };
        }
        const issuedAt = this.deps.clock.now().toISOString();
        const recoveryHealth = prepareMemberWorkSyncPendingStop({
          previous: read.status.recoveryHealth,
          checkpoint: {
            ...scope,
            requestId: input.localStopId,
            issuedAt,
            reason: input.reason,
          },
        });
        const committed = await commitMemberWorkSyncStatus(
          this.deps,
          read,
          {
            ...read.status,
            recoveryHealth,
            runtimeAdmission: { state: 'unknown' },
            evaluatedAt: issuedAt,
          },
          mutationId
        );
        return { status: committed.status, retirementUncertain: true };
      }
      if (isMatchingMemberWorkSyncPendingStop(existing, scope)) {
        return { status: read.status, checkpoint: existing };
      }
      if (existing) throw new MemberWorkSyncRuntimeControlUnavailableError();
      const issuedAt = this.deps.clock.now().toISOString();
      const recoveryHealth = prepareMemberWorkSyncPendingStop({
        previous: read.status.recoveryHealth,
        checkpoint: {
          ...scope,
          requestId: input.localStopId,
          issuedAt,
          reason: input.reason,
        },
      });
      const committed = await commitMemberWorkSyncStatus(
        this.deps,
        read,
        { ...read.status, recoveryHealth, evaluatedAt: issuedAt },
        mutationId
      );
      const checkpoint = committed.status.recoveryHealth?.pendingRuntimeControl;
      if (!isMatchingMemberWorkSyncPendingStop(checkpoint, scope)) {
        throw new MemberWorkSyncRuntimeControlUnavailableError();
      }
      return { status: committed.status, checkpoint };
    });
  }

  private async apply(
    checkpoint: MemberWorkSyncPendingRuntimeControl & { stopped: true; localStopId: string }
  ): Promise<MemberWorkSyncRuntimeAdmissionOutcome> {
    const admission = this.deps.runtimeTicketAdmission;
    if (!admission?.syncControl || !admission.readLiveControl) {
      throw new MemberWorkSyncRuntimeControlUnavailableError();
    }
    const before = await admission.readLiveControl(checkpoint);
    if (before && before.runtimeInstanceId !== checkpoint.runtimeInstanceId) {
      throw new MemberWorkSyncStaleRuntimeInstanceError();
    }
    if (before && before.controlRevision > checkpoint.controlRevision) {
      return { state: 'superseded', controlRevision: before.controlRevision };
    }
    if (
      before?.stopped === true &&
      before.controlRevision === checkpoint.controlRevision &&
      before.requestId === checkpoint.requestId
    ) {
      return { state: 'applied', controlRevision: checkpoint.controlRevision };
    }
    const result = await admission.syncControl({
      teamName: checkpoint.teamName,
      memberName: checkpoint.memberName,
      teamIncarnation: checkpoint.incarnation,
      runtimeInstanceId: checkpoint.runtimeInstanceId,
      controlRevision: checkpoint.controlRevision,
      stopped: true,
      requestId: checkpoint.requestId,
      issuedAt: checkpoint.issuedAt,
    });
    if (!result.ok) {
      if (result.code === 'instance_mismatch') throw new MemberWorkSyncStaleRuntimeInstanceError();
      if (result.code === 'superseded') {
        return { state: 'superseded', controlRevision: checkpoint.controlRevision };
      }
      throw new MemberWorkSyncRuntimeControlUnavailableError();
    }
    const after = await admission.readLiveControl(checkpoint);
    if (after?.runtimeInstanceId !== checkpoint.runtimeInstanceId) {
      if (after) throw new MemberWorkSyncStaleRuntimeInstanceError();
      throw new MemberWorkSyncRuntimeControlUnavailableError();
    }
    if (
      !after.stopped ||
      after.controlRevision !== checkpoint.controlRevision ||
      after.requestId !== checkpoint.requestId
    ) {
      throw new MemberWorkSyncRuntimeControlUnavailableError();
    }
    return { state: 'applied', controlRevision: checkpoint.controlRevision };
  }

  private finalize(
    checkpoint: MemberWorkSyncPendingRuntimeControl & { stopped: true; localStopId: string },
    admission: MemberWorkSyncRuntimeAdmissionOutcome
  ): Promise<{
    status: MemberWorkSyncStatus;
    runtimeAdmission: MemberWorkSyncRuntimeAdmissionOutcome;
  }> {
    return runMemberWorkSyncStatusMutation(this.deps, async (mutationId) => {
      const read = await readMemberWorkSyncStatus(this.deps, checkpoint);
      if (!read.status) throw new MemberWorkSyncRuntimeControlUnavailableError();
      const current = read.status.recoveryHealth?.pendingRuntimeControl;
      if (
        !isMatchingMemberWorkSyncPendingStop(current, checkpoint) ||
        !isSameRuntimeControlCheckpoint(current, checkpoint)
      ) {
        return {
          status: read.status,
          runtimeAdmission: { state: 'superseded', controlRevision: checkpoint.controlRevision },
        };
      }
      if (admission.state !== 'applied') {
        return { status: read.status, runtimeAdmission: admission };
      }
      const appliedAt = this.deps.clock.now().toISOString();
      const recoveryHealth = completeMemberWorkSyncPendingStop({
        previous: read.status.recoveryHealth!,
        checkpoint: current,
        appliedAt,
      });
      const runtimeAdmission = {
        state: 'applied' as const,
        controlRevision: checkpoint.controlRevision,
      };
      const committed = await commitMemberWorkSyncStatus(
        this.deps,
        read,
        { ...read.status, recoveryHealth, runtimeAdmission, evaluatedAt: appliedAt },
        mutationId
      );
      return { status: committed.status, runtimeAdmission };
    });
  }

  private abandon(
    checkpoint: MemberWorkSyncPendingRuntimeControl,
    retire: boolean
  ): Promise<MemberWorkSyncStatus | null> {
    return runMemberWorkSyncStatusMutation(this.deps, async (mutationId) => {
      const read = await readMemberWorkSyncStatus(this.deps, checkpoint);
      if (!read.status) return null;
      if (
        !isSameRuntimeControlCheckpoint(
          read.status.recoveryHealth?.pendingRuntimeControl,
          checkpoint
        )
      ) {
        return read.status;
      }
      const recoveryHealth = abandonMemberWorkSyncPendingStop({
        previous: read.status.recoveryHealth,
        checkpoint,
        retire,
      });
      return (
        await commitMemberWorkSyncStatus(
          this.deps,
          read,
          { ...read.status, recoveryHealth },
          mutationId
        )
      ).status;
    });
  }
}
