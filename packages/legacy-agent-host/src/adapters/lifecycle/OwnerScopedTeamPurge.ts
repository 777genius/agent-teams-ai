import { validateTeamLifecycleReceipt } from '../../team/lifecycleContracts.js';
import { listTeamCommandEntries } from '../../team/commandEntries.js';
import { TeamOwnerError } from '../../team/contracts.js';
import { digest } from '../../team/identity.js';
import { removePathWithIdentityFenceAsync } from './lifecycleIo.js';
import { permanentDeletionTargetPath } from './TeamPermanentDeletionIdentity.js';
import { PERMANENT_DELETION_TARGETS } from './TeamPermanentDeletionTypes.js';
import { createOwnerPurgeRequest } from './ownerPurgeRequest.js';
import type { TeamBinding } from '../../team/contracts.js';
import type { TeamLifecycleTransitions } from '../../team/TeamLifecycleTransitions.js';
import type { TeamOwnerStore } from '../team/TeamOwnerStore.js';
import type { TeamPermanentDeletionCoordinator } from './TeamPermanentDeletionCoordinator.js';
import type { TeamPermanentDeletionIntent } from './TeamPermanentDeletionTypes.js';
import type { LifecycleDirectories } from './lifecycleRoots.js';
import type { createImportPublication } from '../../stopped-team-import/importPublication.js';

/** Original permanent-deletion intent/proof hooks remain the sole physical transaction and recovery record. */
export function createOwnerScopedTeamPurge(options: {
  binding: TeamBinding; capturedScope: unknown; store: TeamOwnerStore; roots: LifecycleDirectories;
  lifecycle: TeamLifecycleTransitions; principalId: string; coordinator: TeamPermanentDeletionCoordinator;
  assertWriter(): void;
  authorizePurge(): void;
  /** Actual process/native/evidence/import reference owners qualify destructive release; no metadata-stopped inference. */
  assertReferencesReleased(): void;
  importPublication?: ReturnType<typeof createImportPublication>;
  onPurged(intent: TeamPermanentDeletionIntent): void;
}) {
  function admission(expectedRevision: string): void {
    options.store.fenced(() => {
      options.assertWriter(); options.authorizePurge();
      for (const row of options.store.list<{ family?: string }>('commands')) {
        if (row.family === 'lifecycle' && validateTeamLifecycleReceipt(row).phase !== 'completed') throw new TeamOwnerError('hold');
      }
      if (listTeamCommandEntries(options.store).some(row => row.phase !== 'completed' && row.phase !== 'rejected')) throw new TeamOwnerError('hold');
      const state = options.lifecycle.view(options.principalId);
      if (state.revision !== expectedRevision) throw new TeamOwnerError('conflict');
      if (!state.deleted || state.cleanupPending) throw new TeamOwnerError('hold');
      options.assertReferencesReleased();
    });
  }
  return {
    async purge(commandId: string, expectedRevision: string): Promise<{ transactionId: string; deleted: true }> {
      options.assertWriter();
      const request = createOwnerPurgeRequest(options.binding, options.principalId, commandId, expectedRevision, options.capturedScope);
      const original = await options.coordinator.lookupOwnerPermanentDeletion(request);
      options.assertWriter();
      if (original?.phase === 'deleted') return { transactionId: original.transactionId, deleted: true };
      if (original?.phase === 'deleting') return continueOriginal(original);
      admission(expectedRevision);
      let intent = await options.coordinator.beginPermanentDeletion(options.binding.teamName, { ownerRequest: request });
      if (intent.identityId !== options.binding.teamId || intent.identityKind !== 'team') throw new TeamOwnerError('hold');
      admission(expectedRevision);
      options.importPublication?.assertRemovalCovered(intent);
      // Re-enter actual actor/CAS/release qualification inside the original atomic destructive boundary.
      intent = await options.coordinator.commitPermanentDeletionBoundary(intent, () => admission(expectedRevision));
      return continueOriginal(intent);
    },
    async lookup(commandId: string, expectedRevision: string) {
      options.assertWriter();
      const intent = await options.coordinator.lookupOwnerPermanentDeletion(createOwnerPurgeRequest(options.binding, options.principalId, commandId, expectedRevision, options.capturedScope));
      options.assertWriter();
      return intent ? { transactionId: intent.transactionId, phase: intent.phase } : null;
    },
    /** Trusted cold continuation of the same original destructive intent after namespace loss. */
    continueOriginal,
  };
  function continueOriginal(intent: TeamPermanentDeletionIntent) { return continueOwnerScopedTeamPurge(options, intent); }
}

/** Cold continuation consumes only the already crossed original boundary and captured physical target proofs. */
export async function continueOwnerScopedTeamPurge(options: {
  binding: TeamBinding; roots: LifecycleDirectories; principalId: string; coordinator: TeamPermanentDeletionCoordinator;
  assertWriter(): void; onPurged(intent: TeamPermanentDeletionIntent): void;
}, intent: TeamPermanentDeletionIntent): Promise<{ transactionId: string; deleted: true }> {
    options.assertWriter();
    if (intent.teamName !== options.binding.teamName || intent.identityId !== options.binding.teamId || intent.identityKind !== 'team' ||
      !intent.ownerRequest || intent.ownerRequest.principalId !== options.principalId || digest(intent.ownerRequest.binding) !== digest(options.binding) ||
      (intent.phase !== 'deleting' && intent.phase !== 'deleted')) throw new TeamOwnerError('hold');
    const removed = await options.coordinator.withPermanentDeletionTargetFence(intent, async (current, proof, completed) => {
        for (const target of PERMANENT_DELETION_TARGETS) {
          options.assertWriter();
          if (completed(target)) continue;
          const result = await removePathWithIdentityFenceAsync(permanentDeletionTargetPath(options.roots, intent.teamName, target), {
            recursive: true, force: true, maxRetries: 5, retryDelay: 50, durability: 'strict', reservePublicDirectory: true,
            validateDetached: path => { options.assertWriter(); return current(target, path); }, proofHooks: proof(target),
          });
          if (result !== 'deleted') return false;
        }
        return true;
      });
      if (!removed) throw new TeamOwnerError('hold');
      options.assertWriter();
      await options.coordinator.completePermanentDeletion(intent);
      options.onPurged(intent);
      return { transactionId: intent.transactionId, deleted: true };
}
