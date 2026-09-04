import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TeamPermanentDeletionTransactionCoordinator } from '@main/ipc/teams/TeamPermanentDeletionTransactionCoordinator';

import type { TeamPermanentDeletionTransactionCoordinatorPorts } from '@main/ipc/teams/TeamPermanentDeletionTransactionCoordinator';
import type { TeamAttachmentStore } from '@main/services/team/TeamAttachmentStore';
import type {
  TeamBackupService,
  TeamPermanentDeletionIntent,
} from '@main/services/team/TeamBackupService';
import type { TeamTaskAttachmentStore } from '@main/services/team/TeamTaskAttachmentStore';

type PermanentDeletionTarget = TeamPermanentDeletionIntent['completedTargets'][number];

const PREPARE_TIMEOUT_MS = 30_000;

function createIntent(): TeamPermanentDeletionIntent {
  return {
    version: 2,
    teamName: 'fixteam',
    identityId: '11111111-1111-4111-8111-111111111111',
    transactionId: '22222222-2222-4222-8222-222222222222',
    identityKind: 'team',
    targets: {
      'team-data': { status: 'present', identity: { dev: 1, ino: 1, birthtimeMs: 1 } },
      'task-data': { status: 'present', identity: { dev: 1, ino: 2, birthtimeMs: 2 } },
      'message-attachments': { status: 'present', identity: { dev: 1, ino: 3, birthtimeMs: 3 } },
      'task-attachments': { status: 'present', identity: { dev: 1, ino: 4, birthtimeMs: 4 } },
    },
    targetRemovalProofs: {},
    completedTargets: [],
    cleanupCompleted: false,
    phase: 'prepared',
    requestedAt: '2026-08-20T12:00:00.000Z',
    updatedAt: '2026-08-20T12:00:00.000Z',
  };
}

/**
 * A crash-recovered intent: the listed targets are already proved removed, so
 * runCleanup skips the pre-flight identity checks for them.
 */
function createRecoveredIntent(
  completedTargets: PermanentDeletionTarget[]
): TeamPermanentDeletionIntent {
  const base = createIntent();
  const targetRemovalProofs = Object.fromEntries(
    Object.entries(base.targets).flatMap(([target, observed]) =>
      completedTargets.includes(target as PermanentDeletionTarget) && observed.status === 'present'
        ? [
            [
              target,
              {
                version: 1,
                transactionId: base.transactionId,
                target,
                targetIdentity: observed.identity,
                state: 'removed',
                detachedAt: base.requestedAt,
                removedAt: base.updatedAt,
              },
            ],
          ]
        : []
    )
  ) as TeamPermanentDeletionIntent['targetRemovalProofs'];
  return { ...base, phase: 'deleting', completedTargets, targetRemovalProofs };
}

