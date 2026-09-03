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

function createHarness(options: {
  prepareTeamDeletion: () => Promise<void>;
  releaseTeamScopedResources?: () => Promise<void>;
  withResourceHooks?: boolean;
}): {
  coordinator: TeamPermanentDeletionTransactionCoordinator;
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
  const intent = createIntent();
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
      '11111111-1111-4111-8111-111111111111'
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

  it('propagates a quiesce failure unchanged instead of reporting a timeout', async () => {
    const harness = createHarness({
      prepareTeamDeletion: async () => {
        throw new Error('quiesce failed');
      },
    });

    const deletion = harness.coordinator.permanentlyDelete('fixteam');
    const rejection = expect(deletion).rejects.toThrow('quiesce failed');
    await vi.advanceTimersByTimeAsync(PREPARE_TIMEOUT_MS * 2);
    await rejection;

    expect(harness.permanentlyDeleteTeam).not.toHaveBeenCalled();
    expect(harness.completePermanentDeletion).not.toHaveBeenCalled();
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
