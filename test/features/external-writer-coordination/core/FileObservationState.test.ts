import {
  buildExternalFileReconciliationId,
  FileObservationState,
  type FileObservationStateCheckpoint,
  FileObservationStateError,
} from '@features/external-writer-coordination';
import { parseTeamId } from '@shared/contracts/hosted/identifiers';
import { describe, expect, it } from 'vitest';

const teamId = parseTeamId('team_11111111111111111111111111111111');
const otherTeamId = parseTeamId('team_44444444444444444444444444444444');
const scope = { teamId, featureKey: 'tasks' } as const;
const otherScope = { teamId: otherTeamId, featureKey: 'messages' } as const;
const limits = {
  maxPendingObservations: 2,
  maxSelfWriteIntents: 2,
  maxObservationAttempts: 2,
  maxScopes: 2,
  maxObservedFiles: 4,
};
const fingerprint = {
  exists: true,
  checksum: 'hash-0',
  statIdentity: {
    byteLength: 1,
    device: 'device-1',
    inode: 'inode-1',
    modifiedTimeNs: '1',
    changedTimeNs: '1',
  },
} as const;

describe('FileObservationState', () => {
  it('keeps a contiguous watermark when coalesced file ranges cross another file', () => {
    const state = FileObservationState.create(limits);
    const firstA = state.enqueueObservation({ scope, fileKey: 'a', cause: 'change' });
    const onlyB = state.enqueueObservation({ scope, fileKey: 'b', cause: 'change' });
    const secondA = state.enqueueObservation({ scope, fileKey: 'a', cause: 'rename' });

    expect(firstA.sequence).toBe(1);
    expect(onlyB.sequence).toBe(2);
    expect(secondA).toMatchObject({ outcome: 'coalesced', sequence: 3, id: firstA.id });
    expect(state.getObservationWatermark()).toBe(0);

    state.completePending(firstA.id!, secondA.sequence);
    expect(state.getObservationWatermark()).toBe(1);
    state.completePending(onlyB.id!, onlyB.sequence);
    expect(state.getObservationWatermark()).toBe(3);
  });

  it('preserves a newer coalesced notification when older claimed work completes', () => {
    const state = FileObservationState.create(limits);
    state.enqueueObservation({ scope, fileKey: 'a', cause: 'change' });
    const claimed = state.takeNextPending()!;
    const crossing = state.enqueueObservation({ scope, fileKey: 'a', cause: 'rename' });

    expect(state.completePending(claimed.id, claimed.latestSequence)).toBe('newer_pending');
    expect(state.getPendingObservation(claimed.id)).toMatchObject({
      earliestSequence: crossing.sequence,
      latestSequence: crossing.sequence,
      attempts: 0,
    });
    expect(state.getObservationWatermark()).toBe(claimed.latestSequence);

    expect(state.completePending(claimed.id, crossing.sequence)).toBe('completed');
    expect(state.getPendingObservation(claimed.id)).toBeNull();
    expect(state.getObservationWatermark()).toBe(crossing.sequence);
  });

  it('keeps durable reconciliation IDs distinct when two paths share epoch and earliest sequence', () => {
    const state = FileObservationState.create(limits);
    const firstA = state.enqueueObservation({ scope, fileKey: 'a', cause: 'change' });
    const onlyB = state.enqueueObservation({ scope, fileKey: 'b', cause: 'change' });
    state.enqueueObservation({ scope, fileKey: 'a', cause: 'rename' });

    expect(state.completePending(firstA.id!, firstA.sequence)).toBe('newer_pending');
    const pendingA = state.getPendingObservation(firstA.id!)!;
    const pendingB = state.getPendingObservation(onlyB.id!)!;
    expect(pendingA).toMatchObject({ fileWriterEpoch: 1, earliestSequence: 2 });
    expect(pendingB).toMatchObject({ fileWriterEpoch: 1, earliestSequence: 2 });

    const reconciliationIdA = buildExternalFileReconciliationId(
      pendingA.scope,
      pendingA.fileKey,
      pendingA.fileWriterEpoch,
      pendingA.earliestSequence
    );
    const reconciliationIdB = buildExternalFileReconciliationId(
      pendingB.scope,
      pendingB.fileKey,
      pendingB.fileWriterEpoch,
      pendingB.earliestSequence
    );
    state.beginPendingReconciliation({
      pendingId: pendingA.id,
      reconciliationId: reconciliationIdA,
      throughSequence: pendingA.earliestSequence,
      fingerprint,
      actor: {
        kind: 'external_file',
        teamId,
        featureKey: scope.featureKey,
        fileKey: pendingA.fileKey,
        checksum: fingerprint.checksum,
        observationSequence: pendingA.earliestSequence,
      },
    });
    state.beginPendingReconciliation({
      pendingId: pendingB.id,
      reconciliationId: reconciliationIdB,
      throughSequence: pendingB.earliestSequence,
      fingerprint,
      actor: {
        kind: 'external_file',
        teamId,
        featureKey: scope.featureKey,
        fileKey: pendingB.fileKey,
        checksum: fingerprint.checksum,
        observationSequence: pendingB.earliestSequence,
      },
    });

    expect(reconciliationIdA).not.toBe(reconciliationIdB);
    const restored = FileObservationState.restore(state.snapshot(), limits);
    expect(
      restored
        .snapshot()
        .pendingObservations.map((pending) => pending.reconciliation?.reconciliationId)
    ).toEqual([reconciliationIdA, reconciliationIdB]);
  });

  it('turns queue overflow into a persisted dirty scope until a scoped rescan repairs it', () => {
    const state = FileObservationState.create({ ...limits, maxPendingObservations: 1 });
    const first = state.enqueueObservation({ scope, fileKey: 'a', cause: 'change' });
    const overflow = state.enqueueObservation({ scope, fileKey: 'b', cause: 'change' });

    expect(overflow).toMatchObject({ outcome: 'overflow_dirty', sequence: 2, id: null });
    expect(state.getDirtyScopes()).toEqual([
      expect.objectContaining({
        scope,
        reasons: ['notification_overflow'],
        earliestSequence: 2,
        latestSequence: 2,
      }),
    ]);

    state.completePending(first.id!, first.sequence);
    expect(state.getObservationWatermark()).toBe(1);
    expect(state.markScopeRescanned(scope, 1)).toBe(false);
    expect(state.markScopeRescanned(scope, 2)).toBe(true);
    expect(state.getObservationWatermark()).toBe(2);
  });

  it('suppresses only the exact next checksum and invalidates stale intent on a crossing write', () => {
    const state = FileObservationState.create(limits);
    state.addSelfWriteIntent({
      intentId: 'intent-1',
      scope,
      fileKey: 'task-1',
      expectedChecksum: 'self-checksum',
      sourceGeneration: 7,
      fileWriterEpoch: 1,
      expiresAtMs: 100,
    });

    expect(
      state.matchSelfWriteChecksum({
        scope,
        fileKey: 'task-1',
        checksum: 'hostile-checksum',
        fileWriterEpoch: 1,
        nowMs: 10,
      })
    ).toEqual({ outcome: 'mismatch', intent: null });
    expect(
      state.matchSelfWriteChecksum({
        scope,
        fileKey: 'task-1',
        checksum: 'self-checksum',
        fileWriterEpoch: 1,
        nowMs: 11,
      })
    ).toEqual({ outcome: 'none', intent: null });

    state.addSelfWriteIntent({
      intentId: 'intent-2',
      scope,
      fileKey: 'task-1',
      expectedChecksum: 'self-checksum',
      sourceGeneration: 8,
      fileWriterEpoch: 1,
      expiresAtMs: 100,
    });
    expect(
      state.matchSelfWriteChecksum({
        scope,
        fileKey: 'task-1',
        checksum: 'self-checksum',
        fileWriterEpoch: 1,
        nowMs: 12,
      })
    ).toMatchObject({ outcome: 'matched', intent: { sourceGeneration: 8 } });
  });

  it('round-trips sequence, watermark, dirty work, observations, and per-team epoch', () => {
    const state = FileObservationState.create(limits);
    const queued = state.enqueueObservation({ scope, fileKey: 'task-1', cause: 'change' });
    state.recordObservedFile({
      scope,
      fileKey: 'task-0',
      fingerprint,
      sourceGeneration: 4,
      fileWriterEpoch: 1,
      observationSequence: 1,
    });
    expect(() =>
      state.recordObservedFile({
        scope,
        fileKey: 'task-0',
        fingerprint,
        sourceGeneration: 3,
        fileWriterEpoch: 1,
        observationSequence: 1,
      })
    ).toThrowError(new FileObservationStateError('checkpoint_invalid'));
    const checkpoint = state.snapshot();
    const restored = FileObservationState.restore(checkpoint, limits);

    expect(restored.snapshot()).toEqual(checkpoint);
    expect(() =>
      restored.advanceFileWriterEpoch({
        teamId,
        expectedEpoch: 1,
        throughWatermark: 0,
      })
    ).toThrowError(new FileObservationStateError('epoch_not_quiescent'));

    restored.completePending(queued.id!, queued.sequence);
    expect(
      restored.advanceFileWriterEpoch({
        teamId,
        expectedEpoch: 1,
        throughWatermark: 1,
      })
    ).toBe(2);
    expect(restored.snapshot()).toMatchObject({
      lastObservationSequence: 1,
      observationWatermark: 1,
      fileWriterEpochs: [{ teamId, epoch: 2 }],
    });
  });

  it('restores a Team A watermark that advances independently of dirty Team B', () => {
    const state = FileObservationState.create(limits);
    const teamA = state.enqueueObservation({ scope, fileKey: 'task-1', cause: 'change' });
    state.completePending(teamA.id!, teamA.sequence);
    state.markScopeDirty(otherScope, 'corrupt');

    expect(state.getObservationWatermark()).toBe(1);
    expect(state.getTeamObservationWatermark(teamId)).toBe(1);
    const restored = FileObservationState.restore(state.snapshot(), limits);

    expect(
      restored.advanceFileWriterEpoch({
        teamId,
        expectedEpoch: 1,
        throughWatermark: 1,
      })
    ).toBe(2);
    expect(restored.getDirtyScopes()).toEqual([expect.objectContaining({ scope: otherScope })]);
  });

  it('rejects hostile checkpoints that forge a clean watermark over pending work', () => {
    const state = FileObservationState.create(limits);
    state.enqueueObservation({ scope, fileKey: 'task-1', cause: 'change' });
    const forged = {
      ...state.snapshot(),
      observationWatermark: 1,
    } as FileObservationStateCheckpoint;

    expect(() => FileObservationState.restore(forged, limits)).toThrowError(
      new FileObservationStateError('checkpoint_invalid')
    );
  });
});