function createHarness(options: {
  prepareTeamDeletion: (
    teamName: string,
    deletionIdentityId?: string,
    prepareOptions?: { signal?: AbortSignal }
  ) => Promise<void>;
  releaseTeamScopedResources?: () => Promise<void>;
  withResourceHooks?: boolean;
  intent?: TeamPermanentDeletionIntent;
}): {
  coordinator: TeamPermanentDeletionTransactionCoordinator;
  intent: TeamPermanentDeletionIntent;
  lifecycle: {
    prepareTeamDeletion: ReturnType<typeof vi.fn>;
    completeTeamDeletion: ReturnType<typeof vi.fn>;
    resumeTeam: ReturnType<typeof vi.fn>;
  };
  permanentlyDeleteTeam: ReturnType<typeof vi.fn>;
  completePermanentDeletion: ReturnType<typeof vi.fn>;
  isPermanentDeletionTargetCurrent: ReturnType<typeof vi.fn>;
  releaseTeamScopedResources: ReturnType<typeof vi.fn>;
  restoreTeamScopedResources: ReturnType<typeof vi.fn>;
} {
  const intent = options.intent ?? createIntent();
  const lifecycle = {
    prepareTeamDeletion: vi.fn(options.prepareTeamDeletion),
    completeTeamDeletion: vi.fn(),
    resumeTeam: vi.fn(),
  };
  const permanentlyDeleteTeam = vi.fn(async () => true);
  const completePermanentDeletion = vi.fn(async () => undefined);
  const isPermanentDeletionTargetCurrent = vi.fn(async () => true);
  const backupService = {
    beginPermanentDeletion: vi.fn(async () => intent),
    commitPermanentDeletionBoundary: vi.fn(
      async (current: TeamPermanentDeletionIntent) =>
        ({ ...current, phase: 'deleting' }) as TeamPermanentDeletionIntent
    ),
    abortPreparedPermanentDeletion: vi.fn(async () => undefined),
    listPendingPermanentDeletions: vi.fn(async (): Promise<TeamPermanentDeletionIntent[]> => []),
    isPermanentDeletionTargetCurrent,
    reconcilePermanentDeletionProgress: vi.fn(
      async (current: TeamPermanentDeletionIntent) => current
    ),
    completePermanentDeletion,
    withPermanentDeletionTargetFence: vi.fn(
      (
        fencedIntent: TeamPermanentDeletionIntent,
        operation: (
          isTargetCurrent: () => Promise<boolean>,
          getTargetProofHooks: (target: PermanentDeletionTarget) => {
            detachedPath: string;
            onDetachedValidated: () => Promise<void>;
            onRemovalDurable: () => Promise<void>;
          },
          isTargetCompleted: (target: PermanentDeletionTarget) => boolean
        ) => Promise<boolean>
      ) => {
        const completed = new Set<PermanentDeletionTarget>(fencedIntent.completedTargets);
        return operation(
          async () => true,
          (target) => {
            completed.add(target);
            return {
              detachedPath: `/tmp/detached-${target}`,
              onDetachedValidated: async () => undefined,
              onRemovalDurable: async () => undefined,
            };
          },
          (target) => completed.has(target)
        );
      }
    ),
  } as unknown as TeamBackupService;

  const releaseTeamScopedResources = vi.fn(
    options.releaseTeamScopedResources ?? (async () => undefined)
  );
  const restoreTeamScopedResources = vi.fn(async () => undefined);
  const ports: TeamPermanentDeletionTransactionCoordinatorPorts = {
    backupService: () => backupService,
    dataService: () => ({ permanentlyDeleteTeam }),
    attachmentStore: {
      deleteTeamAttachments: vi.fn(async () => true),
    } as unknown as TeamAttachmentStore,
    taskAttachmentStore: {
      deleteTeamAttachments: vi.fn(async () => true),
    } as unknown as TeamTaskAttachmentStore,
    lifecycle: () => lifecycle,
    invalidateTeamConfig: vi.fn(),
    logRecoveryError: vi.fn(),
    ...(options.withResourceHooks === true
      ? { releaseTeamScopedResources, restoreTeamScopedResources }
      : {}),
  };

  return {
    coordinator: new TeamPermanentDeletionTransactionCoordinator(ports),
    intent,
    lifecycle,
    permanentlyDeleteTeam,
    completePermanentDeletion,
    isPermanentDeletionTargetCurrent,
    releaseTeamScopedResources,
    restoreTeamScopedResources,
  };
}

describe('TeamPermanentDeletionTransactionCoordinator quiesce timeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('rejects with a concrete error instead of hanging when the quiesce never settles', async () => {
    const harness = createHarness({
      prepareTeamDeletion: () => new Promise<void>(() => undefined),
    });

    const deletion = harness.coordinator.permanentlyDelete('fixteam');
    const rejection = expect(deletion).rejects.toThrow(
      `Permanent deletion of "fixteam" timed out after ${PREPARE_TIMEOUT_MS}ms waiting for team activity to quiesce`
    );
    await vi.advanceTimersByTimeAsync(PREPARE_TIMEOUT_MS);
    await rejection;

    // Nothing destructive ran, so the team is still on disk and still listed.
    expect(harness.permanentlyDeleteTeam).not.toHaveBeenCalled();
    expect(harness.completePermanentDeletion).not.toHaveBeenCalled();
    expect(harness.lifecycle.completeTeamDeletion).not.toHaveBeenCalled();
  });

  it('does not fire the timeout when the quiesce settles just under the deadline', async () => {
    const harness = createHarness({
      prepareTeamDeletion: () =>
        new Promise<void>((resolve) => setTimeout(resolve, PREPARE_TIMEOUT_MS - 1)),
    });

    const deletion = harness.coordinator.permanentlyDelete('fixteam');
    await vi.advanceTimersByTimeAsync(PREPARE_TIMEOUT_MS * 2);
    await expect(deletion).resolves.toBeUndefined();

    expect(harness.lifecycle.prepareTeamDeletion).toHaveBeenCalledWith(
      'fixteam',
      '11111111-1111-4111-8111-111111111111',
      { signal: expect.any(AbortSignal) }
    );
    expect(harness.permanentlyDeleteTeam).toHaveBeenCalledWith(
      'fixteam',
      expect.any(Function),
      expect.any(Function),
      expect.objectContaining({
        teamDataProofHooks: expect.any(Object),
        taskDataProofHooks: expect.any(Object),
      })
    );
    expect(harness.completePermanentDeletion).toHaveBeenCalled();
    expect(harness.lifecycle.completeTeamDeletion).toHaveBeenCalledWith('fixteam');
  });

  it('abandons the timed-out preparation so its quiesce is released', async () => {
    let signal: AbortSignal | undefined;
    const harness = createHarness({
      prepareTeamDeletion: (_teamName, _deletionIdentityId, prepareOptions) => {
        signal = prepareOptions?.signal;
        return new Promise<void>(() => undefined);
      },
    });

    const deletion = harness.coordinator.permanentlyDelete('fixteam');
    const rejection = expect(deletion).rejects.toThrow(
      `Permanent deletion of "fixteam" timed out after ${PREPARE_TIMEOUT_MS}ms`
    );
    await vi.advanceTimersByTimeAsync(PREPARE_TIMEOUT_MS);
    await rejection;

    // Walking away from the wait is not enough: the preparation quiesced the
    // team before it started waiting and only releases on its own terms, so the
    // deadline has to tell it to stop. The caller still sees the timeout.
    expect(signal).toBeDefined();
    expect(signal?.aborted).toBe(true);
  });

  it('does not abandon a preparation that settled in time', async () => {
    let signal: AbortSignal | undefined;
    const harness = createHarness({
      prepareTeamDeletion: (_teamName, _deletionIdentityId, prepareOptions) => {
        signal = prepareOptions?.signal;
        return new Promise<void>((resolve) => setTimeout(resolve, PREPARE_TIMEOUT_MS - 1));
      },
    });

    const deletion = harness.coordinator.permanentlyDelete('fixteam');
    await vi.advanceTimersByTimeAsync(PREPARE_TIMEOUT_MS * 2);
    await expect(deletion).resolves.toBeUndefined();

    // The team is deliberately still quiesced here - the deletion is running.
    expect(signal?.aborted).toBe(false);
  });

  it('propagates a quiesce failure unchanged instead of reporting a timeout', async () => {
    let signal: AbortSignal | undefined;
    const harness = createHarness({
      prepareTeamDeletion: async (_teamName, _deletionIdentityId, prepareOptions) => {
        signal = prepareOptions?.signal;
        throw new Error('quiesce failed');
      },
    });

    const deletion = harness.coordinator.permanentlyDelete('fixteam');
    const rejection = expect(deletion).rejects.toThrow('quiesce failed');
    await vi.advanceTimersByTimeAsync(PREPARE_TIMEOUT_MS * 2);
    await rejection;

    expect(harness.permanentlyDeleteTeam).not.toHaveBeenCalled();
    expect(harness.completePermanentDeletion).not.toHaveBeenCalled();
    // A preparation that decided for itself keeps its own rules: it left the
    // team quiesced on purpose so the retry stays fenced behind it.
    expect(signal?.aborted).toBe(false);
  });
});

describe('TeamPermanentDeletionTransactionCoordinator team-scoped resources', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('releases team-scoped handles before the destructive rename and restores after', async () => {
    const harness = createHarness({
      prepareTeamDeletion: async () => undefined,
      withResourceHooks: true,
    });

    const deletion = harness.coordinator.permanentlyDelete('fixteam');
    await vi.advanceTimersByTimeAsync(0);
    await expect(deletion).resolves.toBeUndefined();

    const [released] = harness.releaseTeamScopedResources.mock.invocationCallOrder;
    const [deleted] = harness.permanentlyDeleteTeam.mock.invocationCallOrder;
    const [restored] = harness.restoreTeamScopedResources.mock.invocationCallOrder;
    // An open handle inside the tree is only a problem while the rename runs,
    // so the order is the whole point: release, rename, restore.
    expect(released).toBeLessThan(deleted);
    expect(deleted).toBeLessThan(restored);
  });

  it('restores the handles even when the cleanup throws', async () => {
    const harness = createHarness({
      prepareTeamDeletion: async () => undefined,
      withResourceHooks: true,
    });
    harness.permanentlyDeleteTeam.mockRejectedValueOnce(new Error('rename refused'));

    const deletion = harness.coordinator.permanentlyDelete('fixteam');
    const rejection = expect(deletion).rejects.toThrow('rename refused');
    await vi.advanceTimersByTimeAsync(0);
    await rejection;

    // The team is still on disk, so the restore has to be told the deletion did
    // not complete: resources that only make sense for a live team go back.
    expect(harness.restoreTeamScopedResources).toHaveBeenCalledWith('fixteam', {
      deletionCompleted: false,
    });
  });

  it('tells the restore that the deletion completed', async () => {
    const harness = createHarness({
      prepareTeamDeletion: async () => undefined,
      withResourceHooks: true,
    });

    const deletion = harness.coordinator.permanentlyDelete('fixteam');
    await vi.advanceTimersByTimeAsync(0);
    await expect(deletion).resolves.toBeUndefined();

    expect(harness.restoreTeamScopedResources).toHaveBeenCalledWith('fixteam', {
      deletionCompleted: true,
    });
  });

  it('reports an incomplete cleanup to the restore', async () => {
    const harness = createHarness({
      prepareTeamDeletion: async () => undefined,
      withResourceHooks: true,
    });
    // The fence rejected the target: the directory on disk is no longer the one
    // this intent was written for, so nothing was deleted.
    harness.permanentlyDeleteTeam.mockResolvedValueOnce(false);

    const deletion = harness.coordinator.permanentlyDelete('fixteam');
    await vi.advanceTimersByTimeAsync(0);
    await expect(deletion).resolves.toBeUndefined();

    expect(harness.completePermanentDeletion).not.toHaveBeenCalled();
    expect(harness.restoreTeamScopedResources).toHaveBeenCalledWith('fixteam', {
      deletionCompleted: false,
    });
  });

  it('keeps the deletion completed when a replacement already owns the team name', async () => {
    const harness = createHarness({
      prepareTeamDeletion: async () => undefined,
      withResourceHooks: true,
    });
    harness.isPermanentDeletionTargetCurrent
      // The reconcile pre-flight and the re-check after the quiesce both still
      // see the identity this intent was written for.
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      // By the time the deletion is marked complete a new team owns the name.
      .mockResolvedValue(false);

    const deletion = harness.coordinator.permanentlyDelete('fixteam');
    await vi.advanceTimersByTimeAsync(0);
    await expect(deletion).resolves.toBeUndefined();

    // The identity this intent targeted really is gone, so the restore must not
    // treat it as a rollback: consumers released for the deleted team would
    // otherwise be re-acquired against the replacement that took its name.
    expect(harness.completePermanentDeletion).toHaveBeenCalledTimes(1);
    expect(harness.restoreTeamScopedResources).toHaveBeenCalledWith('fixteam', {
      deletionCompleted: true,
    });
    // The replacement is a live team and keeps its own lifecycle.
    expect(harness.lifecycle.resumeTeam).toHaveBeenCalledWith('fixteam');
    expect(harness.lifecycle.completeTeamDeletion).not.toHaveBeenCalled();
  });

  it('still restores when the name is taken and the cleanup never completed', async () => {
    const harness = createHarness({
      prepareTeamDeletion: async () => undefined,
      withResourceHooks: true,
    });
    harness.isPermanentDeletionTargetCurrent
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValue(false);
    // The fence rejected the target, so nothing was deleted this time.
    harness.permanentlyDeleteTeam.mockResolvedValueOnce(false);

    const deletion = harness.coordinator.permanentlyDelete('fixteam');
    await vi.advanceTimersByTimeAsync(0);
    await expect(deletion).resolves.toBeUndefined();

    // Negative control for the case above: a name that is taken does not by
    // itself decide the flag. The team this intent targeted is still there, so
    // its released resources have to go back.
    expect(harness.completePermanentDeletion).not.toHaveBeenCalled();
    expect(harness.restoreTeamScopedResources).toHaveBeenCalledWith('fixteam', {
      deletionCompleted: false,
    });
    expect(harness.lifecycle.resumeTeam).toHaveBeenCalledWith('fixteam');
    expect(harness.lifecycle.completeTeamDeletion).not.toHaveBeenCalled();
  });

  it('leaves a replacement alone when it owns the name and nothing is left to detach', async () => {
    // Crash recovery: teams/<team> and tasks/<team> are already proved gone, so
    // the pre-flight identity checks are skipped and only the attachment
    // targets remain. A new team has taken the free name in the meantime.
    const intent = createRecoveredIntent(['team-data', 'task-data']);
    const harness = createHarness({
      prepareTeamDeletion: () => Promise.resolve(),
      withResourceHooks: true,
      intent,
    });
    harness.isPermanentDeletionTargetCurrent.mockResolvedValue(false);

    const deletion = harness.coordinator.permanentlyDelete('fixteam', { existingIntent: intent });
    await vi.advanceTimersByTimeAsync(0);
    await expect(deletion).resolves.toBeUndefined();

    // The handles under that name are the replacement's, and this intent has
    // nothing left to rename, so they must not be touched at all: suspending
    // its watchers and taking its log-source consumers away would be a
    // completed deletion's cleanup applied to a live team.
    expect(harness.releaseTeamScopedResources).not.toHaveBeenCalled();
    expect(harness.restoreTeamScopedResources).not.toHaveBeenCalled();
    expect(harness.lifecycle.prepareTeamDeletion).not.toHaveBeenCalled();
    // The attachment targets are still cleaned up and the replacement keeps its
    // own lifecycle.
    expect(harness.completePermanentDeletion).toHaveBeenCalledTimes(1);
    expect(harness.lifecycle.resumeTeam).toHaveBeenCalledWith('fixteam');
    expect(harness.lifecycle.completeTeamDeletion).not.toHaveBeenCalled();
  });

  it('gives a replacement its handles back when task data still needs the release', async () => {
    // Same recovery, but tasks/<team> is still pending: the rename needs the
    // watcher suspension, so the release stays enabled.
    const intent = createRecoveredIntent(['team-data']);
    const harness = createHarness({
      prepareTeamDeletion: () => Promise.resolve(),
      withResourceHooks: true,
      intent,
    });
    harness.isPermanentDeletionTargetCurrent.mockResolvedValue(false);

    const deletion = harness.coordinator.permanentlyDelete('fixteam', { existingIntent: intent });
    await vi.advanceTimersByTimeAsync(0);
    await expect(deletion).resolves.toBeUndefined();

    expect(harness.releaseTeamScopedResources).toHaveBeenCalledWith('fixteam');
    expect(harness.completePermanentDeletion).toHaveBeenCalledTimes(1);
    // The deletion completed, but what was released belongs to the team that
    // owns the name now, so it goes back the way a rollback puts it back.
    expect(harness.restoreTeamScopedResources).toHaveBeenCalledWith('fixteam', {
      deletionCompleted: false,
    });
    expect(harness.lifecycle.resumeTeam).toHaveBeenCalledWith('fixteam');
  });

  it('still reports a completed recovery when the name was never taken', async () => {
    const intent = createRecoveredIntent(['team-data']);
    const harness = createHarness({
      prepareTeamDeletion: () => Promise.resolve(),
      withResourceHooks: true,
      intent,
    });

    const deletion = harness.coordinator.permanentlyDelete('fixteam', { existingIntent: intent });
    await vi.advanceTimersByTimeAsync(0);
    await expect(deletion).resolves.toBeUndefined();

    // Negative control for the two above: on the same recovery path with the
    // name still free, the released handles were this intent's own and the
    // restore must not put them back on a team that is gone.
    expect(harness.releaseTeamScopedResources).toHaveBeenCalledWith('fixteam');
    expect(harness.restoreTeamScopedResources).toHaveBeenCalledWith('fixteam', {
      deletionCompleted: true,
    });
    expect(harness.lifecycle.completeTeamDeletion).toHaveBeenCalledWith('fixteam');
  });

  it('deletes anyway when the release throws, and then does not restore', async () => {
    const harness = createHarness({
      prepareTeamDeletion: async () => undefined,
      withResourceHooks: true,
      releaseTeamScopedResources: async () => {
        throw new Error('registry is closed');
      },
    });

    const deletion = harness.coordinator.permanentlyDelete('fixteam');
    await vi.advanceTimersByTimeAsync(0);
    await expect(deletion).resolves.toBeUndefined();

    // A failed release just leaves the rename where it was before this fix -
    // retrying against whatever holds the handle. It must not abort the
    // deletion, and there is nothing to put back.
    expect(harness.permanentlyDeleteTeam).toHaveBeenCalled();
    expect(harness.restoreTeamScopedResources).not.toHaveBeenCalled();
  });

  it('deletes without either hook when no releaser is wired in', async () => {
    const harness = createHarness({ prepareTeamDeletion: async () => undefined });

    const deletion = harness.coordinator.permanentlyDelete('fixteam');
    await vi.advanceTimersByTimeAsync(0);
    await expect(deletion).resolves.toBeUndefined();

    expect(harness.releaseTeamScopedResources).not.toHaveBeenCalled();
    expect(harness.restoreTeamScopedResources).not.toHaveBeenCalled();
    expect(harness.permanentlyDeleteTeam).toHaveBeenCalled();
  });
});
